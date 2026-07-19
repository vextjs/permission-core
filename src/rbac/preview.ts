import type { MongoSession } from "monsqlize";
import type {
    AuthorizationCapacityAssessment,
    BatchMutationSummary,
    CountSample,
    ExpectedRevisionVector,
    ImpactPreview,
    ManagementConflict,
    ManagementWarning,
    ManualRuleChange,
    ManualRuleChangePlan,
    ManualRuleInput,
    ManualRuleSelector,
    MutationOptions,
    PermissionScope,
    PermissionRuleInput,
    PolicyValue,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionVectorOptions,
    RoleAccessUpdateInput,
    RoleAccessUpdatePlan,
    RoleRuleReplacePlan,
} from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { SignedTokenCodec } from "../internal/signed-token";
import {
    assertInternalDocumentBudget,
    type InternalRoleDocument,
    type InternalRoleRuleDocument,
    type InternalRoleRuleSource,
} from "../persistence/documents";
import type { PermissionRepository } from "../persistence/repository";
import type { ScopeStateView } from "../persistence/scope-state";
import {
    assessAuthorizationCapacity,
    loadAffectedUsers,
    loadDirectlyBoundUserSample,
    loadRoleDescendantIds,
} from "./capacity";
import { createSemanticKey, MAX_RULE_SOURCES } from "./materialize";
import type { MutationWorkContext } from "./mutation-executor";
import {
    normalizeManualRuleChange,
    normalizeManualRuleList,
    normalizePreviewExecutionOptions,
    normalizePreviewOptions,
    type NormalizedPreviewExecutionOptions,
    type NormalizedPreviewOptions,
} from "./preview-inputs";
import { PREVIEW_TTL_MS, issuePreviewToken, validatePreviewExecution } from "./preview-token";
import { DetailBudgetAllocator, assertAuthorizationResponseBudget, revisionVector } from "./result";
import { RoleMutationService } from "./role-mutations";
import { RuleMutationService, type PreparedRuleSetExecution } from "./rule-mutations";
import { MAX_ROLE_CHAIN_DEPTH, MAX_RULES_PER_ROLE, RbacReadStore, type RbacScopeReader } from "./store";
import { normalizeRoleAccessUpdateInput } from "./inputs";
import { normalizeRbacId } from "./validation";
import { boundedDetails } from "./views";

interface PlanEnvelope<TPlan> {
    readonly plan: TPlan;
    readonly completePlan: PolicyValue;
    readonly capacity: AuthorizationCapacityAssessment;
    readonly summaryCounts: Omit<BatchMutationSummary, "samples">;
    readonly summarySamples: readonly BatchMutationSummary["samples"]["items"][number][];
    readonly expectedRevisions: ExpectedRevisionVector;
    readonly revisions: ReturnType<typeof revisionVector>;
    readonly inputHash: string;
    readonly planHash: string;
}

interface PreparedRulePlan<TPlan> extends PlanEnvelope<TPlan> {
    readonly role: Readonly<InternalRoleDocument>;
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly afterRules: readonly Readonly<InternalRoleRuleDocument>[];
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function manualSource(semanticKey: string): InternalRoleRuleSource {
    return Object.freeze({ kind: "manual", sourceId: `manual:${semanticKey}` });
}

function hasManualSource(rule: Readonly<InternalRoleRuleDocument>) {
    return rule.sources.some((source) => source.kind === "manual");
}

function expectedForRole(state: ScopeStateView, role: Readonly<InternalRoleDocument>): ExpectedRevisionVector {
    return deepFreeze({
        global: state.revision,
        rbac: state.rbacRevision,
        entities: [{ kind: "role" as const, id: role.roleId, revision: role.revision }],
    });
}

function completeCountSample(total: number, sampleIds: readonly string[], digest: string): CountSample {
    return deepFreeze({ total, sampleIds: [...sampleIds], truncated: total > sampleIds.length, digest });
}

function budgetCountSample(value: CountSample, budget: DetailBudgetAllocator): CountSample {
    const items = budget.sample(value.sampleIds, value.total);
    return deepFreeze({
        total: value.total,
        sampleIds: items,
        truncated: value.total > items.length,
        digest: value.digest,
    });
}

function budgetCapacity(value: AuthorizationCapacityAssessment, budget: DetailBudgetAllocator) {
    return deepFreeze({
        ...value,
        affectedUsers: budgetCountSample(value.affectedUsers, budget),
        violatingUsers: budgetCountSample(value.violatingUsers, budget),
    });
}

function previewMessages(capacity: AuthorizationCapacityAssessment) {
    const warnings: ManagementWarning[] = [];
    const conflicts: ManagementConflict[] = [];
    if (capacity.disposition === "ack-required") {
        warnings.push({
            code: "CAPACITY_RISK_ACK_REQUIRED",
            message: "Execution requires explicit acknowledgement of the bounded capacity risk.",
            details: { assessmentDigest: capacity.digest },
        });
    }
    if (capacity.disposition === "blocked") {
        conflicts.push({
            id: "authorization-capacity",
            code: "AUTHORIZATION_CAPACITY_EXCEEDED",
            message: "At least one evaluated subject would exceed an authorization hard limit.",
        });
    }
    return { warnings, conflicts };
}

function publicSummary(
    envelope: PlanEnvelope<unknown>,
    budget: DetailBudgetAllocator,
): BatchMutationSummary {
    return deepFreeze({
        ...envelope.summaryCounts,
        samples: budget.bounded(envelope.summarySamples),
    });
}

function roleRuleSetAccessHint(
    before: readonly Readonly<InternalRoleRuleDocument>[],
    after: readonly Readonly<InternalRoleRuleDocument>[],
): AuthorizationCapacityAssessment["accessDirection"] {
    const set = (rules: readonly Readonly<InternalRoleRuleDocument>[], effect: "allow" | "deny") => new Set(
        rules.filter((rule) => rule.effect === effect).map((rule) => rule.semanticKey),
    );
    const beforeAllow = set(before, "allow");
    const afterAllow = set(after, "allow");
    const beforeDeny = set(before, "deny");
    const afterDeny = set(after, "deny");
    const difference = (left: ReadonlySet<string>, right: ReadonlySet<string>) => [...left].some((key) => !right.has(key));
    const expands = difference(afterAllow, beforeAllow) || difference(beforeDeny, afterDeny);
    const restricts = difference(beforeAllow, afterAllow) || difference(afterDeny, beforeDeny);
    return expands && restricts ? "mixed" : expands ? "expand" : restricts ? "restrict" : "none";
}

function assertAccessPatchAllowed(
    current: Readonly<InternalRoleDocument>,
    patch: Readonly<RoleAccessUpdateInput>,
) {
    if (
        current.status === "deprecated"
        && (
            Object.hasOwn(patch, "parentId")
            || !Object.hasOwn(patch, "status")
            || patch.status === "deprecated"
        )
    ) {
        throw validationError("INVALID_ARGUMENT", "patch", "deprecated role requires an explicit recovery status");
    }
}

async function assertParentChain(reader: RbacScopeReader, roleId: string, parentId: string | null) {
    if (parentId === null) return;
    const seen = new Set([roleId]);
    let currentId: string | null = parentId;
    let totalRoles = 1;
    while (currentId !== null) {
        if (seen.has(currentId)) {
            throw new PermissionCoreError("CIRCULAR_INHERITANCE", "The role parent chain contains a cycle.");
        }
        seen.add(currentId);
        totalRoles += 1;
        if (totalRoles > MAX_ROLE_CHAIN_DEPTH) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "The role parent chain exceeds its depth limit.", {
                details: { kind: "limit-exceeded", origin: "caller-input", limitName: "role-chain-depth", current: totalRoles, max: MAX_ROLE_CHAIN_DEPTH, unit: "depth" },
            });
        }
        const role = await reader.readRole(currentId);
        if (!role) throw new PermissionCoreError("ROLE_NOT_FOUND", `Parent role ${currentId} was not found.`);
        currentId = role.parentId;
    }
}

export class RbacPreviewService {
    private readonly store: RbacReadStore;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly resourceSchemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        private readonly roleMutations: RoleMutationService,
        private readonly ruleMutations: RuleMutationService,
    ) {
        this.store = new RbacReadStore(repository, resourceSchemes);
    }

    private token(
        method: string,
        reader: RbacScopeReader,
        actorId: string,
        envelope: PlanEnvelope<unknown>,
        issuedAt: number,
    ) {
        return issuePreviewToken({
            tokens: this.tokens,
            method,
            actorId,
            scopeKey: reader.state.scopeKey,
            envelope: {
                inputHash: envelope.inputHash,
                planHash: envelope.planHash,
                capacityDigest: envelope.capacity.digest,
                expectedRevisions: toPolicyValue(envelope.expectedRevisions) as Readonly<Record<string, PolicyValue>>,
            },
            issuedAt,
        });
    }

    private validateExecution(
        method: string,
        reader: RbacScopeReader,
        envelope: PlanEnvelope<unknown>,
        options: NormalizedPreviewExecutionOptions,
        now: number,
    ) {
        validatePreviewExecution({
            tokens: this.tokens,
            method,
            scopeKey: reader.state.scopeKey,
            envelope: {
                inputHash: envelope.inputHash,
                planHash: envelope.planHash,
                capacityDigest: envelope.capacity.digest,
                expectedRevisions: toPolicyValue(envelope.expectedRevisions) as Readonly<Record<string, PolicyValue>>,
            },
            options,
            now,
            capacityDisposition: envelope.capacity.disposition,
        });
    }

    private async planAccessUpdate(
        reader: RbacScopeReader,
        roleId: string,
        patch: Readonly<RoleAccessUpdateInput>,
        inputHash: string,
        session?: MongoSession,
    ): Promise<PlanEnvelope<RoleAccessUpdatePlan>> {
        const current = await reader.requireRole(roleId);
        assertAccessPatchAllowed(current, patch);
        const nextStatus = patch.status ?? current.status;
        const nextParentId = Object.hasOwn(patch, "parentId") ? patch.parentId! : current.parentId;
        await assertParentChain(reader, roleId, nextParentId);
        const changed = nextStatus !== current.status || nextParentId !== current.parentId;
        const proposed: InternalRoleDocument = {
            ...current,
            status: nextStatus,
            parentId: nextParentId,
            revision: current.revision + (changed ? 1 : 0),
        };
        const descendants = await loadRoleDescendantIds(this.repository, reader, roleId, session);
        const affected = await loadAffectedUsers(
            this.repository,
            reader,
            [roleId, ...descendants],
            `role-access:${roleId}`,
            session,
        );
        const direct = await loadDirectlyBoundUserSample(this.repository, reader, roleId, session);
        const currentAndNextInactive = current.status !== "enabled" && nextStatus !== "enabled";
        const structuralCapacityNonIncreasing = !changed
            || currentAndNextInactive
            || (current.status === "enabled" && nextStatus !== "enabled")
            || (current.status === nextStatus && current.parentId !== null && nextParentId === null);
        const accessHint: AuthorizationCapacityAssessment["accessDirection"] = !changed || currentAndNextInactive
            ? "none"
            : "mixed";
        const capacity = await assessAuthorizationCapacity({
            repository: this.repository,
            reader,
            affectedUsers: affected,
            overlay: { roles: new Map([[roleId, proposed]]) },
            structuralCapacityNonIncreasing,
            knownCapacityRiskMayBeAcknowledged: false,
            accessHint,
            session,
        });
        const descendantsSample = completeCountSample(
            descendants.length,
            descendants,
            digestCanonical(descendants),
        );
        const directlyBoundUsers = completeCountSample(direct.total, direct.sampleIds, direct.digest);
        const affectedUsers = completeCountSample(affected.total, affected.sampleIds, affected.digest);
        const plan: RoleAccessUpdatePlan = deepFreeze({
            roleId,
            before: { status: current.status, parentId: current.parentId },
            after: { status: nextStatus, parentId: nextParentId },
            descendants: descendantsSample,
            directlyBoundUsers,
            affectedUsers,
        });
        const expectedRevisions = expectedForRole(reader.state, current);
        const completePlan = toPolicyValue({
            roleId,
            before: plan.before,
            after: plan.after,
            descendants: { total: descendants.length, digest: descendantsSample.digest },
            directlyBoundUsers: { total: direct.total, digest: direct.digest },
            affectedUsers: { total: affected.total, digest: affected.digest },
        });
        const planHash = digestCanonical({
            method: "roles.previewAccessUpdate",
            inputHash,
            expectedRevisions,
            completePlan,
            capacityDigest: capacity.digest,
        });
        return deepFreeze({
            plan,
            completePlan,
            capacity,
            summaryCounts: {
                inserted: 0,
                updated: changed ? 1 : 0,
                unchanged: changed ? 0 : 1,
                deleted: 0,
                conflicted: 0,
            },
            summarySamples: [{ id: roleId, outcome: changed ? "updated" : "unchanged" }],
            expectedRevisions,
            revisions: revisionVector(reader.state, [{ kind: "role", id: roleId, revision: current.revision }]),
            inputHash,
            planHash,
        });
    }

    private async prepareRuleChange(
        reader: RbacScopeReader,
        roleId: string,
        change: ReturnType<typeof normalizeManualRuleChange>,
        inputHash: string,
        now: number,
        session?: MongoSession,
    ): Promise<PreparedRulePlan<ManualRuleChangePlan>> {
        const role = await reader.requireRole(roleId);
        if (role.status === "deprecated") {
            throw validationError("INVALID_ARGUMENT", "roleId", "deprecated roles cannot change rules");
        }
        const beforeRules = await reader.readRulesForRole(roleId);
        const byKey = new Map(beforeRules.map((rule) => [rule.semanticKey, rule]));
        const normalizedRule = change.operation === "revoke" ? change.selector : change.rule;
        const effect = change.operation === "revoke" ? change.selector.effect : change.operation;
        const semanticKey = createSemanticKey(effect, normalizedRule.action, normalizedRule.resource, normalizedRule.where);
        const existing = byKey.get(semanticKey);
        let sourceOperation: ManualRuleChangePlan["sourceOperation"] = "noop";
        if (change.operation === "allow" || change.operation === "deny") {
            if (!existing) {
                const created: InternalRoleRuleDocument = {
                    scopeKey: reader.state.scopeKey,
                    scope: reader.state.scope,
                    roleId,
                    effect: change.operation,
                    action: change.rule.action,
                    resource: change.rule.resource,
                    ...(change.rule.where === undefined ? {} : { where: change.rule.where }),
                    semanticKey,
                    sources: Object.freeze([manualSource(semanticKey)]),
                    revision: 1,
                    createdAt: now,
                    updatedAt: now,
                };
                assertInternalDocumentBudget(created);
                byKey.set(semanticKey, created);
                sourceOperation = "insert";
            } else if (!hasManualSource(existing)) {
                if (existing.sources.length >= MAX_RULE_SOURCES) {
                    throw new PermissionCoreError("LIMIT_EXCEEDED", "The semantic rule source limit was reached.", {
                        details: { kind: "limit-exceeded", origin: "caller-input", limitName: "rule-sources", current: existing.sources.length + 1, max: MAX_RULE_SOURCES, unit: "items" },
                    });
                }
                const updated: InternalRoleRuleDocument = {
                    ...existing,
                    sources: Object.freeze([...existing.sources, manualSource(semanticKey)].sort((left, right) => compareUtf8(left.sourceId, right.sourceId))),
                    revision: existing.revision + 1,
                    updatedAt: now,
                };
                assertInternalDocumentBudget(updated);
                byKey.set(semanticKey, updated);
                sourceOperation = "insert";
            }
        } else if (existing && hasManualSource(existing)) {
            const retained = existing.sources.filter((source) => source.kind !== "manual");
            if (retained.length === 0) {
                byKey.delete(semanticKey);
            } else {
                const updated: InternalRoleRuleDocument = {
                    ...existing,
                    sources: Object.freeze(retained),
                    revision: existing.revision + 1,
                    updatedAt: now,
                };
                assertInternalDocumentBudget(updated);
                byKey.set(semanticKey, updated);
            }
            sourceOperation = "delete";
        }
        const afterRules = [...byKey.values()].sort((left, right) => compareUtf8(left.semanticKey, right.semanticKey));
        if (afterRules.length > MAX_RULES_PER_ROLE) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "The role semantic rule limit was reached.", {
                details: { kind: "limit-exceeded", origin: "caller-input", limitName: "rules-per-role", current: afterRules.length, max: MAX_RULES_PER_ROLE, unit: "items" },
            });
        }
        const descendants = await loadRoleDescendantIds(this.repository, reader, roleId, session);
        const affected = await loadAffectedUsers(this.repository, reader, [roleId, ...descendants], `manual-rule:${roleId}`, session);
        const accessHint: AuthorizationCapacityAssessment["accessDirection"] = sourceOperation === "noop"
            ? "none"
            : change.operation === "allow" ? "expand"
                : change.operation === "deny" ? "restrict"
                    : effect === "allow" ? "restrict" : "expand";
        const capacity = await assessAuthorizationCapacity({
            repository: this.repository,
            reader,
            affectedUsers: affected,
            overlay: { rulesByRoleId: new Map([[roleId, afterRules]]) },
            structuralCapacityNonIncreasing: sourceOperation === "noop" || change.operation === "revoke",
            knownCapacityRiskMayBeAcknowledged: sourceOperation !== "noop" && change.operation === "deny",
            accessHint,
            session,
        });
        const affectedUsers = completeCountSample(affected.total, affected.sampleIds, affected.digest);
        const plan: ManualRuleChangePlan = deepFreeze({
            roleId,
            operation: change.operation,
            semanticKey,
            sourceOperation,
            affectedUsers,
        });
        const expectedRevisions = expectedForRole(reader.state, role);
        const completePlan = toPolicyValue({
            roleId,
            operation: change.operation,
            semanticKey,
            sourceOperation,
            affectedUsers: { total: affected.total, digest: affected.digest },
            afterRulesDigest: digestCanonical(afterRules.map((rule) => ({
                semanticKey: rule.semanticKey,
                sourceIds: rule.sources.map((source) => source.sourceId),
            }))),
        });
        const planHash = digestCanonical({
            method: "roles.previewRuleChange",
            inputHash,
            expectedRevisions,
            completePlan,
            capacityDigest: capacity.digest,
        });
        return deepFreeze({
            plan,
            completePlan,
            capacity,
            summaryCounts: {
                inserted: sourceOperation === "insert" ? 1 : 0,
                updated: 0,
                unchanged: sourceOperation === "noop" ? 1 : 0,
                deleted: sourceOperation === "delete" ? 1 : 0,
                conflicted: 0,
            },
            summarySamples: [{
                id: semanticKey,
                outcome: sourceOperation === "insert" ? "inserted" : sourceOperation === "delete" ? "deleted" : "unchanged",
            }],
            expectedRevisions,
            revisions: revisionVector(reader.state, [{ kind: "role", id: roleId, revision: role.revision }]),
            inputHash,
            planHash,
            role,
            beforeRules,
            afterRules,
        });
    }

    private async assertDirectRuleChange(
        context: MutationWorkContext,
        roleId: string,
        change: ReturnType<typeof normalizeManualRuleChange>,
        inputHash: string,
    ) {
        const envelope = await this.prepareRuleChange(
            context.reader,
            roleId,
            change,
            inputHash,
            context.now,
            context.transaction.session,
        );
        const affected = envelope.plan.affectedUsers;
        if (change.operation === "revoke") {
            if (change.selector.effect === "deny" && affected.total > 1_000) {
                throw new PermissionCoreError("PREVIEW_REQUIRED", "High-impact deny removal requires preview.", {
                    details: {
                        kind: "preview-required",
                        reason: "high-impact-deny-removal",
                        previewMethod: "roles.previewRuleChange",
                        affectedTotal: affected.total,
                        affectedDigest: affected.digest,
                    },
                });
            }
            return;
        }
        if (affected.total > 1_000 || envelope.capacity.disposition !== "safe") {
            throw new PermissionCoreError("PREVIEW_REQUIRED", "The rule change requires a capacity preview.", {
                details: {
                    kind: "preview-required",
                    reason: "capacity-risk",
                    previewMethod: "roles.previewRuleChange",
                    affectedTotal: affected.total,
                    affectedDigest: affected.digest,
                },
            });
        }
    }

    allow(
        scope: PermissionScope,
        roleIdInput: string,
        ruleInput: PermissionRuleInput,
        options?: MutationOptions,
    ) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeManualRuleChange({ operation: "allow", rule: ruleInput }, this.resourceSchemes);
        if (change.operation === "revoke") throw new TypeError("allow normalization returned a revoke change");
        const inputHash = digestCanonical({ roleId, change });
        return this.ruleMutations.allow(
            scope,
            roleId,
            change.rule,
            options,
            (context) => this.assertDirectRuleChange(context, roleId, change, inputHash),
        );
    }

    deny(
        scope: PermissionScope,
        roleIdInput: string,
        ruleInput: PermissionRuleInput,
        options?: MutationOptions,
    ) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeManualRuleChange({ operation: "deny", rule: ruleInput }, this.resourceSchemes);
        if (change.operation === "revoke") throw new TypeError("deny normalization returned a revoke change");
        const inputHash = digestCanonical({ roleId, change });
        return this.ruleMutations.deny(
            scope,
            roleId,
            change.rule,
            options,
            (context) => this.assertDirectRuleChange(context, roleId, change, inputHash),
        );
    }

    revoke(
        scope: PermissionScope,
        roleIdInput: string,
        selectorInput: ManualRuleSelector,
        options?: MutationOptions,
    ) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeManualRuleChange({ operation: "revoke", selector: selectorInput }, this.resourceSchemes);
        if (change.operation !== "revoke") throw new TypeError("revoke normalization returned an upsert change");
        const inputHash = digestCanonical({ roleId, change });
        return this.ruleMutations.revoke(
            scope,
            roleId,
            change.selector,
            options,
            (context) => this.assertDirectRuleChange(context, roleId, change, inputHash),
        );
    }

    private async prepareRuleReplacement(
        reader: RbacScopeReader,
        roleId: string,
        rules: ReturnType<typeof normalizeManualRuleList>,
        inputHash: string,
        now: number,
        session?: MongoSession,
    ): Promise<PreparedRulePlan<RoleRuleReplacePlan>> {
        const role = await reader.requireRole(roleId);
        if (role.status === "deprecated") throw validationError("INVALID_ARGUMENT", "roleId", "deprecated roles cannot change rules");
        const beforeRules = await reader.readRulesForRole(roleId);
        const current = new Map(beforeRules.map((rule) => [rule.semanticKey, rule]));
        const desired = new Map(rules.map((rule) => [rule.semanticKey, rule]));
        const after = new Map(current);
        const operations: { semanticKey: string; action: "insert" | "update" | "delete" }[] = [];
        const unchanged: string[] = [];
        for (const rule of rules) {
            const existing = current.get(rule.semanticKey);
            if (!existing) {
                const created: InternalRoleRuleDocument = {
                    scopeKey: reader.state.scopeKey,
                    scope: reader.state.scope,
                    roleId,
                    effect: rule.effect,
                    action: rule.action,
                    resource: rule.resource,
                    ...(rule.where === undefined ? {} : { where: rule.where }),
                    semanticKey: rule.semanticKey,
                    sources: Object.freeze([manualSource(rule.semanticKey)]),
                    revision: 1,
                    createdAt: now,
                    updatedAt: now,
                };
                assertInternalDocumentBudget(created);
                after.set(rule.semanticKey, created);
                operations.push({ semanticKey: rule.semanticKey, action: "insert" });
            } else if (hasManualSource(existing)) {
                unchanged.push(rule.semanticKey);
            } else {
                if (existing.sources.length >= MAX_RULE_SOURCES) {
                    throw new PermissionCoreError("LIMIT_EXCEEDED", "The semantic rule source limit was reached.", {
                        details: { kind: "limit-exceeded", origin: "caller-input", limitName: "rule-sources", current: existing.sources.length + 1, max: MAX_RULE_SOURCES, unit: "items" },
                    });
                }
                const updated: InternalRoleRuleDocument = {
                    ...existing,
                    sources: Object.freeze([...existing.sources, manualSource(rule.semanticKey)].sort((left, right) => compareUtf8(left.sourceId, right.sourceId))),
                    revision: existing.revision + 1,
                    updatedAt: now,
                };
                assertInternalDocumentBudget(updated);
                after.set(rule.semanticKey, updated);
                operations.push({ semanticKey: rule.semanticKey, action: "update" });
            }
        }
        for (const existing of beforeRules) {
            if (!hasManualSource(existing) || desired.has(existing.semanticKey)) continue;
            const retained = existing.sources.filter((source) => source.kind !== "manual");
            if (retained.length === 0) {
                after.delete(existing.semanticKey);
                operations.push({ semanticKey: existing.semanticKey, action: "delete" });
            } else {
                const updated: InternalRoleRuleDocument = {
                    ...existing,
                    sources: Object.freeze(retained),
                    revision: existing.revision + 1,
                    updatedAt: now,
                };
                assertInternalDocumentBudget(updated);
                after.set(existing.semanticKey, updated);
                operations.push({ semanticKey: existing.semanticKey, action: "update" });
            }
        }
        operations.sort((left, right) => compareUtf8(left.semanticKey, right.semanticKey));
        unchanged.sort(compareUtf8);
        const afterRules = [...after.values()].sort((left, right) => compareUtf8(left.semanticKey, right.semanticKey));
        if (afterRules.length > MAX_RULES_PER_ROLE) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "The role semantic rule limit was reached.", {
                details: { kind: "limit-exceeded", origin: "caller-input", limitName: "rules-per-role", current: afterRules.length, max: MAX_RULES_PER_ROLE, unit: "items" },
            });
        }
        const descendants = await loadRoleDescendantIds(this.repository, reader, roleId, session);
        const affected = await loadAffectedUsers(this.repository, reader, [roleId, ...descendants], `replace-rules:${roleId}`, session);
        const accessHint = roleRuleSetAccessHint(beforeRules, afterRules);
        const capacity = await assessAuthorizationCapacity({
            repository: this.repository,
            reader,
            affectedUsers: affected,
            overlay: { rulesByRoleId: new Map([[roleId, afterRules]]) },
            structuralCapacityNonIncreasing: operations.every((operation) => operation.action !== "insert")
                && afterRules.every((rule) => (current.get(rule.semanticKey)?.sources.length ?? 0) >= rule.sources.length),
            knownCapacityRiskMayBeAcknowledged: accessHint === "restrict",
            accessHint,
            session,
        });
        const plan: RoleRuleReplacePlan = deepFreeze({
            roleId,
            operations: {
                total: operations.length,
                items: operations,
                truncated: false,
                digest: digestCanonical(operations),
            },
            unchanged: completeCountSample(unchanged.length, unchanged, digestCanonical(unchanged)),
            affectedUsers: completeCountSample(affected.total, affected.sampleIds, affected.digest),
        });
        const expectedRevisions = expectedForRole(reader.state, role);
        const completePlan = toPolicyValue({
            roleId,
            operations,
            unchangedDigest: digestCanonical(unchanged),
            affectedUsers: { total: affected.total, digest: affected.digest },
            afterRulesDigest: digestCanonical(afterRules.map((rule) => ({ semanticKey: rule.semanticKey, sourceIds: rule.sources.map((source) => source.sourceId) }))),
        });
        const planHash = digestCanonical({
            method: "roles.previewReplaceRules",
            inputHash,
            expectedRevisions,
            completePlan,
            capacityDigest: capacity.digest,
        });
        const inserted = operations.filter((operation) => operation.action === "insert").length;
        const updated = operations.filter((operation) => operation.action === "update").length;
        const deleted = operations.filter((operation) => operation.action === "delete").length;
        return deepFreeze({
            plan,
            completePlan,
            capacity,
            summaryCounts: { inserted, updated, unchanged: unchanged.length, deleted, conflicted: 0 },
            summarySamples: [
                ...operations.map((operation) => ({
                    id: operation.semanticKey,
                    outcome: operation.action === "insert" ? "inserted" as const : operation.action === "delete" ? "deleted" as const : "updated" as const,
                })),
                ...unchanged.map((id) => ({ id, outcome: "unchanged" as const })),
            ].sort((left, right) => compareUtf8(left.outcome, right.outcome) || compareUtf8(left.id, right.id)),
            expectedRevisions,
            revisions: revisionVector(reader.state, [{ kind: "role", id: roleId, revision: role.revision }]),
            inputHash,
            planHash,
            role,
            beforeRules,
            afterRules,
        });
    }

    private buildPreview<TPlan>(
        method: string,
        reader: RbacScopeReader,
        actor: NormalizedPreviewOptions,
        envelope: PlanEnvelope<TPlan>,
        issuedAt: number,
        budgetPlan: (plan: TPlan, budget: DetailBudgetAllocator) => TPlan,
    ): ImpactPreview<TPlan> {
        const budget = new DetailBudgetAllocator();
        const plan = budgetPlan(envelope.plan, budget);
        const capacity = budgetCapacity(envelope.capacity, budget);
        const summary = publicSummary(envelope, budget);
        const messages = previewMessages(envelope.capacity);
        const warnings = budget.bounded(messages.warnings);
        const conflicts = budget.bounded(messages.conflicts);
        const detailBudget = budget.finish({
            plan: envelope.completePlan,
            capacity: envelope.capacity,
            summarySamples: envelope.summarySamples,
            warnings: messages.warnings,
            conflicts: messages.conflicts,
        });
        const executable = envelope.capacity.disposition !== "blocked" && messages.conflicts.length === 0;
        const common = {
            revisions: envelope.revisions,
            summary,
            plan,
            capacity,
            warnings,
            conflicts,
            detailBudget,
        };
        const result: ImpactPreview<TPlan> = executable
            ? {
                executable: true,
                previewToken: this.token(method, reader, actor.actorId, envelope, issuedAt),
                expected: { expectedRevisions: envelope.expectedRevisions },
                ...common,
                expiresAt: issuedAt + PREVIEW_TTL_MS,
            }
            : {
                executable: false,
                previewToken: null,
                expected: null,
                ...common,
                expiresAt: null,
            };
        assertAuthorizationResponseBudget(result);
        return deepFreeze(result);
    }

    async previewAccessUpdate(
        scope: PermissionScope,
        roleIdInput: string,
        patchInput: RoleAccessUpdateInput,
        optionsInput?: PreviewOptions,
    ): Promise<ImpactPreview<RoleAccessUpdatePlan>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const patch = normalizeRoleAccessUpdateInput(patchInput);
        const options = normalizePreviewOptions(optionsInput);
        const inputHash = digestCanonical({ roleId, patch });
        const reader = await this.store.open(scope);
        const envelope = await this.planAccessUpdate(reader, roleId, patch, inputHash);
        await reader.verifyRbacUnchanged();
        const now = await this.repository.getDatabaseTime();
        return this.buildPreview("roles.previewAccessUpdate", reader, options, envelope, now, (plan, budget) => deepFreeze({
            ...plan,
            descendants: budgetCountSample(plan.descendants, budget),
            directlyBoundUsers: budgetCountSample(plan.directlyBoundUsers, budget),
            affectedUsers: budgetCountSample(plan.affectedUsers, budget),
        }));
    }

    async executeAccessUpdate(
        scope: PermissionScope,
        roleIdInput: string,
        patchInput: RoleAccessUpdateInput,
        optionsInput: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const patch = normalizeRoleAccessUpdateInput(patchInput);
        const options = normalizePreviewExecutionOptions(optionsInput, roleId);
        const inputHash = digestCanonical({ roleId, patch });
        const request = toPolicyValue({ roleId, patch, expectedRevisions: options.expectedRevisions });
        return this.roleMutations.executeAccessUpdate(
            scope,
            roleId,
            patch,
            options,
            request,
            async (context: MutationWorkContext) => {
                const envelope = await this.planAccessUpdate(
                    context.reader,
                    roleId,
                    patch,
                    inputHash,
                    context.transaction.session,
                );
                this.validateExecution("roles.previewAccessUpdate", context.reader, envelope, options, context.now);
                return {
                    validatedPlanHash: envelope.planHash,
                    capacity: toPolicyValue(envelope.capacity),
                };
            },
        );
    }

    async previewRuleChange(
        scope: PermissionScope,
        roleIdInput: string,
        changeInput: ManualRuleChange,
        optionsInput?: PreviewOptions,
    ): Promise<ImpactPreview<ManualRuleChangePlan>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeManualRuleChange(changeInput, this.resourceSchemes);
        const options = normalizePreviewOptions(optionsInput);
        const inputHash = digestCanonical({ roleId, change });
        const reader = await this.store.open(scope);
        const now = await this.repository.getDatabaseTime();
        const envelope = await this.prepareRuleChange(reader, roleId, change, inputHash, now);
        await reader.verifyRbacUnchanged();
        return this.buildPreview("roles.previewRuleChange", reader, options, envelope, now, (plan, budget) => deepFreeze({
            ...plan,
            affectedUsers: budgetCountSample(plan.affectedUsers, budget),
        }));
    }

    async executeRuleChange(
        scope: PermissionScope,
        roleIdInput: string,
        changeInput: ManualRuleChange,
        optionsInput: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const change = normalizeManualRuleChange(changeInput, this.resourceSchemes);
        const options = normalizePreviewExecutionOptions(optionsInput, roleId);
        const inputHash = digestCanonical({ roleId, change });
        const request = toPolicyValue({ roleId, change, expectedRevisions: options.expectedRevisions });
        return this.ruleMutations.executeRuleChange(
            scope,
            roleId,
            change,
            options,
            request,
            async (context): Promise<PreparedRuleSetExecution> => {
                const envelope = await this.prepareRuleChange(
                    context.reader,
                    roleId,
                    change,
                    inputHash,
                    context.now,
                    context.transaction.session,
                );
                this.validateExecution("roles.previewRuleChange", context.reader, envelope, options, context.now);
                return {
                    validatedPlanHash: envelope.planHash,
                    capacity: toPolicyValue(envelope.capacity),
                    beforeRules: envelope.beforeRules,
                    afterRules: envelope.afterRules,
                    summary: {
                        ...envelope.summaryCounts,
                        samples: boundedDetails(envelope.summarySamples),
                    },
                };
            },
        );
    }

    async previewReplaceRules(
        scope: PermissionScope,
        roleIdInput: string,
        rulesInput: readonly ManualRuleInput[],
        optionsInput?: PreviewOptions,
    ): Promise<ImpactPreview<RoleRuleReplacePlan>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const rules = normalizeManualRuleList(rulesInput, this.resourceSchemes);
        const options = normalizePreviewOptions(optionsInput);
        const inputHash = digestCanonical({ roleId, rules });
        const reader = await this.store.open(scope);
        const now = await this.repository.getDatabaseTime();
        const envelope = await this.prepareRuleReplacement(reader, roleId, rules, inputHash, now);
        await reader.verifyRbacUnchanged();
        return this.buildPreview("roles.previewReplaceRules", reader, options, envelope, now, (plan, budget) => deepFreeze({
            ...plan,
            operations: budget.bounded(plan.operations.items),
            unchanged: budgetCountSample(plan.unchanged, budget),
            affectedUsers: budgetCountSample(plan.affectedUsers, budget),
        }));
    }

    async replaceRules(
        scope: PermissionScope,
        roleIdInput: string,
        rulesInput: readonly ManualRuleInput[],
        optionsInput: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const rules = normalizeManualRuleList(rulesInput, this.resourceSchemes);
        const options = normalizePreviewExecutionOptions(optionsInput, roleId);
        const inputHash = digestCanonical({ roleId, rules });
        const request = toPolicyValue({ roleId, rules, expectedRevisions: options.expectedRevisions });
        return this.ruleMutations.replaceManualRules(
            scope,
            roleId,
            options,
            request,
            async (context): Promise<PreparedRuleSetExecution> => {
                const envelope = await this.prepareRuleReplacement(
                    context.reader,
                    roleId,
                    rules,
                    inputHash,
                    context.now,
                    context.transaction.session,
                );
                this.validateExecution("roles.previewReplaceRules", context.reader, envelope, options, context.now);
                return {
                    validatedPlanHash: envelope.planHash,
                    capacity: toPolicyValue(envelope.capacity),
                    beforeRules: envelope.beforeRules,
                    afterRules: envelope.afterRules,
                    summary: {
                        ...envelope.summaryCounts,
                        samples: boundedDetails(envelope.summarySamples),
                    },
                };
            },
        );
    }
}
