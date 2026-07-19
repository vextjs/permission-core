import type {
    ManagementConflict,
    PermissionRuleInput,
    PolicyValue,
    SourceRewriteDecision,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { canonicalString, compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import {
    assertInternalDocumentBudget,
    assertRoleMenuGrantBudget,
    type InternalRoleDocument,
    type InternalRoleMenuGrantDocument,
    type InternalRoleRuleDocument,
    type InternalRoleRuleSource,
} from "../persistence/documents";
import { createMenuSourceId, MAX_RULE_SOURCES } from "../rbac/materialize";
import type { RbacScopeReader } from "../rbac/store";
import { MAX_RULES_PER_ROLE } from "../rbac/store";
import {
    createRoleMenuAggregateFields,
    createRoleMenuGrantSnapshot,
    MAX_SOURCE_REWRITE_OPERATIONS,
    validateRoleMenuIntegrity,
    type MenuSource,
    type PreparedSourceImpact,
} from "./source-rewrite";
import type { MenuScopeReader } from "./store";

type RuleDefinition = Pick<InternalRoleRuleDocument, "effect" | "action" | "resource"> & {
    readonly where?: InternalRoleRuleDocument["where"];
};

export interface SourceRewriteDocumentMutation<T> {
    readonly before: Readonly<T> | null;
    readonly after: Readonly<T> | null;
}

export interface SourceRewriteRolePlan {
    readonly beforeRole: Readonly<InternalRoleDocument>;
    readonly afterRole: Readonly<InternalRoleDocument>;
    readonly rules: readonly SourceRewriteDocumentMutation<InternalRoleRuleDocument>[];
    readonly grants: readonly SourceRewriteDocumentMutation<InternalRoleMenuGrantDocument>[];
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly afterRules: readonly Readonly<InternalRoleRuleDocument>[];
}

export interface PreparedSourceRewriteExecution {
    readonly roles: readonly SourceRewriteRolePlan[];
    readonly beforeRulesByRole: ReadonlyMap<string, readonly Readonly<InternalRoleRuleDocument>[]>;
    readonly afterRulesByRole: ReadonlyMap<string, readonly Readonly<InternalRoleRuleDocument>[]>;
    readonly sourceMutationCount: number;
    readonly conflicts: readonly ManagementConflict[];
    readonly auditPlan: PolicyValue;
}

interface RewriteContext {
    readonly decision: SourceRewriteDecision & { readonly mode: "apply" };
    readonly impactBySourceId: ReadonlyMap<string, PreparedSourceImpact>;
    readonly affectedGrantIds: ReadonlySet<string>;
    readonly nextGrantRevision: ReadonlyMap<string, number>;
    readonly definitions: Map<string, RuleDefinition>;
    readonly seenImpacts: Set<string>;
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu source state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function policyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function ruleDefinition(rule: Readonly<InternalRoleRuleDocument>): RuleDefinition {
    return {
        effect: rule.effect,
        action: rule.action,
        resource: rule.resource,
        ...(rule.where === undefined ? {} : { where: rule.where }),
    };
}

function sourceWithRevision(
    source: Readonly<MenuSource>,
    semanticKey: string,
    grantRevision: number,
    replacement?: Readonly<PermissionRuleInput>,
): MenuSource {
    const identity = {
        grantId: source.grantId,
        semanticKey,
        contribution: source.contribution,
        assetId: source.assetId,
        ...(source.contribution === "api" ? { apiBindingId: source.apiBindingId } : {}),
        ...(source.contribution === "data" ? { dataResource: replacement?.resource ?? source.dataResource } : {}),
    };
    return deepFreeze({
        ...source,
        sourceId: createMenuSourceId(identity),
        grantRevision,
        ...(source.contribution === "data" && replacement !== undefined
            ? { dataResource: replacement.resource }
            : {}),
    }) as MenuSource;
}

function rewriteSource(
    rule: Readonly<InternalRoleRuleDocument>,
    source: Readonly<InternalRoleRuleSource>,
    context: RewriteContext,
): { readonly semanticKey: string; readonly source: InternalRoleRuleSource } | null {
    if (source.kind !== "menu" || !context.affectedGrantIds.has(source.grantId)) {
        return { semanticKey: rule.semanticKey, source };
    }
    const impact = context.impactBySourceId.get(source.sourceId);
    let semanticKey = rule.semanticKey;
    let replacement: Readonly<PermissionRuleInput> | undefined;
    if (impact !== undefined) {
        context.seenImpacts.add(source.sourceId);
        const resolution = context.decision.resolutions[source.sourceId];
        if (resolution === undefined) persistedInvalid(`source rewrite decision omitted ${source.sourceId}`);
        if (resolution.action === "revoke") return null;
        replacement = impact.candidates.get(resolution.replacementSemanticKey);
        if (replacement === undefined) persistedInvalid(`source rewrite candidate for ${source.sourceId} changed after validation`);
        semanticKey = resolution.replacementSemanticKey;
        const candidateDefinition: RuleDefinition = { effect: rule.effect, ...replacement };
        const currentDefinition = context.definitions.get(semanticKey);
        if (currentDefinition !== undefined && canonicalString(currentDefinition) !== canonicalString(candidateDefinition)) {
            persistedInvalid(`semantic rule ${semanticKey} has conflicting definitions`);
        }
        context.definitions.set(semanticKey, candidateDefinition);
    }
    return {
        semanticKey,
        source: sourceWithRevision(source, semanticKey, context.nextGrantRevision.get(source.grantId)!, replacement),
    };
}

function addRewrittenSource(
    groups: Map<string, InternalRoleRuleSource[]>,
    rewritten: { readonly semanticKey: string; readonly source: InternalRoleRuleSource },
    conflicts: ManagementConflict[],
) {
    const group = groups.get(rewritten.semanticKey) ?? [];
    if (group.some((candidate) => candidate.sourceId === rewritten.source.sourceId)) {
        conflicts.push({
            id: rewritten.source.sourceId,
            code: "SOURCE_REWRITE_COLLISION",
            message: "The selected source replacement collides with an existing source identity.",
        });
        return;
    }
    group.push(rewritten.source);
    groups.set(rewritten.semanticKey, group);
}

function rewriteSourceInventory(input: {
    readonly roleId: string;
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly roleImpacts: readonly PreparedSourceImpact[];
    readonly affectedGrantIds: ReadonlySet<string>;
    readonly nextGrantRevision: ReadonlyMap<string, number>;
    readonly decision: SourceRewriteDecision & { readonly mode: "apply" };
    readonly conflicts: ManagementConflict[];
}) {
    const impactBySourceId = new Map(input.roleImpacts.map((impact) => [impact.record.source.sourceId, impact] as const));
    if (impactBySourceId.size !== input.roleImpacts.length) persistedInvalid(`role ${input.roleId} source rewrite impacts are not unique`);
    const context: RewriteContext = {
        decision: input.decision,
        impactBySourceId,
        affectedGrantIds: input.affectedGrantIds,
        nextGrantRevision: input.nextGrantRevision,
        definitions: new Map(input.beforeRules.map((rule) => [rule.semanticKey, ruleDefinition(rule)] as const)),
        seenImpacts: new Set(),
    };
    const sourcesBySemanticKey = new Map<string, InternalRoleRuleSource[]>();
    let sourceMutationCount = 0;
    for (const rule of input.beforeRules) for (const source of rule.sources) {
        if (source.kind === "menu" && input.affectedGrantIds.has(source.grantId)) sourceMutationCount += 1;
        const rewritten = rewriteSource(rule, source, context);
        if (rewritten !== null) addRewrittenSource(sourcesBySemanticKey, rewritten, input.conflicts);
    }
    if (context.seenImpacts.size !== input.roleImpacts.length) persistedInvalid(`role ${input.roleId} source rewrite impact no longer exists`);
    return { definitions: context.definitions, sourcesBySemanticKey, sourceMutationCount };
}

function materializeRule(input: {
    readonly role: Readonly<InternalRoleDocument>;
    readonly semanticKey: string;
    readonly sources: readonly InternalRoleRuleSource[];
    readonly before?: Readonly<InternalRoleRuleDocument>;
    readonly definition?: RuleDefinition;
    readonly now: number;
}) {
    if (input.before !== undefined && canonicalString(input.before.sources) === canonicalString(input.sources)) {
        return input.before;
    }
    if (input.definition === undefined) persistedInvalid(`source rewrite lacks rule definition ${input.semanticKey}`);
    const after: InternalRoleRuleDocument = input.before === undefined
        ? {
            scopeKey: input.role.scopeKey,
            scope: input.role.scope,
            roleId: input.role.roleId,
            ...input.definition,
            semanticKey: input.semanticKey,
            sources: Object.freeze([...input.sources]),
            revision: 1,
            createdAt: input.now,
            updatedAt: input.now,
        }
        : {
            ...input.before,
            sources: Object.freeze([...input.sources]),
            revision: input.before.revision + 1,
            updatedAt: input.now,
        };
    assertInternalDocumentBudget(after);
    return deepFreeze(after);
}

function materializeAfterRules(input: {
    readonly role: Readonly<InternalRoleDocument>;
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly definitions: ReadonlyMap<string, RuleDefinition>;
    readonly sourcesBySemanticKey: ReadonlyMap<string, readonly InternalRoleRuleSource[]>;
    readonly conflicts: ManagementConflict[];
    readonly now: number;
}) {
    const beforeByKey = new Map(input.beforeRules.map((rule) => [rule.semanticKey, rule] as const));
    const afterRules = [...input.sourcesBySemanticKey.keys()].sort(compareUtf8).map((semanticKey) => {
        const sources = [...input.sourcesBySemanticKey.get(semanticKey)!]
            .sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
        if (sources.length > MAX_RULE_SOURCES) input.conflicts.push({
            id: `${input.role.roleId}:${semanticKey}`,
            code: "LIMIT_EXCEEDED",
            message: `The rewritten semantic rule would exceed ${MAX_RULE_SOURCES} sources.`,
        });
        return materializeRule({
            role: input.role, semanticKey, sources, before: beforeByKey.get(semanticKey),
            definition: input.definitions.get(semanticKey), now: input.now,
        });
    });
    if (afterRules.length > MAX_RULES_PER_ROLE) input.conflicts.push({
        id: input.role.roleId,
        code: "LIMIT_EXCEEDED",
        message: `The rewritten role would exceed ${MAX_RULES_PER_ROLE} semantic rules.`,
    });
    return Object.freeze(afterRules);
}

function materializeAfterGrants(input: {
    readonly beforeGrants: readonly Readonly<InternalRoleMenuGrantDocument>[];
    readonly afterRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly affectedGrantIds: ReadonlySet<string>;
    readonly now: number;
}) {
    const contributions = new Map<string, { rule: Readonly<InternalRoleRuleDocument>; source: Readonly<MenuSource> }[]>();
    for (const rule of input.afterRules) for (const source of rule.sources) if (source.kind === "menu") {
        const group = contributions.get(source.grantId) ?? [];
        group.push({ rule, source });
        contributions.set(source.grantId, group);
    }
    const afterGrants: Readonly<InternalRoleMenuGrantDocument>[] = [];
    const mutations: SourceRewriteDocumentMutation<InternalRoleMenuGrantDocument>[] = [];
    for (const grant of input.beforeGrants) {
        if (!input.affectedGrantIds.has(grant.grantId)) {
            afterGrants.push(grant);
            continue;
        }
        const grantContributions = contributions.get(grant.grantId) ?? [];
        if (grantContributions.length === 0) {
            mutations.push({ before: grant, after: null });
            continue;
        }
        const after = deepFreeze({
            ...grant,
            snapshot: createRoleMenuGrantSnapshot(grant.intent, grantContributions),
            grantRevision: grant.grantRevision + 1,
            updatedAt: input.now,
        });
        assertRoleMenuGrantBudget(after);
        assertInternalDocumentBudget(after);
        afterGrants.push(after);
        mutations.push({ before: grant, after });
    }
    afterGrants.sort((left, right) => compareUtf8(left.grantId, right.grantId));
    return { afterGrants: Object.freeze(afterGrants), mutations: Object.freeze(mutations) };
}

function createRuleMutations(
    beforeRules: readonly Readonly<InternalRoleRuleDocument>[],
    afterRules: readonly Readonly<InternalRoleRuleDocument>[],
) {
    const beforeByKey = new Map(beforeRules.map((rule) => [rule.semanticKey, rule] as const));
    const afterByKey = new Map(afterRules.map((rule) => [rule.semanticKey, rule] as const));
    return Object.freeze([...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort(compareUtf8)
        .flatMap((semanticKey) => {
            const before = beforeByKey.get(semanticKey) ?? null;
            const after = afterByKey.get(semanticKey) ?? null;
            return canonicalString(before) === canonicalString(after) ? [] : [{ before, after }];
        }));
}

async function prepareRolePlan(input: {
    readonly roleId: string;
    readonly role: Readonly<InternalRoleDocument>;
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly roleImpacts: readonly PreparedSourceImpact[];
    readonly menuReader: MenuScopeReader;
    readonly decision: SourceRewriteDecision & { readonly mode: "apply" };
    readonly conflicts: ManagementConflict[];
    readonly now: number;
}) {
    const beforeGrants = await input.menuReader.readGrantsForRole(input.roleId);
    validateRoleMenuIntegrity(input.role, input.beforeRules, beforeGrants);
    const affectedGrantIds = new Set(input.roleImpacts.map((impact) => impact.record.source.grantId));
    const grantById = new Map(beforeGrants.map((grant) => [grant.grantId, grant] as const));
    const nextGrantRevision = new Map<string, number>();
    for (const grantId of affectedGrantIds) {
        const grant = grantById.get(grantId);
        if (grant === undefined) persistedInvalid(`source rewrite references missing grant ${grantId}`);
        nextGrantRevision.set(grantId, grant.grantRevision + 1);
    }
    const rewritten = rewriteSourceInventory({ ...input, affectedGrantIds, nextGrantRevision });
    const afterRules = materializeAfterRules({ ...input, ...rewritten });
    const grants = materializeAfterGrants({ beforeGrants, afterRules, affectedGrantIds, now: input.now });
    const afterRole = deepFreeze({
        ...input.role,
        ...createRoleMenuAggregateFields(grants.afterGrants, afterRules),
        revision: input.role.revision + 1,
        updatedAt: input.now,
    });
    assertInternalDocumentBudget(afterRole);
    const plan: SourceRewriteRolePlan = {
        beforeRole: input.role,
        afterRole,
        rules: createRuleMutations(input.beforeRules, afterRules),
        grants: grants.mutations,
        beforeRules: input.beforeRules,
        afterRules,
    };
    return { plan: Object.freeze(plan), sourceMutationCount: rewritten.sourceMutationCount };
}

function roleAuditProjection(role: Readonly<InternalRoleDocument>) {
    return {
        roleId: role.roleId, revision: role.revision,
        menuGrantCount: role.menuGrantCount, menuGrantDigest: role.menuGrantDigest,
        menuSourceCount: role.menuSourceCount, menuSourceDigest: role.menuSourceDigest,
    };
}

function ruleAuditProjection(rule: Readonly<InternalRoleRuleDocument> | null) {
    return rule === null ? null : {
        roleId: rule.roleId, effect: rule.effect, action: rule.action, resource: rule.resource,
        ...(rule.where === undefined ? {} : { where: rule.where }),
        semanticKey: rule.semanticKey, sources: rule.sources, revision: rule.revision,
    };
}

function grantAuditProjection(grant: Readonly<InternalRoleMenuGrantDocument> | null) {
    return grant === null ? null : {
        roleId: grant.roleId, grantId: grant.grantId, effect: grant.effect,
        intent: grant.intent, snapshot: grant.snapshot, grantRevision: grant.grantRevision,
    };
}

function createAuditPlan(sourceMutationCount: number, rolePlans: readonly SourceRewriteRolePlan[]) {
    return policyValue({
        sourceMutationCount,
        roles: rolePlans.map((plan) => ({
            before: roleAuditProjection(plan.beforeRole),
            after: roleAuditProjection(plan.afterRole),
            rules: plan.rules.map((mutation) => ({
                before: ruleAuditProjection(mutation.before), after: ruleAuditProjection(mutation.after),
            })),
            grants: plan.grants.map((mutation) => ({
                before: grantAuditProjection(mutation.before), after: grantAuditProjection(mutation.after),
            })),
        })),
    });
}

export async function prepareSourceRewriteExecution(input: {
    readonly rbacReader: RbacScopeReader;
    readonly menuReader: MenuScopeReader;
    readonly impacts: readonly PreparedSourceImpact[];
    readonly decision: SourceRewriteDecision;
    readonly now: number;
}): Promise<PreparedSourceRewriteExecution> {
    if (input.decision.mode !== "apply") throw new TypeError("A source rewrite execution plan requires an apply decision.");
    if (input.impacts.length === 0) return Object.freeze({
        roles: Object.freeze([]), beforeRulesByRole: new Map(), afterRulesByRole: new Map(),
        sourceMutationCount: 0, conflicts: Object.freeze([]),
        auditPlan: policyValue({ sourceMutationCount: 0, roles: [] }),
    });
    const roleIds = [...new Set(input.impacts.map((impact) => impact.record.rule.roleId))].sort(compareUtf8);
    const rolesById = await input.rbacReader.readRoles(roleIds);
    const loadedRules = await input.rbacReader.readRulesForRoles(roleIds);
    const rulesByRole = new Map(roleIds.map((roleId) => [roleId, [] as Readonly<InternalRoleRuleDocument>[]]));
    for (const rule of loadedRules) rulesByRole.get(rule.roleId)?.push(rule);
    const impactsByRole = new Map(roleIds.map((roleId) => [roleId, [] as PreparedSourceImpact[]]));
    for (const impact of input.impacts) impactsByRole.get(impact.record.rule.roleId)?.push(impact);
    const rolePlans: SourceRewriteRolePlan[] = [];
    const beforeRulesByRole = new Map<string, readonly Readonly<InternalRoleRuleDocument>[]>();
    const afterRulesByRole = new Map<string, readonly Readonly<InternalRoleRuleDocument>[]>();
    const conflicts: ManagementConflict[] = [];
    let sourceMutationCount = 0;
    for (const roleId of roleIds) {
        const role = rolesById.get(roleId);
        if (role === undefined) persistedInvalid(`menu source rewrite references missing role ${roleId}`);
        const beforeRules = Object.freeze([...(rulesByRole.get(roleId) ?? [])]
            .sort((left, right) => compareUtf8(left.semanticKey, right.semanticKey)));
        const prepared = await prepareRolePlan({
            roleId, role, beforeRules, roleImpacts: impactsByRole.get(roleId) ?? [],
            menuReader: input.menuReader, decision: input.decision, conflicts, now: input.now,
        });
        rolePlans.push(prepared.plan);
        beforeRulesByRole.set(roleId, beforeRules);
        afterRulesByRole.set(roleId, prepared.plan.afterRules);
        sourceMutationCount += prepared.sourceMutationCount;
    }
    if (sourceMutationCount > MAX_SOURCE_REWRITE_OPERATIONS) conflicts.push({
        id: "source-rewrite-synchronized-capacity",
        code: "LIMIT_EXCEEDED",
        message: `Grant synchronization requires ${sourceMutationCount} source mutations; the atomic limit is ${MAX_SOURCE_REWRITE_OPERATIONS}.`,
    });
    return Object.freeze({
        roles: Object.freeze(rolePlans), beforeRulesByRole, afterRulesByRole, sourceMutationCount,
        conflicts: Object.freeze(conflicts), auditPlan: createAuditPlan(sourceMutationCount, rolePlans),
    });
}
