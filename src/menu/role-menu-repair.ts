import type { MongoSession } from "monsqlize";
import type {
    AuthorizationCapacityAssessment,
    BatchMutationSummary,
    ImpactPreview,
    ManagementConflict,
    MutationResult,
    PermissionRuleInput,
    PermissionScope,
    PolicyValue,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionVectorOptions,
    StaleMenuPermissionRepairInput,
    StaleMenuPermissionRepairPlan,
    StaleMenuPermissionSource,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { SignedTokenCodec } from "../internal/signed-token";
import type {
    InternalRoleMenuGrantDocument,
    InternalRoleRuleDocument,
} from "../persistence/documents";
import type { PermissionRepository } from "../persistence/repository";
import {
    assessAuthorizationCapacity,
    loadAffectedRoleIds,
    loadAffectedUsers,
    type AffectedUsers,
} from "../rbac/capacity";
import { ManagementMutationExecutor, type CacheInvalidator } from "../rbac/mutation-executor";
import {
    normalizeMenuPreviewExecutionOptions,
    normalizePreviewOptions,
} from "../rbac/preview-inputs";
import { DetailBudgetAllocator } from "../rbac/result";
import { RbacScopeReader } from "../rbac/store";
import { normalizeRbacId } from "../rbac/validation";
import { authorizationCacheTargets } from "./impact-support";
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
    resolveRoleMenuRole,
    type RoleMenuInventoryView,
    type RoleMenuRoleResolution,
} from "./role-menu-resolution";
import {
    applySourceRewriteExecution,
    budgetSourceImpacts,
    loadMenuSourceRecords,
    prepareSourceImpacts,
    sourceRewriteConflicts,
    sourceRewriteDecisionDetailCount,
    type MenuSourceRecord,
    type PreparedSourceImpact,
} from "./source-rewrite";
import {
    prepareSourceRewriteExecution,
    type PreparedSourceRewriteExecution,
} from "./source-rewrite-plan";
import { MenuScopeReader } from "./store";
import {
    exactMenuRecord,
    normalizeSourceRewriteDecision,
} from "./validation";
import { decodeBatchMutationSummaryReplay } from "./views";

const PREVIEW_METHOD = "roles.menuPermissions.previewRepairStale";
const MAX_REPAIR_SOURCES = 1_000;

interface PreparedRoleMenuRepair extends PreparedMenuPlan<StaleMenuPermissionRepairPlan> {
    readonly writePlan: PreparedSourceRewriteExecution;
    readonly affectedUsers: AffectedUsers | null;
    readonly changed: boolean;
    readonly result: BatchMutationSummary;
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function repairConflict(id: string, code: string, message: string): ManagementConflict {
    return deepFreeze({ id, code, message });
}

function normalizeInput(value: StaleMenuPermissionRepairInput) {
    const record = exactMenuRecord(value, ["sourceIds", "sourceRewrite"], "input");
    if (!Array.isArray(record.sourceIds)) {
        throw validationError("INVALID_ARGUMENT", "input.sourceIds", "must be an array");
    }
    if (record.sourceIds.length < 1 || record.sourceIds.length > MAX_REPAIR_SOURCES) {
        throw validationError(
            "INVALID_ARGUMENT",
            "input.sourceIds",
            `must contain between 1 and ${MAX_REPAIR_SOURCES} source IDs`,
        );
    }
    const sourceIds = record.sourceIds.map((sourceId, index) => (
        normalizeRbacId(sourceId, `input.sourceIds[${index}]`)
    ));
    if (new Set(sourceIds).size !== sourceIds.length) {
        throw validationError("INVALID_ARGUMENT", "input.sourceIds", "must not contain duplicates");
    }
    sourceIds.sort(compareUtf8);
    return deepFreeze({
        sourceIds: Object.freeze(sourceIds),
        sourceRewrite: normalizeSourceRewriteDecision(record.sourceRewrite as StaleMenuPermissionRepairInput["sourceRewrite"]),
    });
}

function staleImpactReason(reason: StaleMenuPermissionSource["reason"]) {
    if (reason === "permission-changed") return "permission-change" as const;
    if (reason === "selection-drift") return "binding-change" as const;
    return "invalid-reference" as const;
}

function sameProvenance(
    source: MenuSourceRecord["source"],
    candidate: RoleMenuRoleResolution["grants"][number]["contributions"][number],
) {
    return source.contribution === candidate.contribution
        && source.assetId === candidate.assetId
        && (source.contribution !== "api" || source.apiBindingId === candidate.apiBindingId)
        && (source.contribution !== "data" || source.dataResource === candidate.dataResource);
}

function candidateRules(
    record: MenuSourceRecord,
    resolution: RoleMenuRoleResolution,
): readonly Readonly<PermissionRuleInput>[] {
    const grant = resolution.grants.find((candidate) => candidate.document.grantId === record.source.grantId);
    if (grant?.planned === null || grant?.planned === undefined) return Object.freeze([]);
    return Object.freeze(grant.planned.contributions
        .filter((candidate) => sameProvenance(record.source, candidate))
        .map((candidate) => deepFreeze({
            action: candidate.action,
            resource: candidate.resource,
            ...(candidate.where === undefined ? {} : { where: candidate.where }),
        })));
}

function accessHint(input: StaleMenuPermissionRepairInput["sourceRewrite"]): AuthorizationCapacityAssessment["accessDirection"] {
    if (input?.mode !== "apply") return "none";
    const resolutions = Object.values(input.resolutions);
    return resolutions.every((resolution) => resolution.action === "revoke") ? "restrict" : "mixed";
}

export class RoleMenuPermissionRepairService {
    private readonly executor: ManagementMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
    }

    private async roleResolutions(
        rbacReader: RbacScopeReader,
        menuReader: MenuScopeReader,
        roleIds: readonly string[],
    ) {
        const [rolesById, rules, grants, complete] = await Promise.all([
            rbacReader.readRoles(roleIds),
            rbacReader.readRulesForRoles(roleIds),
            menuReader.readGrantsForRoles(roleIds),
            menuReader.readCompleteInventory(),
        ]);
        const inventory: RoleMenuInventoryView = {
            nodesById: new Map(complete.nodes.map((node) => [node.nodeId, node] as const)),
            bindingsById: new Map(complete.bindings.map((binding) => [binding.bindingId, binding] as const)),
            completeNodes: complete.nodes,
            completeBindings: complete.bindings,
        };
        const rulesByRole = new Map(roleIds.map((roleId) => [roleId, [] as Readonly<InternalRoleRuleDocument>[]]));
        for (const rule of rules) rulesByRole.get(rule.roleId)?.push(rule);
        const grantsByRole = new Map(roleIds.map((roleId) => [roleId, [] as Readonly<InternalRoleMenuGrantDocument>[]]));
        for (const grant of grants) grantsByRole.get(grant.roleId)?.push(grant);
        const resolutions = new Map<string, RoleMenuRoleResolution>();
        for (const roleId of roleIds) {
            const role = rolesById.get(roleId);
            if (role === undefined) {
                throw new PermissionCoreError("PERSISTED_STATE_INVALID", `Stale source references missing role ${roleId}.`, {
                    details: { kind: "persisted-state-invalid", stage: "load", reason: "stale-source-role-missing" },
                });
            }
            resolutions.set(roleId, resolveRoleMenuRole({
                role,
                rules: rulesByRole.get(roleId) ?? [],
                grants: grantsByRole.get(roleId) ?? [],
                inventory,
                failOnInvalidReference: false,
            }));
        }
        return resolutions;
    }

    private async prepare(
        rbacReader: RbacScopeReader,
        menuReader: MenuScopeReader,
        input: ReturnType<typeof normalizeInput>,
        now: number,
        session: MongoSession,
    ): Promise<PreparedRoleMenuRepair> {
        const selected = new Set(input.sourceIds);
        const records = await loadMenuSourceRecords({
            repository: this.repository,
            schemes: this.schemes,
            reader: menuReader,
            session,
            mongoFilter: { sources: { $elemMatch: { kind: "menu", sourceId: { $in: input.sourceIds } } } },
            matches: (source) => selected.has(source.sourceId),
        });
        const roleIds = [...new Set(records.map((record) => record.rule.roleId))].sort(compareUtf8);
        const resolutions = await this.roleResolutions(rbacReader, menuReader, roleIds);
        const recordsById = new Map(records.map((record) => [record.source.sourceId, record] as const));
        const conflicts: ManagementConflict[] = [];
        const impacts: PreparedSourceImpact[] = [];

        for (const sourceId of input.sourceIds) {
            const record = recordsById.get(sourceId);
            if (record === undefined) {
                conflicts.push(repairConflict(sourceId, "STALE_SOURCE_NOT_FOUND", "The selected menu source does not exist."));
                continue;
            }
            const resolution = resolutions.get(record.rule.roleId)!;
            const stale = resolution.stale.find((candidate) => candidate.sourceId === sourceId);
            if (stale === undefined) {
                conflicts.push(repairConflict(sourceId, "STALE_SOURCE_CURRENT", "The selected menu source is not stale."));
                continue;
            }
            impacts.push(prepareSourceImpacts(
                [record],
                staleImpactReason(stale.reason),
                (candidate) => candidateRules(candidate, resolution),
            )[0]!);
        }
        impacts.sort((left, right) => compareUtf8(left.record.source.sourceId, right.record.source.sourceId));
        conflicts.push(...sourceRewriteConflicts(impacts, input.sourceRewrite));
        conflicts.sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.id, right.id));

        const writePlan = input.sourceRewrite.mode === "apply" && conflicts.length === 0
            ? await prepareSourceRewriteExecution({
                rbacReader,
                menuReader,
                impacts,
                decision: input.sourceRewrite,
                now,
            })
            : deepFreeze({
                roles: Object.freeze([]),
                beforeRulesByRole: new Map(),
                afterRulesByRole: new Map(),
                sourceMutationCount: 0,
                conflicts: Object.freeze([]),
                auditPlan: toPolicyValue({ sourceMutationCount: 0, roles: [] }),
            });
        conflicts.push(...writePlan.conflicts);
        const changed = input.sourceRewrite.mode === "apply" && impacts.length > 0 && conflicts.length === 0;
        let affectedUsers: AffectedUsers | null = null;
        let capacity: AuthorizationCapacityAssessment | null = null;
        if (changed) {
            const affectedRoleIds = await loadAffectedRoleIds(this.repository, rbacReader, roleIds, session);
            affectedUsers = await loadAffectedUsers(
                this.repository,
                rbacReader,
                affectedRoleIds,
                `role-menu-repair:${digestCanonical(input)}`,
                session,
            );
            capacity = await assessAuthorizationCapacity({
                repository: this.repository,
                reader: rbacReader,
                affectedUsers,
                overlay: { rulesByRoleId: writePlan.afterRulesByRole },
                structuralCapacityNonIncreasing: writePlan.roles.every((plan) => (
                    plan.afterRules.length <= plan.beforeRules.length
                    && plan.afterRules.reduce((total, rule) => total + rule.sources.length, 0)
                        <= plan.beforeRules.reduce((total, rule) => total + rule.sources.length, 0)
                )),
                knownCapacityRiskMayBeAcknowledged: true,
                accessHint: accessHint(input.sourceRewrite),
                session,
            });
        }

        const completeImpacts = impacts.map((impact) => impact.public);
        const completePlan = toPolicyValue({ sourceImpacts: completeImpacts });
        const expectedRevisions = expectedMenuRevisions(menuReader, [], true);
        const inputHash = digestCanonical(input);
        const planHash = menuPlanHash(PREVIEW_METHOD, inputHash, expectedRevisions, completePlan);
        const resolutionsBySource = input.sourceRewrite.mode === "apply" ? input.sourceRewrite.resolutions : {};
        const samples = sortBatchMutationSamples(impacts.map((impact) => ({
            id: impact.record.source.sourceId,
            outcome: resolutionsBySource[impact.record.source.sourceId]?.action === "revoke"
                ? "deleted" as const
                : "updated" as const,
        })));
        const summaryCounts = emptyBatchCounts({
            updated: changed ? samples.filter((sample) => sample.outcome === "updated").length : 0,
            deleted: changed ? samples.filter((sample) => sample.outcome === "deleted").length : 0,
            conflicted: conflicts.length,
        });
        const result: BatchMutationSummary = deepFreeze({
            ...summaryCounts,
            samples: new DetailBudgetAllocator().bounded(changed ? samples : []),
        });
        return {
            method: PREVIEW_METHOD,
            reader: menuReader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: sourceRewriteDecisionDetailCount(impacts),
            publicPlan: (budget) => deepFreeze({ sourceImpacts: budgetSourceImpacts(impacts, budget) }),
            expectedRevisions,
            revisionEntities: Object.freeze([]),
            summaryCounts,
            summarySamples: changed ? samples : Object.freeze([]),
            warnings: Object.freeze([]),
            conflicts: Object.freeze(conflicts),
            capacity,
            writePlan,
            affectedUsers,
            changed,
            result,
        };
    }

    async preview(
        scope: PermissionScope,
        inputValue: StaleMenuPermissionRepairInput,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<StaleMenuPermissionRepairPlan>> {
        const input = normalizeInput(inputValue);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.prepare(
                new RbacScopeReader(this.repository, this.schemes, state, transaction.session),
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                input,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    repair(
        scope: PermissionScope,
        inputValue: StaleMenuPermissionRepairInput,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        const input = normalizeInput(inputValue);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "roles.menuPermissions.repairStale",
            action: "repair",
            resource: "role-menu:stale-sources",
            request: toPolicyValue({ input, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay: decodeBatchMutationSummaryReplay,
            work: async ({ transaction, state, now }) => {
                const rbacReader = new RbacScopeReader(this.repository, this.schemes, state, transaction.session);
                const menuReader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.prepare(rbacReader, menuReader, input, now, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                if (prepared.changed) {
                    await applySourceRewriteExecution({
                        repository: this.repository,
                        schemes: this.schemes,
                        session: transaction.session,
                        prepared: prepared.writePlan,
                    });
                }
                return {
                    changed: prepared.changed,
                    data: prepared.result,
                    primaryRevision: prepared.changed ? state.rbacRevision + 1 : state.rbacRevision,
                    entity: {
                        kind: "scope",
                        id: `rbac:${state.scopeKey}`,
                        before: state.rbacRevision,
                        after: prepared.changed ? state.rbacRevision + 1 : state.rbacRevision,
                    },
                    revisionImpact: { rbac: prepared.changed, menu: false },
                    change: { kind: "role-menu-stale-repair", plan: prepared.completePlan },
                    cacheTargets: prepared.changed && prepared.affectedUsers !== null
                        ? authorizationCacheTargets(state.scopeKey, prepared.affectedUsers)
                        : [],
                    returnedDetails: prepared.result.samples.items.length,
                    completeDetailTree: {
                        totalDetails: prepared.result.samples.total,
                        planHash: prepared.planHash,
                    },
                    validatedPlanHash: prepared.planHash,
                    ...(prepared.capacity === null ? {} : { capacity: toPolicyValue(prepared.capacity) }),
                };
            },
        });
    }
}
