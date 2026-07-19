import type { MongoSession } from "monsqlize";
import type {
    ApiBinding,
    ApiBindingImpact,
    ApiBindingImpactUpdateRequest,
    ApiBindingRemovalPlan,
    ApiBindingRemoveInput,
    ApiBindingReplaceInput,
    ApiBindingReplacePlan,
    ApiBindingRewritePlan,
    ApiBindingStatusPlan,
    AuthorizationCapacityAssessment,
    BatchMutationSummary,
    EntityStatus,
    ImpactPreview,
    ManagementConflict,
    MutationResult,
    PermissionScope,
    PolicyValue,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionVectorOptions,
    VersionedResult,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { SignedTokenCodec } from "../internal/signed-token";
import {
    assertAuditChangeBudget,
    type InternalApiBindingDocument,
    type InternalMenuNodeDocument,
} from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import {
    assessAuthorizationCapacity,
    loadAffectedRoleIds,
    loadAffectedUsers,
    type AffectedUsers,
} from "../rbac/capacity";
import {
    ManagementMutationExecutor,
    type CacheInvalidator,
} from "../rbac/mutation-executor";
import {
    normalizeMenuPreviewExecutionOptions,
    normalizePreviewOptions,
} from "../rbac/preview-inputs";
import { DetailBudgetAllocator, assertAuthorizationResponseBudget, revisionVector } from "../rbac/result";
import { RbacScopeReader } from "../rbac/store";
import { normalizeRbacId } from "../rbac/validation";
import { planMenuAggregate } from "./aggregate";
import {
    apiUpdateDocument,
    databaseWriteFailure,
    readNestedDuplicate,
    revisionConflict,
} from "./api-mutations";
import {
    authorizationCacheTargets,
    budgetCountSample,
    capacityMessages,
    emptyAffectedUsers,
    sampledCountSample,
} from "./impact-support";
import {
    apiBindingDocumentFromInput,
    apiBindingManifestItemFromDocument,
    apiBindingView,
} from "./materialize";
import {
    buildMenuPreview,
    emptyBatchCounts,
    expectedMenuRevisions,
    menuPlanHash,
    sortBatchMutationSamples,
    type PreparedMenuPlan,
    validateMenuExecution,
} from "./mutations";
import {
    applySourceRewriteExecution,
    budgetSourceImpacts,
    createMenuAvailabilityReaders,
    loadMenuSourceRecords,
    prepareSourceImpacts,
    sourceRewriteDecisionDetailCount,
    sourceRewriteConflicts,
    type MenuSourceRecord,
    type PreparedSourceImpact,
} from "./source-rewrite";
import {
    prepareSourceRewriteExecution,
    type PreparedSourceRewriteExecution,
} from "./source-rewrite-plan";
import { MenuScopeReader } from "./store";
import {
    normalizeApiBindingCreateInput,
    normalizeApiBindingImpactUpdateRequest,
    normalizeApiBindingRemoveInput,
    normalizeApiBindingReplaceInput,
    normalizeMenuEntityStatus,
} from "./validation";
import { decodeApiBindingReplay, decodeBatchMutationSummaryReplay } from "./views";

function readOptions(session: MongoSession) {
    return { session, cache: 0, collation: SIMPLE_COLLATION };
}

function insertOptions(session: MongoSession) {
    return { session, cache: { invalidate: false as const } };
}

function writeOptions(session: MongoSession) {
    return { session, cache: { invalidate: false as const }, collation: SIMPLE_COLLATION };
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted API binding source state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function statusDocument(
    current: Readonly<InternalApiBindingDocument>,
    status: EntityStatus,
    state: { scopeKey: string; scope: PermissionScope },
    now: number,
    schemes: ResourceSchemeRegistry,
) {
    const input = normalizeApiBindingCreateInput({
        ...apiBindingManifestItemFromDocument(current),
        status,
    }, schemes);
    return apiBindingDocumentFromInput(
        state.scopeKey,
        state.scope,
        input,
        current.revision + 1,
        current.createdAt,
        now,
    );
}

function previewState(document: Readonly<InternalApiBindingDocument>) {
    const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...state } = apiBindingView(document);
    return deepFreeze(state);
}

function applyImpactPatch(
    current: Readonly<InternalApiBindingDocument>,
    request: ReturnType<typeof normalizeApiBindingImpactUpdateRequest>,
    state: { scopeKey: string; scope: PermissionScope },
    now: number,
    schemes: ResourceSchemeRegistry,
) {
    const candidate: Record<string, unknown> = { ...apiBindingManifestItemFromDocument(current) };
    for (const [key, value] of Object.entries(request.patch)) {
        if (value === null) delete candidate[key];
        else candidate[key] = value;
    }
    const normalized = normalizeApiBindingCreateInput(candidate as never, schemes);
    return apiBindingDocumentFromInput(
        state.scopeKey,
        state.scope,
        normalized,
        current.revision + 1,
        current.createdAt,
        now,
    );
}

function sourceImpactSelector(
    before: Readonly<InternalApiBindingDocument>,
    after: Readonly<InternalApiBindingDocument>,
) {
    const allSources = before.method !== after.method
        || before.path !== after.path
        || canonicalString(before.authorization) !== canonicalString(after.authorization);
    const afterOwnerIds = new Set(after.owners.map((owner) => owner.id));
    const removedOwnerIds = new Set(before.owners
        .map((owner) => owner.id)
        .filter((ownerId) => !afterOwnerIds.has(ownerId)));
    return deepFreeze({
        allSources,
        removedOwnerIds,
        changesAuthorization: allSources || removedOwnerIds.size > 0,
    });
}

function sourceResolutionDirection(
    impacts: readonly PreparedSourceImpact[],
    decision: ReturnType<typeof normalizeApiBindingRemoveInput>["sourceRewrite"],
) {
    let expands = false;
    let restricts = false;
    for (const impact of impacts) {
        const resolution = decision.mode === "apply"
            ? decision.resolutions[impact.record.source.sourceId]
            : undefined;
        if (resolution?.action === "replace" && resolution.replacementSemanticKey !== impact.record.rule.semanticKey) {
            expands = true;
            restricts = true;
        } else if (resolution?.action === "revoke") {
            if (impact.record.rule.effect === "allow") restricts = true;
            else expands = true;
        }
    }
    const accessHint: AuthorizationCapacityAssessment["accessDirection"] = expands && restricts
        ? "mixed"
        : expands ? "expand" : restricts ? "restrict" : "none";
    return deepFreeze({ accessHint, expands, restricts });
}

function sourceMutationSummary(
    impacts: readonly PreparedSourceImpact[],
    decision: ReturnType<typeof normalizeApiBindingRemoveInput>["sourceRewrite"],
    sourceMutationCount: number,
) {
    const revoked = impacts.filter((impact) =>
        decision.mode === "apply"
        && decision.resolutions[impact.record.source.sourceId]?.action === "revoke").length;
    return deepFreeze({ revoked, updated: Math.max(0, sourceMutationCount - revoked) });
}

interface PreparedApiStatusPlan extends PreparedMenuPlan<ApiBindingStatusPlan> {
    readonly current: Readonly<InternalApiBindingDocument>;
    readonly next: Readonly<InternalApiBindingDocument>;
    readonly affectedUsers: AffectedUsers;
}

interface PreparedApiRewritePlan extends PreparedMenuPlan<ApiBindingRewritePlan> {
    readonly current: Readonly<InternalApiBindingDocument>;
    readonly next: Readonly<InternalApiBindingDocument>;
    readonly changed: boolean;
    readonly sourceImpacts: readonly PreparedSourceImpact[];
    readonly sourceRewrite: PreparedSourceRewriteExecution | null;
    readonly affectedUsers: AffectedUsers;
}

interface PreparedApiRemovalPlan extends PreparedMenuPlan<ApiBindingRemovalPlan> {
    readonly current: Readonly<InternalApiBindingDocument>;
    readonly sourceImpacts: readonly PreparedSourceImpact[];
    readonly sourceRewrite: PreparedSourceRewriteExecution | null;
    readonly affectedUsers: AffectedUsers;
}

interface PreparedApiReplacePlan extends PreparedMenuPlan<ApiBindingReplacePlan> {
    readonly inserts: readonly Readonly<InternalApiBindingDocument>[];
    readonly updates: readonly {
        readonly before: Readonly<InternalApiBindingDocument>;
        readonly after: Readonly<InternalApiBindingDocument>;
    }[];
    readonly deletes: readonly Readonly<InternalApiBindingDocument>[];
    readonly unchangedIds: readonly string[];
    readonly targetBindings: readonly Readonly<InternalApiBindingDocument>[];
    readonly sourceImpacts: readonly PreparedSourceImpact[];
    readonly sourceRewrite: PreparedSourceRewriteExecution | null;
    readonly affectedUsers: AffectedUsers;
}

export class ApiBindingImpactMutationService {
    private readonly executor: ManagementMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
    }

    private async loadSourceRecords(
        reader: MenuScopeReader,
        binding: Readonly<InternalApiBindingDocument>,
        session: MongoSession,
    ) {
        return this.loadSourceRecordsForBindings(reader, [binding], session);
    }

    private async loadSourceRecordsForBindings(
        reader: MenuScopeReader,
        bindings: readonly Readonly<InternalApiBindingDocument>[],
        session: MongoSession,
    ) {
        if (bindings.length === 0) {
            return Object.freeze({ records: Object.freeze([] as MenuSourceRecord[]), sourceNodes: new Map() });
        }
        const bindingById = new Map(bindings.map((binding) => [binding.bindingId, binding] as const));
        if (bindingById.size !== bindings.length) persistedInvalid("API source scan received duplicate binding identities");
        const ownerIds = [...new Set(bindings.flatMap((binding) => binding.owners.map((owner) => owner.id)))].sort(compareUtf8);
        const ownerNodes = await reader.readNodesByIds(ownerIds);
        for (const binding of bindings) {
            for (const owner of binding.owners) {
                const node = ownerNodes.get(owner.id);
                if (node === undefined || node.type !== owner.type) {
                    persistedInvalid(`API binding ${binding.bindingId} has an invalid owner relation`);
                }
            }
        }
        const bindingIds = [...bindingById.keys()].sort(compareUtf8);
        const bindingIdSet = new Set(bindingIds);
        const records = await loadMenuSourceRecords({
            repository: this.repository,
            schemes: this.schemes,
            reader,
            session,
            mongoFilter: { "sources.apiBindingId": { $in: bindingIds } },
            matches: (source) => source.contribution === "api" && bindingIdSet.has(source.apiBindingId),
        });
        const sourceNodeIds = [...new Set(records.map((record) => record.source.assetId))].sort(compareUtf8);
        const sourceNodes = await reader.readNodesByIds(sourceNodeIds);
        for (const record of records) {
            if (record.source.contribution !== "api") {
                persistedInvalid(`menu source ${record.source.sourceId} is not an API contribution`);
            }
            const binding = bindingById.get(record.source.apiBindingId);
            if (binding === undefined) persistedInvalid(`menu source ${record.source.sourceId} returned an unexpected API binding`);
            if (record.source.effect !== record.rule.effect) {
                persistedInvalid(`menu source ${record.source.sourceId} effect differs from its semantic rule`);
            }
            if (!binding.owners.some((owner) => owner.id === record.source.assetId)) {
                persistedInvalid(`menu source ${record.source.sourceId} has a mismatched API binding owner`);
            }
            if (!sourceNodes.has(record.source.assetId)) {
                persistedInvalid(`menu source ${record.source.sourceId} references a missing owner node`);
            }
        }
        return Object.freeze({ records, sourceNodes });
    }

    private targetInventoryConflicts(
        bindings: readonly Readonly<InternalApiBindingDocument>[],
        nodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>,
    ) {
        const conflicts: ManagementConflict[] = [];
        const ids = new Set<string>();
        const endpoints = new Map<string, string>();
        const availabilityModes = new Map<string, { mode: "all" | "any"; bindingId: string }>();
        for (const binding of bindings) {
            if (ids.has(binding.bindingId)) {
                conflicts.push({
                    id: `api-binding:${binding.bindingId}`,
                    code: "API_BINDING_ALREADY_EXISTS",
                    message: `The target inventory contains duplicate API binding ${binding.bindingId}.`,
                });
            }
            ids.add(binding.bindingId);
            const endpoint = canonicalString([binding.method, binding.path]);
            const endpointOwner = endpoints.get(endpoint);
            if (endpointOwner !== undefined && endpointOwner !== binding.bindingId) {
                conflicts.push({
                    id: `api-endpoint:${digestCanonical({ method: binding.method, path: binding.path })}`,
                    code: "API_BINDING_ALREADY_EXISTS",
                    message: `${binding.method} ${binding.path} is assigned to more than one API binding.`,
                });
            }
            endpoints.set(endpoint, binding.bindingId);
            for (const owner of binding.owners) {
                const node = nodes.get(owner.id);
                if (node === undefined) {
                    conflicts.push({
                        id: `api-owner:${binding.bindingId}:${owner.id}`,
                        code: "MENU_NOT_FOUND",
                        message: `API owner ${owner.id} does not exist in the target scope.`,
                    });
                    continue;
                }
                if (node.type !== owner.type) {
                    conflicts.push({
                        id: `api-owner:${binding.bindingId}:${owner.id}`,
                        code: "INVALID_ARGUMENT",
                        message: `API owner ${owner.id} is ${node.type}, not ${owner.type}.`,
                    });
                }
                if (owner.availabilityGroup === undefined) continue;
                const key = canonicalString([owner.type, owner.id, owner.availabilityGroup]);
                const current = availabilityModes.get(key);
                if (current !== undefined && current.mode !== owner.availabilityMode) {
                    conflicts.push({
                        id: `api-availability:${digestCanonical({ key })}`,
                        code: "INVALID_ARGUMENT",
                        message: `API availability group ${owner.availabilityGroup} mixes all and any modes.`,
                    });
                } else {
                    availabilityModes.set(key, { mode: owner.availabilityMode!, bindingId: binding.bindingId });
                }
            }
        }
        return Object.freeze(conflicts);
    }

    private async prepareRewrite(
        reader: MenuScopeReader,
        impacts: readonly PreparedSourceImpact[],
        decision: ReturnType<typeof normalizeApiBindingRemoveInput>["sourceRewrite"],
        now: number,
        session: MongoSession,
        digestOwner: string,
    ) {
        let affectedUsers = emptyAffectedUsers(digestOwner);
        if (impacts.length === 0) {
            return Object.freeze({
                execution: null,
                affectedUsers,
                capacity: null,
                warnings: Object.freeze([]),
                conflicts: Object.freeze([]),
            });
        }
        const rbacReader = new RbacScopeReader(this.repository, this.schemes, reader.state, session);
        const execution = await prepareSourceRewriteExecution({
            rbacReader,
            menuReader: reader,
            impacts,
            decision,
            now,
        });
        if (execution.conflicts.length > 0) {
            return Object.freeze({
                execution,
                affectedUsers,
                capacity: null,
                warnings: Object.freeze([]),
                conflicts: execution.conflicts,
            });
        }
        const sourceRoleIds = [...new Set(impacts.map((impact) => impact.record.rule.roleId))].sort(compareUtf8);
        const affectedRoleIds = await loadAffectedRoleIds(this.repository, rbacReader, sourceRoleIds, session);
        affectedUsers = affectedRoleIds.length === 0
            ? affectedUsers
            : await loadAffectedUsers(this.repository, rbacReader, affectedRoleIds, digestOwner, session);
        const direction = sourceResolutionDirection(impacts, decision);
        const availabilityReaders = createMenuAvailabilityReaders({
            rbacReader,
            menuReader: reader,
            after: { rules: execution.afterRulesByRole },
        });
        const onlyRevokes = impacts.every((impact) =>
            decision.mode === "apply"
            && decision.resolutions[impact.record.source.sourceId]?.action === "revoke");
        const capacity = await assessAuthorizationCapacity({
            repository: this.repository,
            reader: rbacReader,
            affectedUsers,
            overlay: {},
            beforeReader: availabilityReaders.before,
            afterReader: availabilityReaders.after,
            structuralCapacityNonIncreasing: onlyRevokes,
            knownCapacityRiskMayBeAcknowledged: false,
            accessHint: direction.accessHint,
            session,
        });
        const messages = capacityMessages(capacity);
        return Object.freeze({
            execution,
            affectedUsers,
            capacity,
            warnings: messages.warnings,
            conflicts: messages.conflicts,
        });
    }

    private async prepareReplaceEffects(input: {
        readonly reader: MenuScopeReader;
        readonly records: readonly MenuSourceRecord[];
        readonly sourceNodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
        readonly impacts: readonly PreparedSourceImpact[];
        readonly decision: ReturnType<typeof normalizeApiBindingReplaceInput>["sourceRewrite"];
        readonly updatesById: ReadonlyMap<string, {
            readonly before: Readonly<InternalApiBindingDocument>;
            readonly after: Readonly<InternalApiBindingDocument>;
        }>;
        readonly now: number;
        readonly session: MongoSession;
    }) {
        let affectedUsers = emptyAffectedUsers("api-binding-replace");
        const rbacReader = new RbacScopeReader(this.repository, this.schemes, input.reader.state, input.session);
        const execution = input.impacts.length === 0
            ? null
            : await prepareSourceRewriteExecution({
                rbacReader,
                menuReader: input.reader,
                impacts: input.impacts,
                decision: input.decision,
                now: input.now,
            });
        if (execution !== null && execution.conflicts.length > 0) {
            return Object.freeze({
                execution,
                affectedUsers,
                capacity: null,
                warnings: Object.freeze([]),
                conflicts: execution.conflicts,
            });
        }
        if (input.records.length === 0) {
            return Object.freeze({
                execution,
                affectedUsers,
                capacity: null,
                warnings: Object.freeze([]),
                conflicts: Object.freeze([]),
            });
        }
        const sourceRoleIds = [...new Set(input.records.map((record) => record.rule.roleId))].sort(compareUtf8);
        const affectedRoleIds = await loadAffectedRoleIds(this.repository, rbacReader, sourceRoleIds, input.session);
        affectedUsers = affectedRoleIds.length === 0
            ? affectedUsers
            : await loadAffectedUsers(
                this.repository,
                rbacReader,
                affectedRoleIds,
                "api-binding-replace",
                input.session,
            );
        const direction = sourceResolutionDirection(input.impacts, input.decision);
        let expands = direction.expands;
        let restricts = direction.restricts;
        let statusActivations = false;
        const impactSourceIds = new Set(input.impacts.map((impact) => impact.record.source.sourceId));
        for (const record of input.records) {
            const update = record.source.contribution === "api"
                ? input.updatesById.get(record.source.apiBindingId)
                : undefined;
            if (update === undefined || update.before.status === update.after.status) continue;
            if (!update.after.owners.some((owner) => owner.id === record.source.assetId)) continue;
            const resolution = input.decision.mode === "apply" && impactSourceIds.has(record.source.sourceId)
                ? input.decision.resolutions[record.source.sourceId]
                : undefined;
            if (resolution?.action === "revoke") continue;
            if (input.sourceNodes.get(record.source.assetId)?.status !== "enabled") continue;
            const beforeActive = update.before.status === "enabled";
            const afterActive = update.after.status === "enabled";
            if (beforeActive === afterActive) continue;
            if (afterActive) {
                statusActivations = true;
                if (record.rule.effect === "allow") expands = true;
                else restricts = true;
            } else if (record.rule.effect === "allow") {
                restricts = true;
            } else {
                expands = true;
            }
        }
        const accessHint: AuthorizationCapacityAssessment["accessDirection"] = expands && restricts
            ? "mixed"
            : expands ? "expand" : restricts ? "restrict" : "none";
        const afterBindings = new Map([...input.updatesById].map(([bindingId, update]) => [
            bindingId,
            update.after.status,
        ] as const));
        const availabilityReaders = createMenuAvailabilityReaders({
            rbacReader,
            menuReader: input.reader,
            after: {
                ...(execution === null ? {} : { rules: execution.afterRulesByRole }),
                bindings: afterBindings,
            },
        });
        const onlyRevokes = input.impacts.every((impact) =>
            input.decision.mode === "apply"
            && input.decision.resolutions[impact.record.source.sourceId]?.action === "revoke");
        const capacity = await assessAuthorizationCapacity({
            repository: this.repository,
            reader: rbacReader,
            affectedUsers,
            overlay: {},
            beforeReader: availabilityReaders.before,
            afterReader: availabilityReaders.after,
            structuralCapacityNonIncreasing: onlyRevokes && !statusActivations,
            knownCapacityRiskMayBeAcknowledged: false,
            accessHint,
            session: input.session,
        });
        const messages = capacityMessages(capacity);
        return Object.freeze({
            execution,
            affectedUsers,
            capacity,
            warnings: messages.warnings,
            conflicts: messages.conflicts,
        });
    }

    private async planReplace(
        reader: MenuScopeReader,
        input: ReturnType<typeof normalizeApiBindingReplaceInput>,
        now: number,
        session: MongoSession,
    ): Promise<PreparedApiReplacePlan> {
        const inventory = await reader.readCompleteInventory();
        const currentById = new Map(inventory.bindings.map((binding) => [binding.bindingId, binding] as const));
        const allTargetDocuments = input.bindings.map((binding) => {
            const current = currentById.get(binding.id);
            return apiBindingDocumentFromInput(
                reader.state.scopeKey,
                reader.state.scope,
                binding,
                current === undefined ? 1 : current.revision + 1,
                current?.createdAt ?? now,
                now,
            );
        });
        const firstTargetById = new Map<string, Readonly<InternalApiBindingDocument>>();
        for (const document of allTargetDocuments) {
            if (!firstTargetById.has(document.bindingId)) firstTargetById.set(document.bindingId, document);
        }
        const targetById = new Map<string, Readonly<InternalApiBindingDocument>>();
        for (const [bindingId, candidate] of firstTargetById) {
            const current = currentById.get(bindingId);
            const normalized = current !== undefined
                && canonicalString(apiBindingManifestItemFromDocument(current)) === canonicalString(apiBindingManifestItemFromDocument(candidate))
                ? current
                : candidate;
            targetById.set(bindingId, normalized);
        }
        const targetBindings = [...targetById.values()].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        const inserts = targetBindings
            .filter((binding) => !currentById.has(binding.bindingId));
        const updates = targetBindings.flatMap((after) => {
            const before = currentById.get(after.bindingId);
            if (before === undefined || before === after) return [];
            return [{ before, after }];
        });
        const deletes = inventory.bindings
            .filter((binding) => !targetById.has(binding.bindingId));
        const unchangedIds = targetBindings
            .filter((binding) => currentById.get(binding.bindingId) === binding)
            .map((binding) => binding.bindingId);
        inserts.sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        updates.sort((left, right) => compareUtf8(left.before.bindingId, right.before.bindingId));
        deletes.sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        unchangedIds.sort(compareUtf8);
        const operations = [
            ...inserts.map((binding) => ({ bindingId: binding.bindingId, action: "insert" as const })),
            ...updates.map((update) => ({ bindingId: update.before.bindingId, action: "update" as const })),
            ...deletes.map((binding) => ({ bindingId: binding.bindingId, action: "delete" as const })),
        ].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        const nodes = new Map(inventory.nodes.map((node) => [node.nodeId, node] as const));
        const conflicts: ManagementConflict[] = [...this.targetInventoryConflicts(allTargetDocuments, nodes)];
        const bindingMutationCount = operations.length;
        if (bindingMutationCount > 1_000) {
            conflicts.push({
                id: "api-binding-replace-capacity",
                code: "LIMIT_EXCEEDED",
                message: `API binding replacement requires ${bindingMutationCount} binding mutations; the atomic limit is 1000.`,
            });
        }

        const updatesById = new Map(updates.map((update) => [update.before.bindingId, update] as const));
        const selectorsById = new Map(updates.map((update) => [
            update.before.bindingId,
            sourceImpactSelector(update.before, update.after),
        ] as const));
        const readsRbac = deletes.length > 0 || updates.some((update) => {
            const selector = selectorsById.get(update.before.bindingId)!;
            return selector.changesAuthorization || update.before.status !== update.after.status;
        });
        const sourceRelevantBindings = bindingMutationCount > 1_000
            ? []
            : [
                ...deletes,
                ...updates
                    .filter((update) => {
                        const selector = selectorsById.get(update.before.bindingId)!;
                        return selector.changesAuthorization || update.before.status !== update.after.status;
                    })
                    .map((update) => update.before),
            ];
        const loaded = await this.loadSourceRecordsForBindings(reader, sourceRelevantBindings, session);
        const deletedIds = new Set(deletes.map((binding) => binding.bindingId));
        const deletionRecords = loaded.records.filter((record) =>
            record.source.contribution === "api" && deletedIds.has(record.source.apiBindingId));
        const updateRecords = loaded.records.filter((record) => {
            if (record.source.contribution !== "api") return false;
            const selector = selectorsById.get(record.source.apiBindingId);
            return selector !== undefined
                && (selector.allSources || selector.removedOwnerIds.has(record.source.assetId));
        });
        const sourceImpacts = [
            ...prepareSourceImpacts(deletionRecords, "asset-remove", () => []),
            ...prepareSourceImpacts(updateRecords, "binding-change", (record) => {
                if (record.source.contribution !== "api") return [];
                const update = updatesById.get(record.source.apiBindingId);
                if (update === undefined || !update.after.owners.some((owner) => owner.id === record.source.assetId)) return [];
                return update.after.authorization.permissions;
            }),
        ].sort((left, right) => compareUtf8(left.record.source.sourceId, right.record.source.sourceId));
        conflicts.push(...sourceRewriteConflicts(sourceImpacts, input.sourceRewrite));

        let sourceRewrite: PreparedSourceRewriteExecution | null = null;
        let affectedUsers = emptyAffectedUsers("api-binding-replace");
        let capacity: AuthorizationCapacityAssessment | null = null;
        let warnings = Object.freeze([] as ReturnType<typeof capacityMessages>["warnings"]);
        if (conflicts.length === 0 && loaded.records.length > 0) {
            const effects = await this.prepareReplaceEffects({
                reader,
                records: loaded.records,
                sourceNodes: loaded.sourceNodes,
                impacts: sourceImpacts,
                decision: input.sourceRewrite,
                updatesById,
                now,
                session,
            });
            sourceRewrite = effects.execution;
            affectedUsers = effects.affectedUsers;
            capacity = effects.capacity;
            warnings = effects.warnings;
            conflicts.push(...effects.conflicts);
        }
        const estimatedSourceMutations = sourceRewrite?.sourceMutationCount ?? sourceImpacts.length;
        const mutationCount = bindingMutationCount + estimatedSourceMutations;
        if (bindingMutationCount <= 1_000 && mutationCount > 1_000) {
            conflicts.push({
                id: "api-binding-replace-total-capacity",
                code: "LIMIT_EXCEEDED",
                message: `API binding replacement requires ${mutationCount} binding and source mutations; the atomic limit is 1000.`,
            });
        }
        const unchanged = sampledCountSample(unchangedIds);
        const completeOperations = [
            ...inserts.map((after) => ({ bindingId: after.bindingId, action: "insert", before: null, after: previewState(after) })),
            ...updates.map(({ before, after }) => ({
                bindingId: before.bindingId,
                action: "update",
                before: previewState(before),
                after: previewState(after),
            })),
            ...deletes.map((before) => ({ bindingId: before.bindingId, action: "delete", before: previewState(before), after: null })),
        ].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        const completePlan = toPolicyValue({
            inputDigest: digestCanonical(input),
            sourceRewriteDecision: input.sourceRewrite,
            operations: completeOperations,
            unchanged,
            sourceImpacts: sourceImpacts.map((impact) => impact.public),
            sourceRewrite: sourceRewrite?.auditPlan ?? null,
            capacityDigest: capacity?.digest ?? null,
        });
        try {
            assertAuditChangeBudget({ kind: "api-binding-replace", plan: completePlan });
        } catch (error) {
            if (!(error instanceof PermissionCoreError) || error.code !== "LIMIT_EXCEEDED") throw error;
            conflicts.push({
                id: "api-binding-replace-audit-budget",
                code: "LIMIT_EXCEEDED",
                message: "The complete API binding replacement audit diff exceeds its atomic byte budget.",
            });
        }
        const inputHash = digestCanonical({ input });
        const revisionEntities = [{ kind: "scope" as const, id: reader.state.scopeKey, revision: reader.state.revision }];
        const expectedRevisions = expectedMenuRevisions(
            reader,
            revisionEntities,
            readsRbac,
        );
        const planHash = menuPlanHash("apiBindings.previewReplace", inputHash, expectedRevisions, completePlan);
        const sourceSummary = sourceMutationSummary(sourceImpacts, input.sourceRewrite, estimatedSourceMutations);
        const summarySamples: BatchMutationSummary["samples"]["items"] = [
            ...inserts.map((binding) => ({ id: binding.bindingId, outcome: "inserted" as const })),
            ...updates.map((update) => ({ id: update.before.bindingId, outcome: "updated" as const })),
            ...unchangedIds.map((bindingId) => ({ id: bindingId, outcome: "unchanged" as const })),
            ...deletes.map((binding) => ({ id: binding.bindingId, outcome: "deleted" as const })),
            ...sourceImpacts.map((impact) => ({
                id: impact.record.source.sourceId,
                outcome: input.sourceRewrite.mode === "reject"
                    ? "conflicted" as const
                    : input.sourceRewrite.resolutions[impact.record.source.sourceId]?.action === "revoke"
                        ? "deleted" as const
                        : "updated" as const,
            })),
        ];
        return {
            method: "apiBindings.previewReplace",
            reader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: sourceRewriteDecisionDetailCount(sourceImpacts),
            publicPlan: (budget) => {
                const publicSourceImpacts = budgetSourceImpacts(sourceImpacts, budget);
                return deepFreeze({
                    operations: budget.bounded(operations),
                    unchanged: budgetCountSample(unchanged, budget),
                    sourceImpacts: publicSourceImpacts,
                });
            },
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts({
                inserted: inserts.length,
                updated: updates.length + sourceSummary.updated,
                unchanged: unchangedIds.length,
                deleted: deletes.length + sourceSummary.revoked,
                conflicted: conflicts.length,
            }),
            summarySamples,
            warnings,
            conflicts,
            capacity,
            inserts,
            updates,
            deletes,
            unchangedIds,
            targetBindings,
            sourceImpacts,
            sourceRewrite,
            affectedUsers,
        };
    }

    async previewReplace(
        scope: PermissionScope,
        inputValue: ApiBindingReplaceInput,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<ApiBindingReplacePlan>> {
        const input = normalizeApiBindingReplaceInput(inputValue, this.schemes);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planReplace(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                input,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async replace(
        scope: PermissionScope,
        inputValue: ApiBindingReplaceInput,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        const input = normalizeApiBindingReplaceInput(inputValue, this.schemes);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
                scope,
                operation: "apiBindings.replace",
                action: "replace",
                resource: "api-binding:*",
                request: toPolicyValue({ input, expectedRevisions: options.expectedRevisions }),
                options,
                decodeReplay: decodeBatchMutationSummaryReplay,
                replayDetails: (data) => ({
                    returned: data.samples.items.length,
                    total: data.samples.total,
                    tree: toPolicyValue({ samples: data.samples }),
                }),
                work: async ({ transaction, state, now }) => {
                    const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                    const prepared = await this.planReplace(reader, input, now, transaction.session);
                    validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                    const data: BatchMutationSummary = deepFreeze({
                        ...prepared.summaryCounts,
                        samples: new DetailBudgetAllocator().bounded(sortBatchMutationSamples(prepared.summarySamples)),
                    });
                    const changed = prepared.inserts.length > 0 || prepared.updates.length > 0 || prepared.deletes.length > 0;
                    if (!changed) {
                        return {
                            changed: false,
                            data,
                            primaryRevision: state.revision,
                            entity: { kind: "scope", id: state.scopeKey, before: state.revision, after: state.revision },
                            revisionImpact: { rbac: false, menu: false },
                            change: { kind: "api-binding-replace", plan: prepared.completePlan },
                            cacheTargets: [],
                            validatedPlanHash: prepared.planHash,
                            capacity: toPolicyValue(prepared.capacity),
                        };
                    }
                    const aggregate = planMenuAggregate({
                        state,
                        beforeBindings: [
                            ...prepared.deletes,
                            ...prepared.updates.map((update) => update.before),
                        ],
                        afterBindings: [
                            ...prepared.inserts,
                            ...prepared.updates.map((update) => update.after),
                        ],
                    });
                    const removed = [
                        ...prepared.deletes,
                        ...prepared.updates.map((update) => update.before),
                    ].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
                    for (const binding of removed) {
                        const result = await this.repository.collections.apiBindings.deleteOne(
                            { scopeKey: state.scopeKey, bindingId: binding.bindingId, revision: binding.revision },
                            writeOptions(transaction.session),
                        );
                        if (result.deletedCount !== 1) revisionConflict(`api-binding:${binding.bindingId}`, binding.revision);
                    }
                    const inserted = [
                        ...prepared.inserts,
                        ...prepared.updates.map((update) => update.after),
                    ].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
                    for (const binding of inserted) {
                        let result;
                        try {
                            result = await this.repository.collections.apiBindings.insertOne(
                                { ...binding },
                                insertOptions(transaction.session),
                            );
                        } catch (error) {
                            if (readNestedDuplicate(error)) {
                                throw new PermissionCoreError(
                                    "API_BINDING_ALREADY_EXISTS",
                                    "The API binding replacement conflicts with an existing ID or endpoint.",
                                    { cause: error },
                                );
                            }
                            throw error;
                        }
                        if (result.acknowledged !== true) databaseWriteFailure(`API binding ${binding.bindingId} replacement insert was not acknowledged`);
                    }
                    if (prepared.sourceRewrite !== null) {
                        await applySourceRewriteExecution({
                            repository: this.repository,
                            schemes: this.schemes,
                            session: transaction.session,
                            prepared: prepared.sourceRewrite,
                        });
                    }
                    for (const binding of prepared.deletes) {
                        if (await reader.readBinding(binding.bindingId) !== null) {
                            databaseWriteFailure(`deleted API binding ${binding.bindingId} is still visible in the transaction`);
                        }
                    }
                    for (const binding of inserted) {
                        const postImage = await reader.requireBinding(binding.bindingId);
                        if (canonicalString(postImage) !== canonicalString(binding)) {
                            databaseWriteFailure(`API binding ${binding.bindingId} post-image differs from the replacement plan`);
                        }
                    }
                    const postCount = await this.repository.collections.apiBindings.count(
                        { scopeKey: state.scopeKey },
                        readOptions(transaction.session),
                    );
                    if (postCount !== prepared.targetBindings.length) {
                        databaseWriteFailure("API binding replacement post-count differs from the complete target inventory");
                    }
                    const changesRbac = prepared.sourceRewrite !== null && prepared.sourceRewrite.roles.length > 0;
                    const affectsAuthorization = prepared.capacity !== null;
                    return {
                        changed: true,
                        data,
                        primaryRevision: state.revision + 1,
                        entity: { kind: "scope", id: state.scopeKey, before: state.revision, after: state.revision + 1 },
                        revisionImpact: { rbac: changesRbac, menu: true },
                        scopeAggregate: aggregate,
                        change: { kind: "api-binding-replace", plan: prepared.completePlan },
                        cacheTargets: affectsAuthorization
                            ? authorizationCacheTargets(state.scopeKey, prepared.affectedUsers)
                            : [`scope:${state.scopeKey}:menu`],
                        validatedPlanHash: prepared.planHash,
                        capacity: toPolicyValue(prepared.capacity),
                    };
                },
            });
    }

    private async planImpactUpdate(
        reader: MenuScopeReader,
        bindingId: string,
        request: ReturnType<typeof normalizeApiBindingImpactUpdateRequest>,
        now: number,
        session: MongoSession,
    ): Promise<PreparedApiRewritePlan> {
        const inventory = await reader.readCompleteInventory();
        const current = inventory.bindings.find((binding) => binding.bindingId === bindingId);
        if (current === undefined) {
            throw new PermissionCoreError("API_BINDING_NOT_FOUND", `API binding ${bindingId} was not found.`);
        }
        if (current.status === "deprecated") {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated API bindings can only be restored through setStatus.", {
                details: { kind: "validation", field: "bindingId", reason: "API binding is deprecated" },
            });
        }
        const candidate = applyImpactPatch(current, request, reader.state, now, this.schemes);
        const changed = canonicalString(apiBindingManifestItemFromDocument(current))
            !== canonicalString(apiBindingManifestItemFromDocument(candidate));
        const next = changed ? candidate : current;
        const targetBindings = inventory.bindings.map((binding) => binding.bindingId === bindingId ? next : binding);
        const nodes = new Map(inventory.nodes.map((node) => [node.nodeId, node] as const));
        const conflicts: ManagementConflict[] = [...this.targetInventoryConflicts(targetBindings, nodes)];
        const selector = sourceImpactSelector(current, next);
        const loaded = selector.changesAuthorization
            ? await this.loadSourceRecords(reader, current, session)
            : { records: Object.freeze([] as MenuSourceRecord[]), sourceNodes: new Map() };
        const affectedRecords = loaded.records.filter((record) =>
            selector.allSources || selector.removedOwnerIds.has(record.source.assetId));
        const sourceImpacts = prepareSourceImpacts(affectedRecords, "binding-change", (record) =>
            next.owners.some((owner) => owner.id === record.source.assetId)
                ? next.authorization.permissions
                : []);
        conflicts.push(...sourceRewriteConflicts(sourceImpacts, request.sourceRewrite));

        let sourceRewrite: PreparedSourceRewriteExecution | null = null;
        let affectedUsers = emptyAffectedUsers(`api-binding-update:${bindingId}`);
        let capacity: AuthorizationCapacityAssessment | null = null;
        let warnings = Object.freeze([] as ReturnType<typeof capacityMessages>["warnings"]);
        if (conflicts.length === 0 && sourceImpacts.length > 0) {
            const preparedRewrite = await this.prepareRewrite(
                reader,
                sourceImpacts,
                request.sourceRewrite,
                now,
                session,
                `api-binding-update:${bindingId}`,
            );
            sourceRewrite = preparedRewrite.execution;
            affectedUsers = preparedRewrite.affectedUsers;
            capacity = preparedRewrite.capacity;
            warnings = preparedRewrite.warnings;
            conflicts.push(...preparedRewrite.conflicts);
        }
        const estimatedSourceMutations = sourceRewrite?.sourceMutationCount ?? sourceImpacts.length;
        const mutationCount = (changed ? 1 : 0) + estimatedSourceMutations;
        if (mutationCount > 1_000) {
            conflicts.push({
                id: "api-binding-update-capacity",
                code: "LIMIT_EXCEEDED",
                message: `API binding update requires ${mutationCount} mutations; the atomic limit is 1000.`,
            });
        }
        const before = previewState(current);
        const after = previewState(next);
        const completePlan = toPolicyValue({
            bindingId,
            request,
            before,
            after,
            sourceImpacts: sourceImpacts.map((impact) => impact.public),
            sourceRewrite: sourceRewrite?.auditPlan ?? null,
            capacityDigest: capacity?.digest ?? null,
        });
        try {
            assertAuditChangeBudget({ kind: "api-binding-impact-update", plan: completePlan });
        } catch (error) {
            if (!(error instanceof PermissionCoreError) || error.code !== "LIMIT_EXCEEDED") throw error;
            conflicts.push({
                id: "api-binding-update-audit-budget",
                code: "LIMIT_EXCEEDED",
                message: "The complete API binding update audit diff exceeds its atomic byte budget.",
            });
        }
        const inputHash = digestCanonical({ bindingId, request });
        const revisionEntities = [{ kind: "api-binding" as const, id: bindingId, revision: current.revision }];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities, selector.changesAuthorization);
        const planHash = menuPlanHash("apiBindings.previewUpdate", inputHash, expectedRevisions, completePlan);
        const sourceSummary = sourceMutationSummary(sourceImpacts, request.sourceRewrite, estimatedSourceMutations);
        const summarySamples: BatchMutationSummary["samples"]["items"] = [
            { id: bindingId, outcome: changed ? "updated" : "unchanged" },
            ...sourceImpacts.map((impact) => ({
                id: impact.record.source.sourceId,
                outcome: request.sourceRewrite.mode === "reject"
                    ? "conflicted" as const
                    : request.sourceRewrite.resolutions[impact.record.source.sourceId]?.action === "revoke"
                        ? "deleted" as const
                        : "updated" as const,
            })),
        ];
        return {
            method: "apiBindings.previewUpdate",
            reader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: sourceRewriteDecisionDetailCount(sourceImpacts),
            publicPlan: (budget) => deepFreeze({
                bindingId,
                request,
                before,
                after,
                sourceImpacts: budgetSourceImpacts(sourceImpacts, budget),
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts({
                updated: (changed ? 1 : 0) + sourceSummary.updated,
                unchanged: changed ? 0 : 1,
                deleted: sourceSummary.revoked,
                conflicted: conflicts.length,
            }),
            summarySamples,
            warnings,
            conflicts,
            capacity,
            current,
            next,
            changed,
            sourceImpacts,
            sourceRewrite,
            affectedUsers,
        };
    }

    async previewUpdate(
        scope: PermissionScope,
        bindingIdInput: string,
        requestValue: ApiBindingImpactUpdateRequest,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<ApiBindingRewritePlan>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const request = normalizeApiBindingImpactUpdateRequest(requestValue, this.schemes);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planImpactUpdate(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                bindingId,
                request,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async executeUpdate(
        scope: PermissionScope,
        bindingIdInput: string,
        requestValue: ApiBindingImpactUpdateRequest,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<ApiBinding>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const request = normalizeApiBindingImpactUpdateRequest(requestValue, this.schemes);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
                scope,
                operation: "apiBindings.executeUpdate",
                action: "update",
                resource: `api-binding:${bindingId}`,
                request: toPolicyValue({ bindingId, request, expectedRevisions: options.expectedRevisions }),
                options,
                decodeReplay: (value) => decodeApiBindingReplay(value, this.schemes),
                work: async ({ transaction, state, now }) => {
                    const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                    const prepared = await this.planImpactUpdate(reader, bindingId, request, now, transaction.session);
                    validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                    if (!prepared.changed) {
                        const data = apiBindingView(prepared.current);
                        return {
                            changed: false,
                            data,
                            primaryRevision: prepared.current.revision,
                            entity: { kind: "api-binding", id: bindingId, before: prepared.current.revision, after: prepared.current.revision },
                            revisionImpact: { rbac: false, menu: false },
                            change: { kind: "api-binding-impact-update", plan: prepared.completePlan },
                            cacheTargets: [],
                            validatedPlanHash: prepared.planHash,
                            capacity: toPolicyValue(prepared.capacity),
                        };
                    }
                    const aggregate = planMenuAggregate({
                        state,
                        beforeBindings: [prepared.current],
                        afterBindings: [prepared.next],
                    });
                    let result;
                    try {
                        result = await this.repository.collections.apiBindings.updateOne(
                            { scopeKey: state.scopeKey, bindingId, revision: prepared.current.revision },
                            apiUpdateDocument(prepared.next),
                            writeOptions(transaction.session),
                        );
                    } catch (error) {
                        if (readNestedDuplicate(error)) {
                            throw new PermissionCoreError(
                                "API_BINDING_ALREADY_EXISTS",
                                "The API binding conflicts with an existing endpoint.",
                                { cause: error },
                            );
                        }
                        throw error;
                    }
                    if (result.matchedCount !== 1) revisionConflict(`api-binding:${bindingId}`, prepared.current.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure("API binding impact update did not modify exactly one document");
                    if (prepared.sourceRewrite !== null) {
                        await applySourceRewriteExecution({
                            repository: this.repository,
                            schemes: this.schemes,
                            session: transaction.session,
                            prepared: prepared.sourceRewrite,
                        });
                    }
                    const postImage = await reader.requireBinding(bindingId);
                    if (canonicalString(postImage) !== canonicalString(prepared.next)) {
                        databaseWriteFailure("API binding impact update post-image differs from the planned document");
                    }
                    const data = apiBindingView(postImage);
                    const changesAuthorization = prepared.sourceRewrite !== null && prepared.sourceRewrite.roles.length > 0;
                    return {
                        changed: true,
                        data,
                        primaryRevision: data.revision,
                        entity: { kind: "api-binding", id: bindingId, before: prepared.current.revision, after: data.revision },
                        revisionImpact: { rbac: changesAuthorization, menu: true },
                        scopeAggregate: aggregate,
                        change: { kind: "api-binding-impact-update", plan: prepared.completePlan },
                        cacheTargets: changesAuthorization
                            ? authorizationCacheTargets(state.scopeKey, prepared.affectedUsers)
                            : [`scope:${state.scopeKey}:menu`],
                        validatedPlanHash: prepared.planHash,
                        capacity: toPolicyValue(prepared.capacity),
                    };
                },
            });
    }

    private async planRemoval(
        reader: MenuScopeReader,
        bindingId: string,
        input: ReturnType<typeof normalizeApiBindingRemoveInput>,
        now: number,
        session: MongoSession,
    ): Promise<PreparedApiRemovalPlan> {
        const current = await reader.requireBinding(bindingId);
        const loaded = await this.loadSourceRecords(reader, current, session);
        const sourceImpacts = prepareSourceImpacts(loaded.records, "asset-remove", () => []);
        const conflicts: ManagementConflict[] = [...sourceRewriteConflicts(sourceImpacts, input.sourceRewrite)];
        let sourceRewrite: PreparedSourceRewriteExecution | null = null;
        let affectedUsers = emptyAffectedUsers(`api-binding-remove:${bindingId}`);
        let capacity: AuthorizationCapacityAssessment | null = null;
        let warnings = Object.freeze([] as ReturnType<typeof capacityMessages>["warnings"]);
        if (conflicts.length === 0 && sourceImpacts.length > 0) {
            const preparedRewrite = await this.prepareRewrite(
                reader,
                sourceImpacts,
                input.sourceRewrite,
                now,
                session,
                `api-binding-remove:${bindingId}`,
            );
            sourceRewrite = preparedRewrite.execution;
            affectedUsers = preparedRewrite.affectedUsers;
            capacity = preparedRewrite.capacity;
            warnings = preparedRewrite.warnings;
            conflicts.push(...preparedRewrite.conflicts);
        }
        const estimatedSourceMutations = sourceRewrite?.sourceMutationCount ?? sourceImpacts.length;
        const mutationCount = 1 + estimatedSourceMutations;
        if (mutationCount > 1_000) {
            conflicts.push({
                id: "api-binding-removal-capacity",
                code: "LIMIT_EXCEEDED",
                message: `API binding removal requires ${mutationCount} mutations; the atomic limit is 1000.`,
            });
        }
        const completePlan = toPolicyValue({
            bindingId,
            input,
            before: previewState(current),
            after: null,
            detachedOwners: current.owners,
            sourceImpacts: sourceImpacts.map((impact) => impact.public),
            sourceRewrite: sourceRewrite?.auditPlan ?? null,
            capacityDigest: capacity?.digest ?? null,
        });
        try {
            assertAuditChangeBudget({ kind: "api-binding-remove", plan: completePlan });
        } catch (error) {
            if (!(error instanceof PermissionCoreError) || error.code !== "LIMIT_EXCEEDED") throw error;
            conflicts.push({
                id: "api-binding-removal-audit-budget",
                code: "LIMIT_EXCEEDED",
                message: "The complete API binding removal audit diff exceeds its atomic byte budget.",
            });
        }
        const inputHash = digestCanonical({ bindingId, input });
        const revisionEntities = [{ kind: "api-binding" as const, id: bindingId, revision: current.revision }];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities, true);
        const planHash = menuPlanHash("apiBindings.previewRemove", inputHash, expectedRevisions, completePlan);
        const sourceSummary = sourceMutationSummary(sourceImpacts, input.sourceRewrite, estimatedSourceMutations);
        const summarySamples: BatchMutationSummary["samples"]["items"] = [
            { id: bindingId, outcome: "deleted" },
            ...sourceImpacts.map((impact) => ({
                id: impact.record.source.sourceId,
                outcome: input.sourceRewrite.mode === "reject"
                    ? "conflicted" as const
                    : input.sourceRewrite.resolutions[impact.record.source.sourceId]?.action === "revoke"
                        ? "deleted" as const
                        : "updated" as const,
            })),
        ];
        return {
            method: "apiBindings.previewRemove",
            reader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: sourceRewriteDecisionDetailCount(sourceImpacts),
            publicPlan: (budget) => deepFreeze({
                bindingId,
                sourceImpacts: budgetSourceImpacts(sourceImpacts, budget),
                detachedOwners: budget.bounded(current.owners),
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts({
                updated: sourceSummary.updated,
                deleted: 1 + sourceSummary.revoked,
                conflicted: conflicts.length,
            }),
            summarySamples,
            warnings,
            conflicts,
            capacity,
            current,
            sourceImpacts,
            sourceRewrite,
            affectedUsers,
        };
    }

    async previewRemove(
        scope: PermissionScope,
        bindingIdInput: string,
        inputValue: ApiBindingRemoveInput,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<ApiBindingRemovalPlan>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const input = normalizeApiBindingRemoveInput(inputValue);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planRemoval(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                bindingId,
                input,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async remove(
        scope: PermissionScope,
        bindingIdInput: string,
        inputValue: ApiBindingRemoveInput,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const input = normalizeApiBindingRemoveInput(inputValue);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "apiBindings.remove",
            action: "remove",
            resource: `api-binding:${bindingId}`,
            request: toPolicyValue({ bindingId, input, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay: decodeBatchMutationSummaryReplay,
            replayDetails: (data) => ({
                returned: data.samples.items.length,
                total: data.samples.total,
                tree: toPolicyValue({ samples: data.samples }),
            }),
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.planRemoval(reader, bindingId, input, now, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                const aggregate = planMenuAggregate({ state, beforeBindings: [prepared.current] });
                const result = await this.repository.collections.apiBindings.deleteOne(
                    { scopeKey: state.scopeKey, bindingId, revision: prepared.current.revision },
                    writeOptions(transaction.session),
                );
                if (result.deletedCount !== 1) revisionConflict(`api-binding:${bindingId}`, prepared.current.revision);
                if (prepared.sourceRewrite !== null) {
                    await applySourceRewriteExecution({
                        repository: this.repository,
                        schemes: this.schemes,
                        session: transaction.session,
                        prepared: prepared.sourceRewrite,
                    });
                }
                if (await reader.readBinding(bindingId) !== null) {
                    databaseWriteFailure("removed API binding is still visible in the transaction");
                }
                const data: BatchMutationSummary = deepFreeze({
                    ...prepared.summaryCounts,
                    samples: new DetailBudgetAllocator().bounded(sortBatchMutationSamples(prepared.summarySamples)),
                });
                const changesAuthorization = prepared.sourceRewrite !== null && prepared.sourceRewrite.roles.length > 0;
                return {
                    changed: true,
                    data,
                    primaryRevision: prepared.current.revision + 1,
                    entity: {
                        kind: "api-binding",
                        id: bindingId,
                        before: prepared.current.revision,
                        after: prepared.current.revision + 1,
                    },
                    revisionImpact: { rbac: changesAuthorization, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "api-binding-remove", plan: prepared.completePlan },
                    cacheTargets: changesAuthorization
                        ? authorizationCacheTargets(state.scopeKey, prepared.affectedUsers)
                        : [`scope:${state.scopeKey}:menu`],
                    validatedPlanHash: prepared.planHash,
                    capacity: toPolicyValue(prepared.capacity),
                };
            },
        });
    }

    private async planStatus(
        reader: MenuScopeReader,
        bindingId: string,
        status: EntityStatus,
        now: number,
        session: MongoSession,
    ): Promise<PreparedApiStatusPlan> {
        const current = await reader.requireBinding(bindingId);
        const next = current.status === status
            ? current
            : statusDocument(current, status, reader.state, now, this.schemes);
        const mayChangeAvailability = current.status !== status
            && (current.status === "enabled" || status === "enabled");
        const loaded = mayChangeAvailability
            ? await this.loadSourceRecords(reader, current, session)
            : { records: Object.freeze([] as MenuSourceRecord[]), sourceNodes: new Map() };
        const activeAt = (record: MenuSourceRecord, candidateStatus: EntityStatus) =>
            candidateStatus === "enabled" && loaded.sourceNodes.get(record.source.assetId)?.status === "enabled";
        const affectedRecords = loaded.records.filter((record) =>
            activeAt(record, current.status) !== activeAt(record, status));
        let expands = false;
        let restricts = false;
        const activatingRecords: MenuSourceRecord[] = [];
        for (const record of affectedRecords) {
            const before = activeAt(record, current.status);
            const after = activeAt(record, status);
            if (after && !before) {
                activatingRecords.push(record);
                if (record.rule.effect === "allow") expands = true;
                else restricts = true;
            } else if (before && !after) {
                if (record.rule.effect === "allow") restricts = true;
                else expands = true;
            }
        }
        const accessHint: AuthorizationCapacityAssessment["accessDirection"] = expands && restricts
            ? "mixed"
            : expands ? "expand" : restricts ? "restrict" : "none";
        const rbacReader = new RbacScopeReader(this.repository, this.schemes, reader.state, session);
        const rootRoleIds = [...new Set(affectedRecords.map((record) => record.rule.roleId))].sort(compareUtf8);
        const affectedRoleIds = await loadAffectedRoleIds(this.repository, rbacReader, rootRoleIds, session);
        const affectedUsers = affectedRoleIds.length === 0
            ? emptyAffectedUsers(`api-binding-status:${bindingId}`)
            : await loadAffectedUsers(
                this.repository,
                rbacReader,
                affectedRoleIds,
                `api-binding-status:${bindingId}`,
                session,
            );
        const availabilityReaders = createMenuAvailabilityReaders({
            rbacReader,
            menuReader: reader,
            before: { bindings: new Map([[bindingId, current.status]]) },
            after: { bindings: new Map([[bindingId, status]]) },
        });
        const structuralCapacityNonIncreasing = activatingRecords.length === 0
            && (accessHint === "restrict" || accessHint === "none");
        const knownCapacityRiskMayBeAcknowledged = activatingRecords.length > 0
            && activatingRecords.every((record) => record.rule.effect === "deny")
            && accessHint === "restrict";
        const capacity = await assessAuthorizationCapacity({
            repository: this.repository,
            reader: rbacReader,
            affectedUsers,
            overlay: {},
            beforeReader: availabilityReaders.before,
            afterReader: availabilityReaders.after,
            structuralCapacityNonIncreasing,
            knownCapacityRiskMayBeAcknowledged,
            accessHint,
            session,
        });
        const affectedSources = sampledCountSample(affectedRecords.map((record) => record.source.sourceId));
        const affectedRoles = sampledCountSample(affectedRoleIds);
        const affectedUserSample = deepFreeze({ ...capacity.affectedUsers });
        const inputHash = digestCanonical({ bindingId, status });
        const revisionEntities = [{ kind: "api-binding" as const, id: bindingId, revision: current.revision }];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities, true);
        const completePlan = toPolicyValue({
            bindingId,
            before: current.status,
            after: status,
            affectedSources,
            affectedRoles,
            affectedUsers: affectedUserSample,
            capacityDigest: capacity.digest,
        });
        const planHash = menuPlanHash("apiBindings.previewSetStatus", inputHash, expectedRevisions, completePlan);
        const messages = capacityMessages(capacity);
        return {
            method: "apiBindings.previewSetStatus",
            reader,
            inputHash,
            planHash,
            completePlan,
            publicPlan: (budget) => deepFreeze({
                bindingId,
                before: current.status,
                after: status,
                affectedSources: budgetCountSample(affectedSources, budget),
                affectedRoles: budgetCountSample(affectedRoles, budget),
                affectedUsers: budgetCountSample(affectedUserSample, budget),
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts(current.status === status ? { unchanged: 1 } : { updated: 1 }),
            summarySamples: [{ id: bindingId, outcome: current.status === status ? "unchanged" : "updated" }],
            warnings: messages.warnings,
            conflicts: messages.conflicts,
            capacity,
            current,
            next,
            affectedUsers,
        };
    }

    async previewSetStatus(
        scope: PermissionScope,
        bindingIdInput: string,
        statusInput: EntityStatus,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<ApiBindingStatusPlan>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const status = normalizeMenuEntityStatus(statusInput, "status");
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planStatus(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                bindingId,
                status,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async setStatus(
        scope: PermissionScope,
        bindingIdInput: string,
        statusInput: EntityStatus,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<ApiBinding>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const status = normalizeMenuEntityStatus(statusInput, "status");
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "apiBindings.setStatus",
            action: "update",
            resource: `api-binding:${bindingId}`,
            request: toPolicyValue({ bindingId, status, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay: (value) => decodeApiBindingReplay(value, this.schemes),
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.planStatus(reader, bindingId, status, now, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                if (prepared.current.status === status) {
                    const data = apiBindingView(prepared.current);
                    return {
                        changed: false,
                        data,
                        primaryRevision: prepared.current.revision,
                        entity: { kind: "api-binding", id: bindingId, before: prepared.current.revision, after: prepared.current.revision },
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "api-binding-status", plan: prepared.completePlan },
                        cacheTargets: [],
                        validatedPlanHash: prepared.planHash,
                        capacity: toPolicyValue(prepared.capacity),
                    };
                }
                const aggregate = planMenuAggregate({
                    state,
                    beforeBindings: [prepared.current],
                    afterBindings: [prepared.next],
                });
                const result = await this.repository.collections.apiBindings.updateOne(
                    { scopeKey: state.scopeKey, bindingId, revision: prepared.current.revision },
                    apiUpdateDocument(prepared.next),
                    writeOptions(transaction.session),
                );
                if (result.matchedCount !== 1) revisionConflict(`api-binding:${bindingId}`, prepared.current.revision);
                if (result.modifiedCount !== 1) databaseWriteFailure("API binding status did not update exactly one document");
                const postImage = await reader.requireBinding(bindingId);
                if (canonicalString(postImage) !== canonicalString(prepared.next)) {
                    databaseWriteFailure("API binding status post-image differs from the planned document");
                }
                const data = apiBindingView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: { kind: "api-binding", id: bindingId, before: prepared.current.revision, after: data.revision },
                    revisionImpact: { rbac: false, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "api-binding-status", plan: prepared.completePlan },
                    cacheTargets: authorizationCacheTargets(state.scopeKey, prepared.affectedUsers),
                    validatedPlanHash: prepared.planHash,
                    capacity: toPolicyValue(prepared.capacity),
                };
            },
        });
    }

    async getRemovalImpact(
        scope: PermissionScope,
        bindingIdInput: string,
    ): Promise<VersionedResult<ApiBindingImpact>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        return this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
            const current = await reader.requireBinding(bindingId);
            const loaded = await this.loadSourceRecords(reader, current, transaction.session);
            const ownerRelations = sampledCountSample(current.owners.map((owner) => `${owner.type}:${owner.id}`));
            const roleSources = sampledCountSample(loaded.records.map((record) => record.source.sourceId));
            const budget = new DetailBudgetAllocator();
            const data = deepFreeze({
                bindingId,
                ownerRelations: budgetCountSample(ownerRelations, budget),
                roleSources: budgetCountSample(roleSources, budget),
                removableWithoutRewrite: roleSources.total === 0,
            });
            const queryHash = digestCanonical({
                method: "apiBindings.getRemovalImpact",
                bindingId,
                globalRevision: state.revision,
                rbacRevision: state.rbacRevision,
                menuRevision: state.menuRevision,
            });
            const result = deepFreeze({
                data,
                revision: current.revision,
                revisions: revisionVector(state, [{ kind: "api-binding", id: bindingId, revision: current.revision }]),
                etag: `W/"pc-api-removal-${current.revision}-${queryHash}"`,
                detailBudget: budget.finish({ ownerRelations, roleSources }),
            });
            assertAuthorizationResponseBudget(result);
            return result;
        });
    }
}
