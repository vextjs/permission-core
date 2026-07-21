import type { MongoSession } from "monsqlize";
import type {
    AuthorizationCapacityAssessment,
    ApiResource,
    BatchMutationSummary,
    BoundedDetails,
    CountSample,
    ImpactPreview,
    ManagementConflict,
    MenuBusinessPermissionAssignment,
    MenuBusinessPermissionChange,
    MenuBusinessPermissionGrantResult,
    MenuBusinessPermissionPlan,
    MenuBusinessPermissionSelection,
    MenuBusinessResponseFieldRef,
    MenuPermissionChange,
    MenuPermissionGrantResult,
    MenuPermissionPlan,
    MenuPermissionSelection,
    MenuRuleContribution,
    MutationResult,
    PermissionScope,
    PolicyValue,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionVectorOptions,
} from "../types";
import type { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { SignedTokenCodec } from "../internal/signed-token";
import {
    assertInternalDocumentBudget,
    assertRoleMenuGrantBudget,
    type InternalApiBindingDocument,
    type InternalMenuNodeDocument,
    type InternalRoleDocument,
    type InternalRoleMenuGrantDocument,
    type InternalRoleRuleDocument,
    type InternalRoleRuleSource,
} from "../persistence/documents";
import type { PermissionRepository } from "../persistence/repository";
import {
    assessAuthorizationCapacity,
    loadAffectedRoleIds,
    loadAffectedUsers,
    type AffectedUsers,
} from "../rbac/capacity";
import type { CacheInvalidator } from "../rbac/mutation-executor";
import { ManagementMutationExecutor } from "../rbac/mutation-executor";
import {
    normalizeMenuPreviewExecutionOptions,
    normalizePreviewOptions,
} from "../rbac/preview-inputs";
import { createMenuSourceId, createSemanticKey, MAX_ROLE_MENU_AGGREGATE_COUNT, MAX_RULE_SOURCES } from "../rbac/materialize";
import { DetailBudgetAllocator, RESPONSE_DETAIL_LIMIT } from "../rbac/result";
import { MAX_RULES_PER_ROLE, RbacScopeReader } from "../rbac/store";
import { normalizeRbacId } from "../rbac/validation";
import { boundedDetails } from "../rbac/views";
import { authorizationCacheTargets, sampledCountSample } from "./impact-support";
import { compileMenuConfigSnapshot, type CompiledMenuConfig } from "./config-compiler";
import { readScopedMenuConfigDocuments } from "./config-service";
import {
    buildMenuPreview,
    emptyBatchCounts,
    expectedMenuRevisions,
    menuPlanHash,
    sortBatchMutationSamples,
    validateMenuExecution,
    type PreparedMenuPlan,
} from "./mutations";
import {
    applySourceRewriteExecution,
    createRoleMenuAggregateFields,
    createRoleMenuGrantSnapshotFromContributions,
    validateRoleMenuIntegrity,
} from "./source-rewrite";
import type {
    PreparedSourceRewriteExecution,
    SourceRewriteDocumentMutation,
    SourceRewriteRolePlan,
} from "./source-rewrite-plan";
import {
    menuChoiceDecisionDetailCount,
    planRoleMenuSelection,
    type PlannedRoleMenuGrant,
} from "./role-menu-selection";
import { MenuScopeReader } from "./store";
import {
    normalizeMenuPermissionChange,
    normalizeMenuPermissionSelection,
    normalizeMenuBusinessPermissionChange,
} from "./validation";
import { decodeBatchMutationSummaryReplay } from "./views";

const ROLE_MENU_PREVIEW_METHOD = "roles.menuPermissions.preview";
const MAX_ROLE_MENU_SOURCE_MUTATIONS = 1_000;

type MenuSource = Extract<InternalRoleRuleSource, { kind: "menu" }>;

interface PreparedRoleMenuMutation extends PreparedMenuPlan<MenuPermissionPlan> {
    readonly role: Readonly<InternalRoleDocument>;
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly afterRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly beforeGrants: readonly Readonly<InternalRoleMenuGrantDocument>[];
    readonly afterGrants: readonly Readonly<InternalRoleMenuGrantDocument>[];
    readonly writePlan: PreparedSourceRewriteExecution;
    readonly changed: boolean;
    readonly affectedUsers: AffectedUsers;
    readonly grantResult: MenuPermissionGrantResult;
    readonly batchResult: BatchMutationSummary;
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function mutableRole(role: Readonly<InternalRoleDocument>) {
    if (role.status === "deprecated") {
        throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated roles cannot change menu permissions.", {
            details: { kind: "validation", field: "roleId", reason: "role is deprecated" },
        });
    }
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted role menu permissions are inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function menuConflict(id: string, code: string, message: string): ManagementConflict {
    return deepFreeze({ id, code, message });
}

function ruleDefinition(rule: Readonly<InternalRoleRuleDocument>) {
    return {
        effect: rule.effect,
        action: rule.action,
        resource: rule.resource,
        ...(rule.where === undefined ? {} : { where: rule.where }),
    };
}

function contributionDefinition(contribution: Readonly<MenuRuleContribution>) {
    return {
        effect: contribution.effect,
        action: contribution.action,
        resource: contribution.resource,
        ...(contribution.where === undefined ? {} : { where: contribution.where }),
    };
}

function sourceFromContribution(
    contribution: Readonly<MenuRuleContribution>,
    grantRevision: number,
): MenuSource {
    const common = {
        sourceId: contribution.sourceId,
        kind: "menu" as const,
        grantId: contribution.grantId,
        grantRevision,
        effect: contribution.effect,
        contribution: contribution.contribution,
        assetId: contribution.assetId,
    };
    if (contribution.contribution === "api") {
        return deepFreeze({ ...common, contribution: "api" as const, apiBindingId: contribution.apiBindingId! });
    }
    if (contribution.contribution === "data") {
        return deepFreeze({ ...common, contribution: "data" as const, dataResource: contribution.dataResource! });
    }
    return deepFreeze({ ...common, contribution: "node" as const });
}

function sourceMap(rules: readonly Readonly<InternalRoleRuleDocument>[]) {
    const result = new Map<string, Readonly<InternalRoleRuleSource>>();
    for (const rule of rules) {
        for (const source of rule.sources) {
            if (result.has(source.sourceId)) persistedInvalid(`duplicate role source ${source.sourceId}`);
            result.set(source.sourceId, source);
        }
    }
    return result;
}

function sourceDelta(
    beforeRules: readonly Readonly<InternalRoleRuleDocument>[],
    afterRules: readonly Readonly<InternalRoleRuleDocument>[],
) {
    const before = sourceMap(beforeRules);
    const after = sourceMap(afterRules);
    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    for (const [sourceId, source] of after) {
        const current = before.get(sourceId);
        if (current === undefined) inserted += 1;
        else if (canonicalString(current) !== canonicalString(source)) updated += 1;
    }
    for (const sourceId of before.keys()) if (!after.has(sourceId)) deleted += 1;
    return { inserted, updated, deleted, total: inserted + updated + deleted };
}

function documentMutations<T extends object>(
    beforeValues: readonly Readonly<T>[],
    afterValues: readonly Readonly<T>[],
    identity: (value: Readonly<T>) => string,
) {
    const before = new Map(beforeValues.map((value) => [identity(value), value] as const));
    const after = new Map(afterValues.map((value) => [identity(value), value] as const));
    const mutations: SourceRewriteDocumentMutation<T>[] = [];
    for (const id of [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8)) {
        const current = before.get(id) ?? null;
        const next = after.get(id) ?? null;
        if (canonicalString(current) !== canonicalString(next)) mutations.push({ before: current, after: next });
    }
    return Object.freeze(mutations);
}

function boundedWithBudget<T>(items: readonly T[], budget: DetailBudgetAllocator) {
    const selected = budget.sample(items, items.length);
    return deepFreeze({
        total: items.length,
        items: selected,
        truncated: selected.length < items.length,
        digest: digestCanonical(items),
    });
}

function publicChoiceRequirement(
    value: MenuPermissionPlan["choiceRequirements"]["items"][number],
    budget: DetailBudgetAllocator,
): MenuPermissionPlan["choiceRequirements"]["items"][number] {
    if (value.kind === "availability-any") {
        const selectedCandidates = budget.sample(value.candidates.items, value.candidates.total);
        return deepFreeze({
            ...value,
            candidates: deepFreeze({
                ...value.candidates,
                items: selectedCandidates,
                truncated: selectedCandidates.length < value.candidates.total,
            }),
        });
    }
    const selectedCandidates = budget.sample(value.candidates.items, value.candidates.total);
    return deepFreeze({
        ...value,
        candidates: deepFreeze({
            ...value.candidates,
            items: selectedCandidates,
            truncated: selectedCandidates.length < value.candidates.total,
        }),
    });
}

export function publicRoleMenuRemovals(
    values: readonly { grantId: string; sourceIds: readonly string[] }[],
    budget: DetailBudgetAllocator,
): MenuPermissionPlan["removals"] {
    const complete = values.map((value) => deepFreeze({
        grantId: value.grantId,
        sourceIds: boundedDetails(value.sourceIds, value.sourceIds.length),
    }));
    const selected = budget.sample(complete, complete.length);
    const items = selected.map((value) => deepFreeze({
        grantId: value.grantId,
        sourceIds: budget.bounded(value.sourceIds.items),
    }));
    return deepFreeze({
        total: complete.length,
        items,
        truncated: selected.length < complete.length,
        digest: digestCanonical(complete),
    });
}

export function menuPermissionGrantResult(input: {
    readonly roleId: string;
    readonly grantIds: readonly string[];
    readonly refreshedGrantIds: readonly string[];
    readonly generatedSources: number;
    readonly removedSources: number;
    readonly generatedSemanticRules: number;
}): MenuPermissionGrantResult {
    const budget = new DetailBudgetAllocator();
    return deepFreeze({
        roleId: input.roleId,
        grantIds: budget.bounded(input.grantIds),
        refreshedGrantIds: budget.bounded(input.refreshedGrantIds),
        generatedSources: input.generatedSources,
        removedSources: input.removedSources,
        generatedSemanticRules: input.generatedSemanticRules,
    });
}

function publicGrant(
    value: PlannedRoleMenuGrant,
    budget: DetailBudgetAllocator,
): MenuPermissionPlan["grants"]["items"][number] {
    return deepFreeze({
        grantId: value.grantId,
        effect: value.effect,
        intent: value.intent,
        snapshot: {
            contributionContractDigest: value.snapshot.contributionContractDigest,
            contributionDigest: value.snapshot.contributionDigest,
            contributingAssetCount: value.snapshot.contributingAssetCount,
            contributingBindingCount: value.snapshot.contributingBindingCount,
            contributingAssetIds: boundedWithBudget(value.snapshot.contributingAssetIds, budget),
            contributingBindingIds: boundedWithBudget(value.snapshot.contributingBindingIds, budget),
        },
        contributions: boundedWithBudget(value.contributions, budget),
    });
}

function decodeBoundedIds(value: unknown, field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) persistedInvalid(`${field} must be an object`);
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.items) || !Number.isSafeInteger(record.total) || typeof record.digest !== "string" || typeof record.truncated !== "boolean") {
        persistedInvalid(`${field} is malformed`);
    }
    if (!record.items.every((item) => typeof item === "string")) persistedInvalid(`${field}.items must contain IDs`);
    return deepFreeze({
        total: record.total as number,
        items: Object.freeze([...(record.items as string[])]),
        truncated: record.truncated as boolean,
        digest: record.digest as string,
    });
}

function decodeMenuPermissionGrantResult(value: unknown): MenuPermissionGrantResult {
    if (value === null || typeof value !== "object" || Array.isArray(value)) persistedInvalid("menu grant replay must be an object");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    const expected = ["generatedSemanticRules", "generatedSources", "grantIds", "refreshedGrantIds", "removedSources", "roleId"].sort(compareUtf8);
    if (canonicalString(keys) !== canonicalString(expected) || typeof record.roleId !== "string") persistedInvalid("menu grant replay shape is invalid");
    for (const field of ["generatedSources", "removedSources", "generatedSemanticRules"] as const) {
        if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0) persistedInvalid(`menu grant replay ${field} is invalid`);
    }
    return deepFreeze({
        roleId: record.roleId,
        grantIds: decodeBoundedIds(record.grantIds, "grantIds"),
        refreshedGrantIds: decodeBoundedIds(record.refreshedGrantIds, "refreshedGrantIds"),
        generatedSources: record.generatedSources as number,
        removedSources: record.removedSources as number,
        generatedSemanticRules: record.generatedSemanticRules as number,
    });
}

function accessHint(
    beforeRules: readonly Readonly<InternalRoleRuleDocument>[],
    afterRules: readonly Readonly<InternalRoleRuleDocument>[],
): AuthorizationCapacityAssessment["accessDirection"] {
    const before = sourceMap(beforeRules);
    const after = sourceMap(afterRules);
    let expands = false;
    let restricts = false;
    for (const [sourceId, source] of after) {
        if (before.has(sourceId) || source.kind !== "menu") continue;
        if (source.effect === "allow") expands = true;
        else restricts = true;
    }
    for (const [sourceId, source] of before) {
        if (after.has(sourceId) || source.kind !== "menu") continue;
        if (source.effect === "allow") restricts = true;
        else expands = true;
    }
    return expands && restricts ? "mixed" : expands ? "expand" : restricts ? "restrict" : "none";
}

export function operationGrantPlans(
    stateScopeKey: string,
    roleId: string,
    change: MenuPermissionChange,
    nodes: readonly Parameters<typeof planRoleMenuSelection>[0]["nodes"][number][],
    bindings: readonly Parameters<typeof planRoleMenuSelection>[0]["bindings"][number][],
) {
    if (change.operation === "revoke") return { grants: [] as PlannedRoleMenuGrant[], choices: [], conflicts: [] as ManagementConflict[] };
    const assignments = change.operation === "set"
        ? change.assignments
        : [{ effect: change.operation === "grant" ? "allow" as const : "deny" as const, selection: change.selection }];
    const grants = new Map<string, PlannedRoleMenuGrant>();
    const choices: MenuPermissionPlan["choiceRequirements"]["items"][number][] = [];
    const conflicts: ManagementConflict[] = [];
    for (const assignment of assignments) {
        const planned = planRoleMenuSelection({
            scopeHash: stateScopeKey,
            roleId,
            effect: assignment.effect,
            selection: assignment.selection,
            nodes,
            bindings,
        });
        for (const grant of planned.grants) grants.set(grant.grantId, grant);
        choices.push(...planned.choiceRequirements);
        conflicts.push(...planned.conflicts);
    }
    const uniqueChoices = [...new Map(choices.map((choice) => [choice.choiceId, choice] as const)).values()]
        .sort((left, right) => compareUtf8(left.choiceId, right.choiceId));
    if (
        menuChoiceDecisionDetailCount(uniqueChoices) > RESPONSE_DETAIL_LIMIT
        && !conflicts.some((item) => item.id === "menu-choice-detail-limit")
    ) {
        conflicts.push(menuConflict(
            "menu-choice-detail-limit",
            "LIMIT_EXCEEDED",
            `The complete API choice set exceeds the shared ${RESPONSE_DETAIL_LIMIT}-item decision budget.`,
        ));
    }
    return {
        grants: [...grants.values()].sort((left, right) => compareUtf8(left.grantId, right.grantId)),
        choices: uniqueChoices,
        conflicts: conflicts.sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.id, right.id)),
    };
}

function createTargetState(input: {
    readonly role: Readonly<InternalRoleDocument>;
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly beforeGrants: readonly Readonly<InternalRoleMenuGrantDocument>[];
    readonly plannedGrants: readonly PlannedRoleMenuGrant[];
    readonly change: MenuPermissionChange;
    readonly now: number;
    readonly conflicts: ManagementConflict[];
}) {
    const currentGrantById = new Map(input.beforeGrants.map((grant) => [grant.grantId, grant] as const));
    const plannedById = new Map(input.plannedGrants.map((grant) => [grant.grantId, grant] as const));
    const affectedGrantIds = new Set<string>();
    if (input.change.operation === "set") {
        for (const grantId of currentGrantById.keys()) affectedGrantIds.add(grantId);
        for (const grantId of plannedById.keys()) affectedGrantIds.add(grantId);
    } else if (input.change.operation === "revoke") {
        for (const grantId of input.change.grantIds) affectedGrantIds.add(grantId);
    } else {
        for (const grantId of plannedById.keys()) affectedGrantIds.add(grantId);
    }

    const targetGrantById = input.change.operation === "set"
        ? new Map<string, Readonly<InternalRoleMenuGrantDocument>>()
        : new Map(currentGrantById);
    if (input.change.operation === "revoke") {
        for (const grantId of input.change.grantIds) targetGrantById.delete(grantId);
    }
    const refreshedGrantIds: string[] = [];
    for (const planned of input.plannedGrants) {
        const current = currentGrantById.get(planned.grantId);
        const unchanged = current !== undefined
            && current.effect === planned.effect
            && canonicalString(current.intent) === canonicalString(planned.intent)
            && canonicalString(current.snapshot) === canonicalString(planned.snapshot);
        const next: Readonly<InternalRoleMenuGrantDocument> = unchanged
            ? current
            : deepFreeze({
                scopeKey: input.role.scopeKey,
                scope: input.role.scope,
                roleId: input.role.roleId,
                grantId: planned.grantId,
                effect: planned.effect,
                intent: planned.intent,
                snapshot: planned.snapshot,
                grantRevision: current === undefined ? 1 : current.grantRevision + 1,
                createdAt: current?.createdAt ?? input.now,
                updatedAt: input.now,
            });
        try {
            assertRoleMenuGrantBudget(next);
            assertInternalDocumentBudget(next);
        } catch (error) {
            if (error instanceof PermissionCoreError && error.code === "LIMIT_EXCEEDED") {
                input.conflicts.push(menuConflict(planned.grantId, "LIMIT_EXCEEDED", "The role menu grant exceeds its persisted byte budget."));
            } else {
                throw error;
            }
        }
        if (current !== undefined && !unchanged) refreshedGrantIds.push(planned.grantId);
        targetGrantById.set(planned.grantId, next);
    }

    const definitions = new Map(input.beforeRules.map((rule) => [rule.semanticKey, ruleDefinition(rule)] as const));
    const sourcesBySemanticKey = new Map<string, InternalRoleRuleSource[]>();
    for (const rule of input.beforeRules) {
        const retained = rule.sources.filter((source) => source.kind !== "menu" || !affectedGrantIds.has(source.grantId));
        if (retained.length > 0) sourcesBySemanticKey.set(rule.semanticKey, [...retained]);
    }
    for (const planned of input.plannedGrants) {
        const grantRevision = targetGrantById.get(planned.grantId)!.grantRevision;
        for (const item of planned.contributions) {
            const definition = contributionDefinition(item);
            const currentDefinition = definitions.get(item.semanticKey);
            if (currentDefinition !== undefined && canonicalString(currentDefinition) !== canonicalString(definition)) {
                persistedInvalid(`semantic rule ${item.semanticKey} has conflicting definitions`);
            }
            definitions.set(item.semanticKey, definition);
            const group = sourcesBySemanticKey.get(item.semanticKey) ?? [];
            const source = sourceFromContribution(item, grantRevision);
            if (group.some((candidate) => candidate.sourceId === source.sourceId)) {
                persistedInvalid(`menu source ${source.sourceId} is duplicated in the target state`);
            }
            group.push(source);
            sourcesBySemanticKey.set(item.semanticKey, group);
        }
    }

    const beforeRuleByKey = new Map(input.beforeRules.map((rule) => [rule.semanticKey, rule] as const));
    const afterRules: Readonly<InternalRoleRuleDocument>[] = [];
    for (const semanticKey of [...sourcesBySemanticKey.keys()].sort(compareUtf8)) {
        const sources = sourcesBySemanticKey.get(semanticKey)!.sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
        if (sources.length > MAX_RULE_SOURCES) {
            input.conflicts.push(menuConflict(`${input.role.roleId}:${semanticKey}`, "LIMIT_EXCEEDED", `A semantic rule would exceed ${MAX_RULE_SOURCES} sources.`));
        }
        const current = beforeRuleByKey.get(semanticKey);
        if (current !== undefined && canonicalString(current.sources) === canonicalString(sources)) {
            afterRules.push(current);
            continue;
        }
        const definition = definitions.get(semanticKey)!;
        const next: InternalRoleRuleDocument = current === undefined
            ? {
                scopeKey: input.role.scopeKey,
                scope: input.role.scope,
                roleId: input.role.roleId,
                ...definition,
                semanticKey,
                sources: Object.freeze(sources),
                revision: 1,
                createdAt: input.now,
                updatedAt: input.now,
            }
            : {
                ...current,
                sources: Object.freeze(sources),
                revision: current.revision + 1,
                updatedAt: input.now,
            };
        assertInternalDocumentBudget(next);
        afterRules.push(deepFreeze(next));
    }
    if (afterRules.length > MAX_RULES_PER_ROLE) {
        input.conflicts.push(menuConflict(input.role.roleId, "LIMIT_EXCEEDED", `The role would exceed ${MAX_RULES_PER_ROLE} semantic rules.`));
    }
    const afterGrants = [...targetGrantById.values()].sort((left, right) => compareUtf8(left.grantId, right.grantId));
    const afterSourceCount = sourceMap(afterRules).size;
    if (afterGrants.length > MAX_ROLE_MENU_AGGREGATE_COUNT || afterSourceCount > MAX_ROLE_MENU_AGGREGATE_COUNT) {
        input.conflicts.push(menuConflict(input.role.roleId, "LIMIT_EXCEEDED", `The role would exceed ${MAX_ROLE_MENU_AGGREGATE_COUNT} menu grants or sources.`));
    }
    const sourceChanges = sourceDelta(input.beforeRules, afterRules);
    if (sourceChanges.total > MAX_ROLE_MENU_SOURCE_MUTATIONS) {
        input.conflicts.push(menuConflict("role-menu-source-mutation-limit", "LIMIT_EXCEEDED", `The change requires ${sourceChanges.total} source mutations; the atomic limit is ${MAX_ROLE_MENU_SOURCE_MUTATIONS}.`));
    }
    const aggregate = createRoleMenuAggregateFields(afterGrants, afterRules);
    const grantMutations = documentMutations(input.beforeGrants, afterGrants, (grant) => grant.grantId);
    const ruleMutations = documentMutations(input.beforeRules, afterRules, (rule) => rule.semanticKey);
    const changed = grantMutations.length > 0 || ruleMutations.length > 0;
    const afterRole: Readonly<InternalRoleDocument> = changed
        ? deepFreeze({ ...input.role, ...aggregate, revision: input.role.revision + 1, updatedAt: input.now })
        : input.role;
    assertInternalDocumentBudget(afterRole);
    validateRoleMenuIntegrity(afterRole, afterRules, afterGrants);
    return {
        affectedGrantIds,
        afterRules: Object.freeze(afterRules),
        afterGrants: Object.freeze(afterGrants),
        afterRole,
        ruleMutations,
        grantMutations,
        sourceChanges,
        changed,
        refreshedGrantIds: refreshedGrantIds.sort(compareUtf8),
    };
}

interface PlannedBusinessRoleMenuGrant extends PlannedRoleMenuGrant {
    readonly configId: string;
    readonly selection: MenuBusinessPermissionSelection;
    readonly selectedAssetIds: readonly string[];
    readonly responseFields: readonly MenuBusinessResponseFieldRef[];
}

interface PreparedBusinessRoleMenuMutation extends PreparedMenuPlan<MenuBusinessPermissionPlan> {
    readonly role: Readonly<InternalRoleDocument>;
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly afterRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly beforeGrants: readonly Readonly<InternalRoleMenuGrantDocument>[];
    readonly afterGrants: readonly Readonly<InternalRoleMenuGrantDocument>[];
    readonly writePlan: PreparedSourceRewriteExecution;
    readonly changed: boolean;
    readonly affectedUsers: AffectedUsers;
    readonly grantResult: MenuBusinessPermissionGrantResult;
    readonly batchResult: BatchMutationSummary;
}

function splitApiResource(resource: ApiResource) {
    const separator = resource.indexOf(":/");
    return {
        method: resource.slice("api:".length, separator),
        path: resource.slice(separator + 1),
    };
}

function businessSourceContribution(
    grantId: string,
    effect: "allow" | "deny",
    rule: { action: MenuRuleContribution["action"]; resource: string; where?: MenuRuleContribution["where"] },
    provenance:
        | { contribution: "node"; assetId: string }
        | { contribution: "api"; assetId: string; apiBindingId: string }
        | { contribution: "data"; assetId: string; dataResource: string },
): MenuRuleContribution {
    const semanticKey = createSemanticKey(effect, rule.action, rule.resource, rule.where);
    return deepFreeze({
        sourceId: createMenuSourceId({ grantId, semanticKey, ...provenance }),
        grantId,
        semanticKey,
        effect,
        action: rule.action,
        resource: rule.resource,
        ...(rule.where === undefined ? {} : { where: rule.where }),
        ...provenance,
    });
}

function stableBusinessResponseFields(values: readonly MenuBusinessResponseFieldRef[]) {
    const byKey = new Map<string, MenuBusinessResponseFieldRef>();
    for (const value of values) {
        byKey.set(canonicalString([value.apiResource, value.targetDigest, value.field]), value);
    }
    return Object.freeze([...byKey.values()].sort((left, right) =>
        compareUtf8(left.apiResource, right.apiResource)
        || compareUtf8(left.targetDigest, right.targetDigest)
        || compareUtf8(left.field, right.field)));
}

function stableBusinessContributions(values: readonly MenuRuleContribution[]) {
    const bySourceId = new Map<string, MenuRuleContribution>();
    for (const value of values) bySourceId.set(value.sourceId, value);
    return Object.freeze([...bySourceId.values()].sort((left, right) => compareUtf8(left.sourceId, right.sourceId)));
}

function businessAffectedUsers(value: AffectedUsers): CountSample {
    return deepFreeze({
        total: value.total,
        sampleIds: Object.freeze([...value.sampleIds].sort(compareUtf8)),
        truncated: value.total > value.sampleIds.length,
        digest: value.digest,
    });
}

function businessGrantResult(input: {
    readonly roleId: string;
    readonly grantIds: readonly string[];
    readonly generatedSources: number;
    readonly generatedResponseFields: number;
    readonly removedSources: number;
}): MenuBusinessPermissionGrantResult {
    const budget = new DetailBudgetAllocator();
    return deepFreeze({
        roleId: input.roleId,
        grantIds: budget.bounded(input.grantIds),
        generatedSources: input.generatedSources,
        generatedResponseFields: input.generatedResponseFields,
        removedSources: input.removedSources,
    });
}

function decodeBusinessGrantResult(value: unknown): MenuBusinessPermissionGrantResult {
    if (value === null || typeof value !== "object" || Array.isArray(value)) persistedInvalid("business menu grant replay must be an object");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    const expected = ["generatedResponseFields", "generatedSources", "grantIds", "removedSources", "roleId"].sort(compareUtf8);
    if (canonicalString(keys) !== canonicalString(expected) || typeof record.roleId !== "string") persistedInvalid("business menu grant replay shape is invalid");
    for (const field of ["generatedSources", "generatedResponseFields", "removedSources"] as const) {
        if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0) persistedInvalid(`business menu grant replay ${field} is invalid`);
    }
    return deepFreeze({
        roleId: record.roleId,
        grantIds: decodeBoundedIds(record.grantIds, "grantIds"),
        generatedSources: record.generatedSources as number,
        generatedResponseFields: record.generatedResponseFields as number,
        removedSources: record.removedSources as number,
    });
}

function addNodeAndDescendants(
    compiled: CompiledMenuConfig,
    menuId: string,
    includeDescendants: boolean,
    includeLoads: boolean,
    includeActions: boolean,
    includeNavigationAncestors: boolean,
    selectedNodeIds: Set<string>,
    selectedApiResources: Set<ApiResource>,
    apiOwnerIdsByResource: Map<ApiResource, Set<string>>,
): void {
    const visitMenu = (menu: CompiledMenuConfig["snapshot"]["menus"][number], selected: boolean) => {
        const menuRef = compiled.menuIndex.get(menu.id);
        if (selected && menuRef !== undefined) selectedNodeIds.add(menuRef.nodeId);
        for (const view of menu.views) {
            if (selected) addView(compiled, view, includeLoads, includeActions, false, selectedNodeIds, selectedApiResources, apiOwnerIdsByResource);
        }
        for (const child of menu.children) visitMenu(child, selected && includeDescendants);
    };
    const findMenu = (
        menus: readonly CompiledMenuConfig["snapshot"]["menus"][number][],
    ): CompiledMenuConfig["snapshot"]["menus"][number] | undefined => {
        for (const menu of menus) {
            if (menu.id === menuId) return menu;
            const child = findMenu(menu.children);
            if (child !== undefined) return child;
        }
        return undefined;
    };
    const target = findMenu(compiled.snapshot.menus);
    if (target !== undefined) {
        if (includeNavigationAncestors) addMenuAndAncestors(compiled, menuId, selectedNodeIds);
        visitMenu(target, true);
        return;
    }
    throw new PermissionCoreError("MENU_NOT_FOUND", `Menu ${menuId} was not found in config ${compiled.configId}.`, {
        details: { kind: "validation", field: "selection.menus", reason: "menu does not exist in the selected config" },
    });
}

function addMenuAndAncestors(
    compiled: CompiledMenuConfig,
    menuId: string,
    selectedNodeIds: Set<string>,
): boolean {
    const visit = (
        menus: readonly CompiledMenuConfig["snapshot"]["menus"][number][],
        ancestors: readonly CompiledMenuConfig["snapshot"]["menus"][number][],
    ): boolean => {
        for (const menu of menus) {
            const chain = [...ancestors, menu];
            if (menu.id === menuId) {
                for (const item of chain) {
                    const ref = compiled.menuIndex.get(item.id);
                    if (ref !== undefined) selectedNodeIds.add(ref.nodeId);
                }
                return true;
            }
            if (visit(menu.children, chain)) return true;
        }
        return false;
    };
    return visit(compiled.snapshot.menus, []);
}

function addView(
    compiled: CompiledMenuConfig,
    view: CompiledMenuConfig["snapshot"]["menus"][number]["views"][number],
    includeLoads: boolean,
    includeActions: boolean,
    includeNavigationAncestors: boolean,
    selectedNodeIds: Set<string>,
    selectedApiResources: Set<ApiResource>,
    apiOwnerIdsByResource: Map<ApiResource, Set<string>>,
): void {
    const ref = compiled.viewIndex.get(view.id);
    if (ref === undefined) return;
    if (includeNavigationAncestors) addMenuAndAncestors(compiled, ref.menuId, selectedNodeIds);
    selectedNodeIds.add(ref.nodeId);
    if (includeLoads) {
        for (const load of view.load) {
            selectedApiResources.add(load.resource);
            const ownerIds = apiOwnerIdsByResource.get(load.resource) ?? new Set<string>();
            ownerIds.add(ref.apiOwnerNodeId);
            apiOwnerIdsByResource.set(load.resource, ownerIds);
        }
    }
    if (!includeActions) return;
    for (const action of view.actions) addAction(compiled, view.id, action, false, selectedNodeIds, selectedApiResources, apiOwnerIdsByResource);
}

function addAction(
    compiled: CompiledMenuConfig,
    viewId: string,
    action: CompiledMenuConfig["snapshot"]["menus"][number]["views"][number]["actions"][number],
    includeNavigationAncestors: boolean,
    selectedNodeIds: Set<string>,
    selectedApiResources: Set<ApiResource>,
    apiOwnerIdsByResource: Map<ApiResource, Set<string>>,
): void {
    const ref = compiled.actionIndex.get(canonicalString([viewId, action.resource]));
    if (ref === undefined) return;
    if (includeNavigationAncestors) {
        const viewRef = compiled.viewIndex.get(viewId);
        if (viewRef !== undefined) {
            addMenuAndAncestors(compiled, viewRef.menuId, selectedNodeIds);
            selectedNodeIds.add(viewRef.nodeId);
        }
    }
    selectedNodeIds.add(ref.nodeId);
    if (action.resource.startsWith("api:")) {
        const resource = action.resource as ApiResource;
        selectedApiResources.add(resource);
        const ownerIds = apiOwnerIdsByResource.get(resource) ?? new Set<string>();
        ownerIds.add(ref.nodeId);
        apiOwnerIdsByResource.set(resource, ownerIds);
    }
}

function addExplicitLoad(
    compiled: CompiledMenuConfig,
    resource: ApiResource,
    selectedApiResources: Set<ApiResource>,
    apiOwnerIdsByResource: Map<ApiResource, Set<string>>,
): void {
    const owners = compiled.apiOwners.filter((owner) => owner.apiResource === resource);
    if (owners.length === 0) {
        throw new PermissionCoreError("MENU_NOT_FOUND", `Load ${resource} was not found in config ${compiled.configId}.`, {
            details: { kind: "validation", field: "selection.loads", reason: "load API does not exist in the selected config" },
        });
    }
    selectedApiResources.add(resource);
    const ownerIds = apiOwnerIdsByResource.get(resource) ?? new Set<string>();
    for (const owner of owners) ownerIds.add(owner.owner.id);
    apiOwnerIdsByResource.set(resource, ownerIds);
}

function addExplicitAction(
    compiled: CompiledMenuConfig,
    selector: string,
    includeNavigationAncestors: boolean,
    selectedNodeIds: Set<string>,
    selectedApiResources: Set<ApiResource>,
    apiOwnerIdsByResource: Map<ApiResource, Set<string>>,
): void {
    type ActionMatch = CompiledMenuConfig["snapshot"]["menus"][number]["views"][number]["actions"][number] & { readonly viewId: string };
    const matches: ActionMatch[] = [];
    const visit = (menu: CompiledMenuConfig["snapshot"]["menus"][number]) => {
        for (const view of menu.views) {
            for (const action of view.actions) {
                if (action.actionId === selector || action.resource === selector) {
                    matches.push({ ...action, viewId: view.id });
                }
            }
        }
        for (const child of menu.children) visit(child);
    };
    for (const menu of compiled.snapshot.menus) visit(menu);
    if (matches.length === 0) {
        throw new PermissionCoreError("MENU_NOT_FOUND", `Action ${selector} was not found in config ${compiled.configId}.`, {
            details: { kind: "validation", field: "selection.actions", reason: "action does not exist in the selected config" },
        });
    }
    for (const action of matches) {
        addAction(compiled, action.viewId, action, includeNavigationAncestors, selectedNodeIds, selectedApiResources, apiOwnerIdsByResource);
    }
}

function responseFieldRefs(
    compiled: CompiledMenuConfig,
    selection: MenuBusinessPermissionSelection,
    selectedApiResources: Set<ApiResource>,
): readonly MenuBusinessResponseFieldRef[] {
    const refs: MenuBusinessResponseFieldRef[] = [];
    const addAllForApi = (apiResource: ApiResource) => {
        const responses = compiled.responseDefinitions.filter((definition) => definition.apiResource === apiResource);
        for (const response of responses) {
            for (const field of response.fields) {
                refs.push(deepFreeze({
                    apiResource,
                    targetDigest: response.targetDigest,
                    field: field.field,
                    fieldId: field.fieldId,
                    title: field.title,
                    ownerViewIds: Object.freeze([...new Set(field.owners.map((owner) => owner.viewId))].sort(compareUtf8)),
                }));
            }
        }
    };
    if (selection.include?.responseFields === "all") {
        for (const apiResource of [...selectedApiResources].sort(compareUtf8)) addAllForApi(apiResource);
    }
    for (const explicit of selection.responseFields ?? []) {
        selectedApiResources.add(explicit.apiResource);
        const responses = compiled.responseDefinitions.filter((definition) => definition.apiResource === explicit.apiResource);
        const targetDigest = explicit.target === undefined ? undefined : digestCanonical({ target: explicit.target });
        const response = targetDigest === undefined
            ? (responses.length === 1 ? responses[0] : undefined)
            : responses.find((definition) => definition.targetDigest === targetDigest);
        if (response === undefined) {
            throw new PermissionCoreError("MENU_NOT_FOUND", `Response definition for ${explicit.apiResource} was not found or requires an explicit target.`, {
                details: { kind: "validation", field: "selection.responseFields", reason: "API response fields are not declared in the selected config or target is ambiguous" },
            });
        }
        for (const fieldName of explicit.fields) {
            const field = response.fields.find((candidate) => candidate.field === fieldName);
            if (field === undefined) {
                throw new PermissionCoreError("MENU_NOT_FOUND", `Response field ${fieldName} was not found on ${explicit.apiResource}.`, {
                    details: { kind: "validation", field: "selection.responseFields.fields", reason: "field is not declared in the selected response schema" },
                });
            }
            refs.push(deepFreeze({
                apiResource: explicit.apiResource,
                targetDigest: response.targetDigest,
                field: field.field,
                fieldId: field.fieldId,
                title: field.title,
                ownerViewIds: Object.freeze([...new Set(field.owners.map((owner) => owner.viewId))].sort(compareUtf8)),
            }));
        }
    }
    return stableBusinessResponseFields(refs);
}

function bindingForApiResource(
    apiResource: ApiResource,
    bindings: readonly Readonly<InternalApiBindingDocument>[],
) {
    const parsed = splitApiResource(apiResource);
    return bindings.find((binding) =>
        binding.method === parsed.method
        && binding.path === parsed.path
        && binding.authorization.permissions.some((permission) => permission.action === "invoke" && permission.resource === apiResource));
}

function planBusinessSelection(input: {
    readonly scopeHash: string;
    readonly roleId: string;
    readonly effect: "allow" | "deny";
    readonly selection: MenuBusinessPermissionSelection;
    readonly compiled: CompiledMenuConfig;
    readonly nodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly bindings: readonly Readonly<InternalApiBindingDocument>[];
}): PlannedBusinessRoleMenuGrant {
    const includeDescendants = input.selection.include?.descendants ?? false;
    const includeLoads = input.selection.include?.loads ?? true;
    const includeActions = input.selection.include?.actions ?? false;
    const includeNavigationAncestors = input.effect === "allow";
    const selectedNodeIds = new Set<string>();
    const selectedApiResources = new Set<ApiResource>();
    const apiOwnerIdsByResource = new Map<ApiResource, Set<string>>();

    for (const menuId of input.selection.menus ?? []) {
        addNodeAndDescendants(input.compiled, menuId, includeDescendants, includeLoads, includeActions, includeNavigationAncestors, selectedNodeIds, selectedApiResources, apiOwnerIdsByResource);
    }
    for (const viewId of input.selection.views ?? []) {
        const view = input.compiled.snapshot.menus.flatMap(function visit(menu): typeof menu.views {
            return [...menu.views, ...menu.children.flatMap(visit)];
        }).find((candidate) => candidate.id === viewId);
        if (view === undefined) {
            throw new PermissionCoreError("MENU_NOT_FOUND", `View ${viewId} was not found in config ${input.compiled.configId}.`, {
                details: { kind: "validation", field: "selection.views", reason: "view does not exist in the selected config" },
            });
        }
        addView(input.compiled, view, includeLoads, includeActions, includeNavigationAncestors, selectedNodeIds, selectedApiResources, apiOwnerIdsByResource);
    }
    for (const resource of input.selection.loads ?? []) {
        addExplicitLoad(input.compiled, resource, selectedApiResources, apiOwnerIdsByResource);
    }
    for (const action of input.selection.actions ?? []) {
        addExplicitAction(input.compiled, action, includeNavigationAncestors, selectedNodeIds, selectedApiResources, apiOwnerIdsByResource);
    }
    for (const explicit of input.selection.responseFields ?? []) {
        addExplicitLoad(input.compiled, explicit.apiResource, selectedApiResources, apiOwnerIdsByResource);
    }
    const responseFields = responseFieldRefs(input.compiled, input.selection, selectedApiResources);

    const nodesById = new Map(input.nodes.map((node) => [node.nodeId, node] as const));
    const contributions: MenuRuleContribution[] = [];
    const grantDigest = digestCanonical({
        scopeHash: input.scopeHash,
        roleId: input.roleId,
        effect: input.effect,
        selection: input.selection,
        responseFields,
    });
    const grantId = `grant_${grantDigest}`;
    const sortedNodeIds = [...selectedNodeIds].sort(compareUtf8);
    for (const nodeId of sortedNodeIds) {
        const node = nodesById.get(nodeId);
        if (node === undefined) {
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", `Compiled menu node ${nodeId} was not materialized.`, {
                details: { kind: "persisted-state-invalid", stage: "load", reason: "compiled-menu-node-missing" },
            });
        }
        if (node.permission !== undefined) {
            contributions.push(businessSourceContribution(grantId, input.effect, node.permission, {
                contribution: "node",
                assetId: node.nodeId,
            }));
        }
    }

    for (const apiResource of [...selectedApiResources].sort(compareUtf8)) {
        const binding = bindingForApiResource(apiResource, input.bindings);
        if (binding === undefined) {
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", `Compiled API binding ${apiResource} was not materialized.`, {
                details: { kind: "persisted-state-invalid", stage: "load", reason: "compiled-api-binding-missing" },
            });
        }
        const configuredOwnerIds = apiOwnerIdsByResource.get(apiResource);
        const ownerIds = configuredOwnerIds === undefined || configuredOwnerIds.size === 0
            ? binding.owners.map((owner) => owner.id)
            : binding.owners
                .filter((owner) => configuredOwnerIds.has(owner.id))
                .map((owner) => owner.id);
        for (const assetId of [...new Set(ownerIds)].sort(compareUtf8)) {
            for (const permission of binding.authorization.permissions) {
                contributions.push(businessSourceContribution(grantId, input.effect, permission, {
                    contribution: "api",
                    assetId,
                    apiBindingId: binding.bindingId,
                }));
            }
        }
    }

    const intent = deepFreeze({
        anchorId: sortedNodeIds[0] ?? [...apiOwnerIdsByResource.values()][0]?.values().next().value ?? input.roleId,
        include: deepFreeze({ descendants: false, buttons: false, apis: "none" as const, dataPermissions: false }),
        apiChoices: deepFreeze({ bindingIds: Object.freeze([] as string[]), permissionsByBinding: deepFreeze({}) }),
    });
    const canonicalContributions = stableBusinessContributions(contributions);
    const baseSnapshot = createRoleMenuGrantSnapshotFromContributions(intent, canonicalContributions);
    const selectedAssetIds = [...new Set([
        ...sortedNodeIds,
        ...canonicalContributions.map((contribution) => contribution.assetId),
    ])].sort(compareUtf8);
    return deepFreeze({
        grantId,
        effect: input.effect,
        intent,
        snapshot: deepFreeze({
            ...baseSnapshot,
            business: deepFreeze({
                configId: input.selection.configId,
                selection: input.selection,
                responseFields,
            }),
        }),
        contributions: Object.freeze(canonicalContributions),
        configId: input.selection.configId,
        selection: input.selection,
        selectedAssetIds: Object.freeze(selectedAssetIds),
        responseFields,
    });
}

function businessAssignments(change: MenuBusinessPermissionChange): readonly MenuBusinessPermissionAssignment[] {
    if (change.operation === "revoke") return Object.freeze([]);
    if (change.operation === "set") return change.assignments;
    return Object.freeze([{ effect: change.operation === "grant" ? "allow" as const : "deny" as const, selection: change.selection }]);
}

function operationBusinessGrantPlans(input: {
    readonly stateScopeKey: string;
    readonly roleId: string;
    readonly change: MenuBusinessPermissionChange;
    readonly configs: readonly CompiledMenuConfig[];
    readonly nodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly bindings: readonly Readonly<InternalApiBindingDocument>[];
}) {
    if (input.change.operation === "revoke") return { grants: [] as PlannedBusinessRoleMenuGrant[], conflicts: [] as ManagementConflict[] };
    const configById = new Map(input.configs.map((config) => [config.configId, config] as const));
    const grants = new Map<string, PlannedBusinessRoleMenuGrant>();
    const conflicts: ManagementConflict[] = [];
    for (const assignment of businessAssignments(input.change)) {
        const compiled = configById.get(assignment.selection.configId);
        if (compiled === undefined) {
            throw new PermissionCoreError("MENU_NOT_FOUND", `Menu config ${assignment.selection.configId} was not found.`, {
                details: { kind: "validation", field: "selection.configId", reason: "menu config does not exist" },
            });
        }
        const planned = planBusinessSelection({
            scopeHash: input.stateScopeKey,
            roleId: input.roleId,
            effect: assignment.effect,
            selection: assignment.selection,
            compiled,
            nodes: input.nodes,
            bindings: input.bindings,
        });
        if (planned.contributions.length === 0 && planned.responseFields.length === 0) {
            conflicts.push(menuConflict(planned.grantId, "MENU_SELECTION_EMPTY", "The menu business selection does not produce any permission contribution."));
        }
        grants.set(planned.grantId, planned);
    }
    const sourceCount = [...grants.values()].reduce((total, grant) => total + grant.contributions.length, 0);
    if (sourceCount > MAX_ROLE_MENU_SOURCE_MUTATIONS) {
        conflicts.push(menuConflict("menu-source-mutation-limit", "LIMIT_EXCEEDED", `The selection produces ${sourceCount} sources; the atomic limit is ${MAX_ROLE_MENU_SOURCE_MUTATIONS}.`));
    }
    return {
        grants: [...grants.values()].sort((left, right) => compareUtf8(left.grantId, right.grantId)),
        conflicts: conflicts.sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.id, right.id)),
    };
}

function legacyChangeForTarget(change: MenuBusinessPermissionChange): MenuPermissionChange {
    if (change.operation === "revoke") return { operation: "revoke", grantIds: change.grantIds };
    if (change.operation === "set") return { operation: "set", assignments: Object.freeze([]) };
    return {
        operation: change.operation,
        selection: {
            nodeIds: Object.freeze([]),
            include: { descendants: false, buttons: false, apis: "none", dataPermissions: false },
            apiChoices: { bindingIds: Object.freeze([]), permissionsByBinding: {} },
        },
    } as MenuPermissionChange;
}

function publicBusinessGrantPlan(value: PlannedBusinessRoleMenuGrant): MenuBusinessPermissionPlan["grants"]["items"][number] {
    return deepFreeze({
        grantId: value.grantId,
        effect: value.effect,
        configId: value.configId,
        selectedAssets: sampledCountSample(value.selectedAssetIds),
        selectedResponseFields: sampledCountSample(value.responseFields.map((field) =>
            `${field.apiResource}:${field.targetDigest}:${field.field}`)),
    });
}

function publicBusinessRemovals(
    values: readonly { grantId: string; sourceCount: number }[],
    budget: DetailBudgetAllocator,
): BoundedDetails<{ grantId: string; sourceCount: number }> {
    return budget.bounded(values.map((value) => deepFreeze(value)));
}

export class BusinessRoleMenuPermissionMutationService {
    private readonly executor: ManagementMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
    }

    private async prepare(
        rbacReader: RbacScopeReader,
        menuReader: MenuScopeReader,
        roleId: string,
        change: MenuBusinessPermissionChange,
        now: number,
        session: MongoSession,
    ): Promise<PreparedBusinessRoleMenuMutation> {
        const role = await rbacReader.requireRole(roleId);
        mutableRole(role);
        const [beforeRules, beforeGrants, inventory, configDocuments] = await Promise.all([
            rbacReader.readRulesForRole(roleId),
            menuReader.readGrantsForRole(roleId),
            menuReader.readCompleteInventory(),
            readScopedMenuConfigDocuments(this.repository, this.schemes, menuReader, session),
        ]);
        validateRoleMenuIntegrity(role, beforeRules, beforeGrants);
        const compiledConfigs = configDocuments.map((document) => compileMenuConfigSnapshot(document.config, this.schemes));
        const planned = operationBusinessGrantPlans({
            stateScopeKey: menuReader.state.scopeKey,
            roleId,
            change,
            configs: compiledConfigs,
            nodes: inventory.nodes,
            bindings: inventory.bindings,
        });
        const conflicts = [...planned.conflicts];
        const target = createTargetState({
            role,
            beforeRules,
            beforeGrants,
            plannedGrants: planned.grants,
            change: legacyChangeForTarget(change),
            now,
            conflicts,
        });
        const affectedRoleIds = await loadAffectedRoleIds(this.repository, rbacReader, [roleId], session);
        const affectedUsers = await loadAffectedUsers(
            this.repository,
            rbacReader,
            affectedRoleIds,
            `role-menu-business:${roleId}:${digestCanonical(change)}`,
            session,
        );
        const capacity = conflicts.length > 0
            ? null
            : await assessAuthorizationCapacity({
                repository: this.repository,
                reader: rbacReader,
                affectedUsers,
                overlay: { rulesByRoleId: new Map([[roleId, target.afterRules]]) },
                structuralCapacityNonIncreasing:
                    target.afterRules.length <= beforeRules.length
                    && sourceMap(target.afterRules).size <= sourceMap(beforeRules).size,
                knownCapacityRiskMayBeAcknowledged: true,
                accessHint: accessHint(beforeRules, target.afterRules),
                session,
            });
        const completeGrants = planned.grants.map(publicBusinessGrantPlan);
        const removals = beforeGrants
            .filter((grant) => !target.afterGrants.some((candidate) => candidate.grantId === grant.grantId))
            .map((grant) => ({
                grantId: grant.grantId,
                sourceCount: beforeRules.reduce((total, rule) => total + rule.sources.filter((source) =>
                    source.kind === "menu" && source.grantId === grant.grantId).length, 0),
            }))
            .sort((left, right) => compareUtf8(left.grantId, right.grantId));
        const completePlan = toPolicyValue({
            roleId,
            operation: change.operation,
            grants: completeGrants,
            removals,
            affectedUsers: businessAffectedUsers(affectedUsers),
        });
        const revisionEntities = [{ kind: "role" as const, id: roleId, revision: role.revision }];
        const expectedRevisions = expectedMenuRevisions(menuReader, revisionEntities, true);
        const inputHash = digestCanonical({ roleId, change });
        const planHash = menuPlanHash(ROLE_MENU_PREVIEW_METHOD, inputHash, expectedRevisions, completePlan);
        const grantMutations = target.grantMutations;
        const ruleMutations = target.ruleMutations;
        const inserted = [...grantMutations, ...ruleMutations].filter((mutation) => mutation.before === null).length;
        const deleted = [...grantMutations, ...ruleMutations].filter((mutation) => mutation.after === null).length;
        const updated = [...grantMutations, ...ruleMutations].filter((mutation) => mutation.before !== null && mutation.after !== null).length
            + (target.changed ? 1 : 0);
        const summaryCounts = emptyBatchCounts({
            inserted,
            updated,
            deleted,
            unchanged: target.changed ? 0 : Math.max(1, planned.grants.length),
            conflicted: conflicts.length,
        });
        const summarySamples = [
            ...target.grantMutations.map((mutation) => ({
                id: (mutation.after ?? mutation.before)!.grantId,
                outcome: mutation.before === null ? "inserted" as const
                    : mutation.after === null ? "deleted" as const
                        : "updated" as const,
            })),
            ...(!target.changed && planned.grants.length > 0
                ? planned.grants.map((grant) => ({ id: grant.grantId, outcome: "unchanged" as const }))
                : []),
        ];
        const grantIds = planned.grants.map((grant) => grant.grantId);
        const grantResult = businessGrantResult({
            roleId,
            grantIds,
            generatedSources: target.sourceChanges.inserted,
            generatedResponseFields: planned.grants.reduce((total, grant) => total + grant.responseFields.length, 0),
            removedSources: target.sourceChanges.deleted,
        });
        const batchResult: BatchMutationSummary = deepFreeze({
            ...summaryCounts,
            samples: boundedDetails(sortBatchMutationSamples(summarySamples)),
        });
        const rolePlan: SourceRewriteRolePlan = {
            beforeRole: role,
            afterRole: target.afterRole,
            rules: target.ruleMutations,
            grants: target.grantMutations,
            beforeRules,
            afterRules: target.afterRules,
        };
        const writePlan: PreparedSourceRewriteExecution = {
            roles: target.changed ? Object.freeze([rolePlan]) : Object.freeze([]),
            beforeRulesByRole: new Map([[roleId, beforeRules]]),
            afterRulesByRole: new Map([[roleId, target.afterRules]]),
            sourceMutationCount: target.sourceChanges.total,
            conflicts: Object.freeze(conflicts),
            auditPlan: completePlan,
        };
        return {
            method: ROLE_MENU_PREVIEW_METHOD,
            reader: menuReader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: planned.grants.length + removals.length,
            publicPlan: (budget) => deepFreeze({
                roleId,
                operation: change.operation,
                grants: budget.bounded(completeGrants),
                removals: publicBusinessRemovals(removals, budget),
                affectedUsers: businessAffectedUsers(affectedUsers),
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts,
            summarySamples,
            warnings: [],
            conflicts: Object.freeze(conflicts),
            capacity,
            role,
            beforeRules,
            afterRules: target.afterRules,
            beforeGrants,
            afterGrants: target.afterGrants,
            writePlan,
            changed: target.changed,
            affectedUsers,
            grantResult,
            batchResult,
        };
    }

    async preview(
        scope: PermissionScope,
        roleIdInput: string,
        changeInput: MenuBusinessPermissionChange,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<MenuBusinessPermissionPlan>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeMenuBusinessPermissionChange(changeInput);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            const rbacReader = new RbacScopeReader(this.repository, this.schemes, state, transaction.session);
            const menuReader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
            return this.prepare(rbacReader, menuReader, roleId, change, issuedAt, transaction.session);
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    grant(
        scope: PermissionScope,
        roleId: string,
        selection: MenuBusinessPermissionSelection,
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        return this.executeGrantChange(scope, roleId, { operation: "grant", selection }, options);
    }

    deny(
        scope: PermissionScope,
        roleId: string,
        selection: MenuBusinessPermissionSelection,
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        return this.executeGrantChange(scope, roleId, { operation: "deny", selection }, options);
    }

    revoke(
        scope: PermissionScope,
        roleId: string,
        input: { grantIds: readonly string[] },
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        return this.executeBatchChange(scope, roleId, { operation: "revoke", grantIds: input.grantIds }, options);
    }

    set(
        scope: PermissionScope,
        roleId: string,
        assignments: readonly MenuBusinessPermissionAssignment[],
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        return this.executeBatchChange(scope, roleId, { operation: "set", assignments }, options);
    }

    private executeGrantChange(
        scope: PermissionScope,
        roleId: string,
        changeInput: Extract<MenuBusinessPermissionChange, { operation: "grant" | "deny" }>,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<MenuBusinessPermissionGrantResult>> {
        return this.execute(scope, roleId, changeInput, optionsValue, decodeBusinessGrantResult, (prepared) => prepared.grantResult);
    }

    private executeBatchChange(
        scope: PermissionScope,
        roleId: string,
        changeInput: Extract<MenuBusinessPermissionChange, { operation: "revoke" | "set" }>,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        return this.execute(scope, roleId, changeInput, optionsValue, decodeBatchMutationSummaryReplay, (prepared) => prepared.batchResult);
    }

    private execute<T>(
        scope: PermissionScope,
        roleIdInput: string,
        changeInput: MenuBusinessPermissionChange,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
        decodeReplay: (value: unknown) => T,
        result: (prepared: PreparedBusinessRoleMenuMutation) => T,
    ): Promise<MutationResult<T>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeMenuBusinessPermissionChange(changeInput);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        const operation = `roles.menuPermissions.${change.operation}` as
            | "roles.menuPermissions.grant"
            | "roles.menuPermissions.deny"
            | "roles.menuPermissions.revoke"
            | "roles.menuPermissions.set";
        const action: "grant" | "deny" | "revoke" | "set" = change.operation === "grant" ? "grant" : change.operation;
        return this.executor.execute({
            scope,
            operation,
            action,
            resource: `role:${roleId}:menu-business-permissions`,
            request: toPolicyValue({ roleId, change, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay,
            work: async ({ transaction, state, now }) => {
                const rbacReader = new RbacScopeReader(this.repository, this.schemes, state, transaction.session);
                const menuReader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.prepare(rbacReader, menuReader, roleId, change, now, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                if (prepared.changed) {
                    await applySourceRewriteExecution({
                        repository: this.repository,
                        schemes: this.schemes,
                        session: transaction.session,
                        prepared: prepared.writePlan,
                    });
                }
                const data = result(prepared);
                const returnedDetails = change.operation === "grant" || change.operation === "deny"
                    ? prepared.grantResult.grantIds.items.length
                    : prepared.batchResult.samples.items.length;
                const totalDetails = change.operation === "grant" || change.operation === "deny"
                    ? prepared.grantResult.grantIds.total
                    : prepared.batchResult.samples.total;
                return {
                    changed: prepared.changed,
                    data,
                    primaryRevision: prepared.changed ? prepared.role.revision + 1 : prepared.role.revision,
                    entity: {
                        kind: "role",
                        id: roleId,
                        before: prepared.role.revision,
                        after: prepared.changed ? prepared.role.revision + 1 : prepared.role.revision,
                    },
                    revisionImpact: { rbac: prepared.changed, menu: false },
                    change: { kind: "role-menu-permission", plan: prepared.completePlan },
                    cacheTargets: prepared.changed
                        ? authorizationCacheTargets(state.scopeKey, prepared.affectedUsers)
                        : [],
                    returnedDetails,
                    completeDetailTree: { totalDetails, planHash: prepared.planHash },
                    validatedPlanHash: prepared.planHash,
                    ...(prepared.capacity === null ? {} : { capacity: toPolicyValue(prepared.capacity) }),
                };
            },
        });
    }
}

export class RoleMenuPermissionMutationService {
    private readonly executor: ManagementMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
    }

    private async prepare(
        rbacReader: RbacScopeReader,
        menuReader: MenuScopeReader,
        roleId: string,
        change: MenuPermissionChange,
        now: number,
        session: MongoSession,
    ): Promise<PreparedRoleMenuMutation> {
        const role = await rbacReader.requireRole(roleId);
        mutableRole(role);
        const [beforeRules, beforeGrants, inventory] = await Promise.all([
            rbacReader.readRulesForRole(roleId),
            menuReader.readGrantsForRole(roleId),
            menuReader.readCompleteInventory(),
        ]);
        validateRoleMenuIntegrity(role, beforeRules, beforeGrants);
        const planned = operationGrantPlans(
            menuReader.state.scopeKey,
            roleId,
            change,
            inventory.nodes,
            inventory.bindings,
        );
        const conflicts = [...planned.conflicts];
        const target = createTargetState({
            role,
            beforeRules,
            beforeGrants,
            plannedGrants: planned.grants,
            change,
            now,
            conflicts,
        });
        const affectedRoleIds = await loadAffectedRoleIds(this.repository, rbacReader, [roleId], session);
        const affectedUsers = await loadAffectedUsers(
            this.repository,
            rbacReader,
            affectedRoleIds,
            `role-menu:${roleId}:${digestCanonical(change)}`,
            session,
        );
        const capacity = conflicts.length > 0
            ? null
            : await assessAuthorizationCapacity({
                repository: this.repository,
                reader: rbacReader,
                affectedUsers,
                overlay: { rulesByRoleId: new Map([[roleId, target.afterRules]]) },
                structuralCapacityNonIncreasing:
                    target.afterRules.length <= beforeRules.length
                    && sourceMap(target.afterRules).size <= sourceMap(beforeRules).size,
                knownCapacityRiskMayBeAcknowledged: true,
                accessHint: accessHint(beforeRules, target.afterRules),
                session,
            });
        const completeGrants = planned.grants.map((grant) => ({
            grantId: grant.grantId,
            effect: grant.effect,
            intent: grant.intent,
            snapshot: grant.snapshot,
            contributions: grant.contributions,
        }));
        const removals = beforeGrants
            .filter((grant) => !target.afterGrants.some((candidate) => candidate.grantId === grant.grantId))
            .map((grant) => ({
                grantId: grant.grantId,
                sourceIds: beforeRules.flatMap((rule) => rule.sources.flatMap((source) => (
                    source.kind === "menu" && source.grantId === grant.grantId ? [source.sourceId] : []
                ))).sort(compareUtf8),
            }))
            .sort((left, right) => compareUtf8(left.grantId, right.grantId));
        const completePlan = toPolicyValue({
            roleId,
            operation: change.operation,
            choiceRequirements: planned.choices,
            grants: completeGrants,
            removals,
        });
        const revisionEntities = [{ kind: "role" as const, id: roleId, revision: role.revision }];
        const expectedRevisions = expectedMenuRevisions(menuReader, revisionEntities, true);
        const inputHash = digestCanonical({ roleId, change });
        const planHash = menuPlanHash(ROLE_MENU_PREVIEW_METHOD, inputHash, expectedRevisions, completePlan);
        const grantMutations = target.grantMutations;
        const ruleMutations = target.ruleMutations;
        const inserted = [...grantMutations, ...ruleMutations].filter((mutation) => mutation.before === null).length;
        const deleted = [...grantMutations, ...ruleMutations].filter((mutation) => mutation.after === null).length;
        const updated = [...grantMutations, ...ruleMutations].filter((mutation) => mutation.before !== null && mutation.after !== null).length
            + (target.changed ? 1 : 0);
        const summaryCounts = emptyBatchCounts({
            inserted,
            updated,
            deleted,
            unchanged: target.changed ? 0 : Math.max(1, planned.grants.length),
            conflicted: conflicts.length,
        });
        const summarySamples = [
            ...target.grantMutations.map((mutation) => ({
                id: (mutation.after ?? mutation.before)!.grantId,
                outcome: mutation.before === null ? "inserted" as const
                    : mutation.after === null ? "deleted" as const
                        : "updated" as const,
            })),
            ...(!target.changed && planned.grants.length > 0
                ? planned.grants.map((grant) => ({ id: grant.grantId, outcome: "unchanged" as const }))
                : []),
        ];
        const beforeSemanticKeys = new Set(beforeRules.map((rule) => rule.semanticKey));
        const grantIds = planned.grants.map((grant) => grant.grantId);
        const grantResult = menuPermissionGrantResult({
            roleId,
            grantIds,
            refreshedGrantIds: target.refreshedGrantIds,
            generatedSources: target.sourceChanges.inserted,
            removedSources: target.sourceChanges.deleted,
            generatedSemanticRules: target.afterRules.filter((rule) => !beforeSemanticKeys.has(rule.semanticKey)).length,
        });
        const batchResult: BatchMutationSummary = deepFreeze({
            ...summaryCounts,
            samples: boundedDetails(sortBatchMutationSamples(summarySamples)),
        });
        const rolePlan: SourceRewriteRolePlan = {
            beforeRole: role,
            afterRole: target.afterRole,
            rules: target.ruleMutations,
            grants: target.grantMutations,
            beforeRules,
            afterRules: target.afterRules,
        };
        const writePlan: PreparedSourceRewriteExecution = {
            roles: target.changed ? Object.freeze([rolePlan]) : Object.freeze([]),
            beforeRulesByRole: new Map([[roleId, beforeRules]]),
            afterRulesByRole: new Map([[roleId, target.afterRules]]),
            sourceMutationCount: target.sourceChanges.total,
            conflicts: Object.freeze(conflicts),
            auditPlan: completePlan,
        };
        const prepared: PreparedRoleMenuMutation = {
            method: ROLE_MENU_PREVIEW_METHOD,
            reader: menuReader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: menuChoiceDecisionDetailCount(planned.choices),
            publicPlan: (budget) => {
                const selectedChoices = budget.sample(planned.choices, planned.choices.length);
                const publicChoices = selectedChoices.map((choice) => publicChoiceRequirement(choice, budget));
                const selectedGrants = budget.sample(planned.grants, planned.grants.length);
                return deepFreeze({
                    roleId,
                    operation: change.operation,
                    choiceRequirements: deepFreeze({
                        total: planned.choices.length,
                        items: publicChoices,
                        truncated: selectedChoices.length < planned.choices.length,
                        digest: digestCanonical(planned.choices),
                    }),
                    grants: deepFreeze({
                        total: planned.grants.length,
                        items: selectedGrants.map((grant) => publicGrant(grant, budget)),
                        truncated: selectedGrants.length < planned.grants.length,
                        digest: digestCanonical(completeGrants),
                    }),
                    removals: publicRoleMenuRemovals(removals, budget),
                });
            },
            expectedRevisions,
            revisionEntities,
            summaryCounts,
            summarySamples,
            warnings: [],
            conflicts: Object.freeze(conflicts),
            capacity,
            role,
            beforeRules,
            afterRules: target.afterRules,
            beforeGrants,
            afterGrants: target.afterGrants,
            writePlan,
            changed: target.changed,
            affectedUsers,
            grantResult,
            batchResult,
        };
        return prepared;
    }

    async preview(
        scope: PermissionScope,
        roleIdInput: string,
        changeInput: MenuPermissionChange,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<MenuPermissionPlan>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeMenuPermissionChange(changeInput);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            const rbacReader = new RbacScopeReader(this.repository, this.schemes, state, transaction.session);
            const menuReader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
            return this.prepare(rbacReader, menuReader, roleId, change, issuedAt, transaction.session);
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    grant(
        scope: PermissionScope,
        roleId: string,
        selection: MenuPermissionSelection,
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        return this.executeGrantChange(scope, roleId, { operation: "grant", selection }, options);
    }

    deny(
        scope: PermissionScope,
        roleId: string,
        selection: MenuPermissionSelection,
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        return this.executeGrantChange(scope, roleId, { operation: "deny", selection }, options);
    }

    revoke(
        scope: PermissionScope,
        roleId: string,
        input: { grantIds: readonly string[] },
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        return this.executeBatchChange(scope, roleId, { operation: "revoke", grantIds: input.grantIds }, options);
    }

    set(
        scope: PermissionScope,
        roleId: string,
        assignments: Extract<MenuPermissionChange, { operation: "set" }>["assignments"],
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        return this.executeBatchChange(scope, roleId, { operation: "set", assignments }, options);
    }

    private executeGrantChange(
        scope: PermissionScope,
        roleId: string,
        changeInput: Extract<MenuPermissionChange, { operation: "grant" | "deny" }>,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<MenuPermissionGrantResult>> {
        return this.execute(scope, roleId, changeInput, optionsValue, decodeMenuPermissionGrantResult, (prepared) => prepared.grantResult);
    }

    private executeBatchChange(
        scope: PermissionScope,
        roleId: string,
        changeInput: Extract<MenuPermissionChange, { operation: "revoke" | "set" }>,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        return this.execute(scope, roleId, changeInput, optionsValue, decodeBatchMutationSummaryReplay, (prepared) => prepared.batchResult);
    }

    private execute<T>(
        scope: PermissionScope,
        roleIdInput: string,
        changeInput: MenuPermissionChange,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
        decodeReplay: (value: unknown) => T,
        result: (prepared: PreparedRoleMenuMutation) => T,
    ): Promise<MutationResult<T>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeMenuPermissionChange(changeInput);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        const operation = `roles.menuPermissions.${change.operation}` as
            | "roles.menuPermissions.grant"
            | "roles.menuPermissions.deny"
            | "roles.menuPermissions.revoke"
            | "roles.menuPermissions.set";
        const action: "grant" | "deny" | "revoke" | "set" = change.operation === "grant" ? "grant" : change.operation;
        return this.executor.execute({
            scope,
            operation,
            action,
            resource: `role:${roleId}:menu-permissions`,
            request: toPolicyValue({ roleId, change, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay,
            work: async ({ transaction, state, now }) => {
                const rbacReader = new RbacScopeReader(this.repository, this.schemes, state, transaction.session);
                const menuReader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.prepare(rbacReader, menuReader, roleId, change, now, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                if (prepared.changed) {
                    await applySourceRewriteExecution({
                        repository: this.repository,
                        schemes: this.schemes,
                        session: transaction.session,
                        prepared: prepared.writePlan,
                    });
                }
                const data = result(prepared);
                const returnedDetails = change.operation === "grant" || change.operation === "deny"
                    ? prepared.grantResult.grantIds.items.length + prepared.grantResult.refreshedGrantIds.items.length
                    : prepared.batchResult.samples.items.length;
                const totalDetails = change.operation === "grant" || change.operation === "deny"
                    ? prepared.grantResult.grantIds.total + prepared.grantResult.refreshedGrantIds.total
                    : prepared.batchResult.samples.total;
                return {
                    changed: prepared.changed,
                    data,
                    primaryRevision: prepared.changed ? prepared.role.revision + 1 : prepared.role.revision,
                    entity: {
                        kind: "role",
                        id: roleId,
                        before: prepared.role.revision,
                        after: prepared.changed ? prepared.role.revision + 1 : prepared.role.revision,
                    },
                    revisionImpact: { rbac: prepared.changed, menu: false },
                    change: { kind: "role-menu-permission", plan: prepared.completePlan },
                    cacheTargets: prepared.changed
                        ? authorizationCacheTargets(state.scopeKey, prepared.affectedUsers)
                        : [],
                    returnedDetails,
                    completeDetailTree: { totalDetails, planHash: prepared.planHash },
                    validatedPlanHash: prepared.planHash,
                    ...(prepared.capacity === null ? {} : { capacity: toPolicyValue(prepared.capacity) }),
                };
            },
        });
    }
}
