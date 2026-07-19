import type { MongoSession } from "monsqlize";
import type {
    ApiBindingCreateInput,
    AuthorizationCapacityAssessment,
    BatchMutationSummary,
    CountSample,
    EntityStatus,
    ImpactPreview,
    ManagementConflict,
    MenuMoveInput,
    MenuMovePlan,
    MenuNode,
    MenuNodeCreateInput,
    MenuNodeImpactUpdateRequest,
    MenuRemovalImpact,
    MenuRemovalPlan,
    MenuRemoveInput,
    MenuNodeUpdatePlan,
    MenuNodeUpdateInput,
    MenuReorderInput,
    MenuReorderPlan,
    MenuStatusPlan,
    MutationOptions,
    MutationResult,
    PermissionScope,
    PolicyValue,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionOptions,
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
    ManagementMutationExecutor,
    normalizeMutationOptions,
    normalizeRequiredRevisionOptions,
    type CacheInvalidator,
} from "../rbac/mutation-executor";
import {
    normalizeMenuPreviewExecutionOptions,
    normalizePreviewOptions,
} from "../rbac/preview-inputs";
import {
    assessAuthorizationCapacity,
    loadAffectedUsers,
    loadAffectedRoleIds,
    type AffectedUsers,
} from "../rbac/capacity";
import { RbacScopeReader } from "../rbac/store";
import {
    DetailBudgetAllocator,
    assertAuthorizationResponseBudget,
    revisionVector,
} from "../rbac/result";
import { normalizeRbacId } from "../rbac/validation";
import { planMenuAggregate } from "./aggregate";
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
    materializeMenuNodeDocument,
    menuNodeDocumentFromInput,
    menuNodeManifestItemFromDocument,
    menuNodeView,
} from "./materialize";
import { MAX_MENU_DEPTH, MAX_MENU_NODES, MenuScopeReader } from "./store";
import {
    normalizeMenuEntityStatus,
    normalizeApiBindingCreateInput,
    normalizeMenuMoveInput,
    normalizeMenuNodeImpactUpdateRequest,
    normalizeMenuNodeCreateInput,
    normalizeMenuNodeUpdateInput,
    normalizeMenuReorderInput,
    normalizeMenuRemoveInput,
} from "./validation";
import { decodeBatchMutationSummaryReplay, decodeMenuNodeReplay } from "./views";
import { validateMenuGraph } from "./queries";
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
    type PreparedSourceImpact,
    type MenuSourceRecord,
} from "./source-rewrite";
import {
    prepareSourceRewriteExecution,
    type PreparedSourceRewriteExecution,
} from "./source-rewrite-plan";

const OPTIONAL_NODE_FIELDS = [
    "path", "name", "code", "component", "url", "icon", "i18nKey", "meta", "permission", "dataPermissions",
] as const;
const OPTIONAL_API_FIELDS = ["canonicalOwner", "description"] as const;

function readOptions(session: unknown, projection?: Readonly<Record<string, 0 | 1>>) {
    return {
        session,
        cache: 0,
        collation: SIMPLE_COLLATION,
        ...(projection === undefined ? {} : { projection }),
    };
}

function insertOptions(session: unknown) {
    return { session, cache: { invalidate: false as const } };
}

function writeOptions(session: unknown) {
    return { session, cache: { invalidate: false as const }, collation: SIMPLE_COLLATION };
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The menu write result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function hierarchyInvalid(reason: string): never {
    throw new PermissionCoreError("MENU_HIERARCHY_INVALID", "The menu hierarchy is invalid.", {
        details: { kind: "validation", field: "parentId", reason },
    });
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function revisionConflict(owner: string, expected: number, current?: number): never {
    throw new PermissionCoreError("REVISION_CONFLICT", `${owner} revision changed.`, {
        details: { kind: "revision-conflict", owner, expected, ...(current === undefined ? {} : { current }) },
    });
}

function parentAllows(parent: InternalMenuNodeDocument["type"], child: InternalMenuNodeDocument["type"]) {
    if (parent === "directory") return child !== "button";
    if (parent === "menu") return child !== "directory";
    if (parent === "page") return child === "button";
    return false;
}

async function assertParentChain(
    reader: MenuScopeReader,
    nodeId: string,
    parentId: string | null,
    type: InternalMenuNodeDocument["type"],
) {
    if (parentId === null) {
        if (type === "button") hierarchyInvalid("button nodes cannot be roots");
        return;
    }
    const seen = new Set([nodeId]);
    let childType = type;
    let currentId: string | null = parentId;
    let depth = 1;
    let immediate = true;
    while (currentId !== null) {
        if (seen.has(currentId)) hierarchyInvalid("the parent chain contains a cycle");
        seen.add(currentId);
        const parent = await reader.readNode(currentId);
        if (parent === null) {
            if (immediate) hierarchyInvalid(`parent ${currentId} does not exist`);
            persistedInvalid("an ancestor parent reference is missing");
        }
        if (!parentAllows(parent.type, childType)) hierarchyInvalid(`${parent.type} cannot contain ${childType}`);
        childType = parent.type;
        currentId = parent.parentId;
        depth += 1;
        if (depth > MAX_MENU_DEPTH) hierarchyInvalid(`depth exceeds ${MAX_MENU_DEPTH}`);
        immediate = false;
    }
}

function createInputFromDocument(document: Readonly<InternalMenuNodeDocument>) {
    const { order: _order, ...input } = menuNodeManifestItemFromDocument(document);
    return input;
}

function nodeUpdateDocument(document: Readonly<InternalMenuNodeDocument>) {
    const set: Record<string, unknown> = {
        parentId: document.parentId,
        type: document.type,
        title: document.title,
        order: document.order,
        status: document.status,
        hidden: document.hidden,
        revision: document.revision,
        manifestItemBytes: document.manifestItemBytes,
        updatedAt: document.updatedAt,
    };
    const unset: Record<string, ""> = {};
    for (const field of OPTIONAL_NODE_FIELDS) {
        if (document[field] === undefined) unset[field] = "";
        else set[field] = document[field];
    }
    return { $set: set, ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }) };
}

function bindingUpdateDocument(document: Readonly<InternalApiBindingDocument>) {
    const set: Record<string, unknown> = {
        method: document.method,
        path: document.path,
        purpose: document.purpose,
        authorization: document.authorization,
        owners: document.owners,
        status: document.status,
        revision: document.revision,
        manifestItemBytes: document.manifestItemBytes,
        updatedAt: document.updatedAt,
    };
    const unset: Record<string, ""> = {};
    for (const field of OPTIONAL_API_FIELDS) {
        if (document[field] === undefined) unset[field] = "";
        else set[field] = document[field];
    }
    return { $set: set, ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }) };
}

function detachedBindingDocument(
    current: Readonly<InternalApiBindingDocument>,
    removedNodeIds: ReadonlySet<string>,
    now: number,
    schemes: ResourceSchemeRegistry,
) {
    const candidate: Record<string, unknown> = {
        ...apiBindingManifestItemFromDocument(current),
        owners: current.owners.filter((owner) => !removedNodeIds.has(owner.id)),
    };
    if (current.canonicalOwner !== undefined && removedNodeIds.has(current.canonicalOwner.id)) {
        delete candidate.canonicalOwner;
    }
    const normalized = normalizeApiBindingCreateInput(candidate as unknown as ApiBindingCreateInput, schemes);
    return apiBindingDocumentFromInput(
        current.scopeKey,
        current.scope,
        normalized,
        current.revision + 1,
        current.createdAt,
        now,
    );
}

function isMenuDuplicate(error: unknown) {
    let current = error;
    for (let depth = 0; depth < 6; depth += 1) {
        if (current !== null && typeof current === "object") {
            const record = current as Record<string, unknown>;
            if (record.code === 11000 || /\bE11000\b/iu.test(String(record.message ?? ""))) {
                return true;
            }
            current = (current as Record<string, unknown>).cause;
        } else break;
    }
    return false;
}

async function assertNodeUniqueness(
    repository: PermissionRepository,
    state: { scopeKey: string },
    document: Readonly<InternalMenuNodeDocument>,
    session: unknown,
) {
    const candidates: Record<string, unknown>[] = [];
    if (document.path !== undefined) candidates.push({ path: document.path });
    if (document.name !== undefined) candidates.push({ name: document.name });
    if (document.code !== undefined) candidates.push({ parentId: document.parentId, code: document.code });
    for (const candidate of candidates) {
        const duplicate = await repository.collections.menuNodes.findOne(
            { scopeKey: state.scopeKey, ...candidate },
            readOptions(session, { _id: 1, nodeId: 1 }),
        );
        if (duplicate !== null && duplicate.nodeId !== document.nodeId) {
            throw new PermissionCoreError("MENU_ALREADY_EXISTS", "The menu node conflicts with an existing path, name, or sibling code.");
        }
    }
}

function completeCountSample(ids: readonly string[]): CountSample {
    const normalized = [...ids].sort(compareUtf8);
    return deepFreeze({
        total: normalized.length,
        sampleIds: normalized,
        truncated: false,
        digest: digestCanonical(normalized),
    });
}

function orderedCountSample(ids: readonly string[]): CountSample {
    return deepFreeze({
        total: ids.length,
        sampleIds: [...ids],
        truncated: false,
        digest: digestCanonical(ids),
    });
}

function statusDocument(
    current: Readonly<InternalMenuNodeDocument>,
    status: EntityStatus,
    state: { scopeKey: string; scope: PermissionScope },
    now: number,
    schemes: ResourceSchemeRegistry,
) {
    const normalized = normalizeMenuNodeCreateInput({
        ...createInputFromDocument(current),
        status,
    }, schemes);
    return menuNodeDocumentFromInput(
        state.scopeKey,
        state.scope,
        normalized,
        current.order,
        current.revision + 1,
        current.createdAt,
        now,
    );
}

function nodePreviewState(document: Readonly<InternalMenuNodeDocument>) {
    const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...state } = menuNodeView(document);
    return deepFreeze(state);
}

function impactUpdateDocument(
    current: Readonly<InternalMenuNodeDocument>,
    request: ReturnType<typeof normalizeMenuNodeImpactUpdateRequest>,
    state: { scopeKey: string; scope: PermissionScope },
    now: number,
    schemes: ResourceSchemeRegistry,
) {
    const candidate = { ...createInputFromDocument(current) } as Record<string, unknown>;
    for (const [key, value] of Object.entries(request.patch)) {
        if (value === null) delete candidate[key];
        else candidate[key] = value;
    }
    const normalized = normalizeMenuNodeCreateInput(candidate as unknown as MenuNodeCreateInput, schemes);
    return menuNodeDocumentFromInput(
        state.scopeKey,
        state.scope,
        normalized,
        current.order,
        current.revision + 1,
        current.createdAt,
        now,
    );
}

function sourceResolutionDirection(
    impacts: readonly PreparedSourceImpact[],
    decision: ReturnType<typeof normalizeMenuNodeImpactUpdateRequest>["sourceRewrite"],
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
    decision: ReturnType<typeof normalizeMenuNodeImpactUpdateRequest>["sourceRewrite"],
    sourceMutationCount: number,
) {
    const revoked = impacts.filter((impact) =>
        decision.mode === "apply"
        && decision.resolutions[impact.record.source.sourceId]?.action === "revoke").length;
    return deepFreeze({ revoked, updated: Math.max(0, sourceMutationCount - revoked) });
}

function placementDocument(
    current: Readonly<InternalMenuNodeDocument>,
    parentId: string | null,
    order: number,
    state: { scopeKey: string; scope: PermissionScope },
    now: number,
    schemes: ResourceSchemeRegistry,
) {
    const input = normalizeMenuNodeCreateInput({
        ...createInputFromDocument(current),
        parentId,
    }, schemes);
    return menuNodeDocumentFromInput(
        state.scopeKey,
        state.scope,
        input,
        order,
        current.revision + 1,
        current.createdAt,
        now,
    );
}

interface PreparedMovePlan extends PreparedMenuPlan<MenuMovePlan> {
    readonly current: Readonly<InternalMenuNodeDocument>;
    readonly updates: readonly {
        readonly before: Readonly<InternalMenuNodeDocument>;
        readonly after: Readonly<InternalMenuNodeDocument>;
    }[];
}

interface PreparedReorderPlan extends PreparedMenuPlan<MenuReorderPlan> {
    readonly updates: readonly {
        readonly before: Readonly<InternalMenuNodeDocument>;
        readonly after: Readonly<InternalMenuNodeDocument>;
    }[];
}

interface PreparedStatusPlan extends PreparedMenuPlan<MenuStatusPlan> {
    readonly current: Readonly<InternalMenuNodeDocument>;
    readonly next: Readonly<InternalMenuNodeDocument>;
    readonly affectedUsers: AffectedUsers;
}

interface PreparedNodeUpdatePlan extends PreparedMenuPlan<MenuNodeUpdatePlan> {
    readonly current: Readonly<InternalMenuNodeDocument>;
    readonly next: Readonly<InternalMenuNodeDocument>;
    readonly changed: boolean;
    readonly sourceImpacts: readonly PreparedSourceImpact[];
    readonly sourceRewrite: PreparedSourceRewriteExecution | null;
    readonly affectedUsers: AffectedUsers;
}

interface PreparedRemovalPlan extends PreparedMenuPlan<MenuRemovalPlan> {
    readonly current: Readonly<InternalMenuNodeDocument>;
    readonly deletedNodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly nodeUpdates: readonly {
        readonly before: Readonly<InternalMenuNodeDocument>;
        readonly after: Readonly<InternalMenuNodeDocument>;
    }[];
    readonly bindingUpdates: readonly {
        readonly before: Readonly<InternalApiBindingDocument>;
        readonly after: Readonly<InternalApiBindingDocument>;
    }[];
    readonly sourceImpacts: readonly PreparedSourceImpact[];
    readonly sourceRewrite: PreparedSourceRewriteExecution | null;
    readonly affectedUsers: AffectedUsers;
}

export class MenuNodeMutationService {
    private readonly executor: ManagementMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
    }

    async create(
        scope: PermissionScope,
        input: MenuNodeCreateInput,
        options?: MutationOptions,
    ): Promise<MutationResult<MenuNode>> {
        const node = normalizeMenuNodeCreateInput(input, this.schemes);
        const normalizedOptions = normalizeMutationOptions(options);
        try {
            return await this.executor.execute({
                scope,
                operation: "menus.create",
                action: "create",
                resource: `menu:${node.id}`,
                request: toPolicyValue({ node }),
                options: normalizedOptions,
                decodeReplay: (value) => decodeMenuNodeReplay(value, this.schemes),
                work: async ({ transaction, state, now }) => {
                    const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                    if (await reader.readNode(node.id)) {
                        throw new PermissionCoreError("MENU_ALREADY_EXISTS", `Menu node ${node.id} already exists.`);
                    }
                    await assertParentChain(reader, node.id, node.parentId, node.type);
                    const siblingCount = await this.repository.collections.menuNodes.count(
                        { scopeKey: state.scopeKey, parentId: node.parentId },
                        readOptions(transaction.session),
                    );
                    if (!Number.isSafeInteger(siblingCount) || siblingCount < 0 || siblingCount >= MAX_MENU_NODES) {
                        persistedInvalid("the sibling count is invalid or exceeds the menu limit");
                    }
                    if (siblingCount > 0) {
                        const rows = await this.repository.collections.menuNodes.find(
                            { scopeKey: state.scopeKey, parentId: node.parentId },
                            readOptions(transaction.session),
                        ).sort({ order: -1, nodeId: -1 }).limit(1).toArray();
                        if (rows.length !== 1) persistedInvalid("the sibling tail is missing");
                        const tail = materializeMenuNodeDocument(rows[0], state.scope, state.scopeKey, this.schemes);
                        if (tail.order !== siblingCount - 1) persistedInvalid("the sibling order is not dense");
                    }
                    const document = menuNodeDocumentFromInput(
                        state.scopeKey,
                        state.scope,
                        node,
                        siblingCount,
                        1,
                        now,
                    );
                    await assertNodeUniqueness(this.repository, state, document, transaction.session);
                    const aggregate = planMenuAggregate({ state, afterNodes: [document] });
                    const result = await this.repository.collections.menuNodes.insertOne(
                        { ...document },
                        insertOptions(transaction.session),
                    );
                    if (result.acknowledged !== true) databaseWriteFailure("menu insert was not acknowledged");
                    const postImage = await reader.requireNode(node.id);
                    if (canonicalString(postImage) !== canonicalString(document)) {
                        databaseWriteFailure("menu insert post-image differs from the validated document");
                    }
                    const data = menuNodeView(postImage);
                    return {
                        changed: true,
                        data,
                        primaryRevision: 1,
                        entity: { kind: "menu-node", id: node.id, before: 0, after: 1 },
                        revisionImpact: { rbac: false, menu: true },
                        scopeAggregate: aggregate,
                        change: { kind: "menu-node", before: null, after: data },
                        cacheTargets: [`scope:${state.scopeKey}:menu`],
                    };
                },
            });
        } catch (error) {
            if (isMenuDuplicate(error)) {
                throw new PermissionCoreError("MENU_ALREADY_EXISTS", "The menu node conflicts with an existing identity, path, name, or sibling code.", { cause: error });
            }
            throw error;
        }
    }

    async update(
        scope: PermissionScope,
        nodeIdInput: string,
        patchInput: MenuNodeUpdateInput,
        optionsInput: RequiredRevisionOptions,
    ): Promise<MutationResult<MenuNode>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const patch = normalizeMenuNodeUpdateInput(patchInput);
        const options = normalizeRequiredRevisionOptions(optionsInput);
        try {
            return await this.executor.execute({
                scope,
                operation: "menus.update",
                action: "update",
                resource: `menu:${nodeId}`,
                request: toPolicyValue({ nodeId, patch, expectedRevision: options.expectedRevision }),
                options,
                decodeReplay: (value) => decodeMenuNodeReplay(value, this.schemes),
                work: async ({ transaction, state, now }) => {
                    const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                    const current = await reader.requireNode(nodeId);
                    if (current.revision !== options.expectedRevision) {
                        revisionConflict(`menu:${nodeId}`, options.expectedRevision, current.revision);
                    }
                    if (current.status === "deprecated") {
                        throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated menu nodes can only be restored through setStatus.", {
                            details: { kind: "validation", field: "nodeId", reason: "menu node is deprecated" },
                        });
                    }
                    const candidate = { ...createInputFromDocument(current) } as Record<string, unknown>;
                    for (const [key, value] of Object.entries(patch)) {
                        if (value === null) delete candidate[key];
                        else candidate[key] = value;
                    }
                    const normalized = normalizeMenuNodeCreateInput(candidate as unknown as MenuNodeCreateInput, this.schemes);
                    const changed = canonicalString(normalized) !== canonicalString(createInputFromDocument(current));
                    if (!changed) {
                        const data = menuNodeView(current);
                        return {
                            changed: false,
                            data,
                            primaryRevision: current.revision,
                            entity: { kind: "menu-node", id: nodeId, before: current.revision, after: current.revision },
                            revisionImpact: { rbac: false, menu: false },
                            change: { kind: "menu-metadata", before: data, after: data },
                            cacheTargets: [],
                        };
                    }
                    const next = menuNodeDocumentFromInput(
                        state.scopeKey,
                        state.scope,
                        normalized,
                        current.order,
                        current.revision + 1,
                        current.createdAt,
                        now,
                    );
                    const aggregate = planMenuAggregate({ state, beforeNodes: [current], afterNodes: [next] });
                    const result = await this.repository.collections.menuNodes.updateOne(
                        { scopeKey: state.scopeKey, nodeId, revision: current.revision },
                        nodeUpdateDocument(next),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`menu:${nodeId}`, current.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure("changed menu update did not modify exactly one document");
                    const postImage = await reader.requireNode(nodeId);
                    if (canonicalString(postImage) !== canonicalString(next)) {
                        databaseWriteFailure("menu update post-image differs from the validated document");
                    }
                    const before = menuNodeView(current);
                    const data = menuNodeView(postImage);
                    return {
                        changed: true,
                        data,
                        primaryRevision: data.revision,
                        entity: { kind: "menu-node", id: nodeId, before: current.revision, after: data.revision },
                        revisionImpact: { rbac: false, menu: true },
                        scopeAggregate: aggregate,
                        change: { kind: "menu-metadata", before, after: data },
                        cacheTargets: [`scope:${state.scopeKey}:menu`],
                    };
                },
            });
        } catch (error) {
            if (isMenuDuplicate(error)) {
                throw new PermissionCoreError("MENU_ALREADY_EXISTS", "The menu update conflicts with an existing path, name, or sibling code.", { cause: error });
            }
            throw error;
        }
    }
}

export class MenuNodeImpactMutationService {
    private readonly executor: ManagementMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
    }

    private async planImpactUpdate(
        reader: MenuScopeReader,
        nodeId: string,
        request: ReturnType<typeof normalizeMenuNodeImpactUpdateRequest>,
        now: number,
        session: MongoSession,
    ): Promise<PreparedNodeUpdatePlan> {
        const inventory = await reader.readCompleteInventory();
        validateMenuGraph(inventory.nodes);
        const current = inventory.nodes.find((node) => node.nodeId === nodeId);
        if (current === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${nodeId} was not found.`);
        if (current.status === "deprecated") {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated menu nodes can only be restored through setStatus.", {
                details: { kind: "validation", field: "nodeId", reason: "menu node is deprecated" },
            });
        }
        const candidate = impactUpdateDocument(current, request, reader.state, now, this.schemes);
        const changed = canonicalString(menuNodeManifestItemFromDocument(current))
            !== canonicalString(menuNodeManifestItemFromDocument(candidate));
        const next = changed ? candidate : current;
        const conflicts: ManagementConflict[] = [];
        for (const other of inventory.nodes) {
            if (other.nodeId === nodeId) continue;
            const duplicatePath = next.path !== undefined && other.path === next.path;
            const duplicateName = next.name !== undefined && other.name === next.name;
            const duplicateCode = next.code !== undefined
                && other.parentId === next.parentId
                && other.code === next.code;
            if (duplicatePath || duplicateName || duplicateCode) {
                conflicts.push({
                    id: `menu-node:${other.nodeId}`,
                    code: "MENU_ALREADY_EXISTS",
                    message: `Menu node ${nodeId} conflicts with ${other.nodeId} in the target inventory.`,
                });
            }
        }

        const nodePermissionChanged = canonicalString(current.permission ?? null)
            !== canonicalString(next.permission ?? null);
        const dataPermissionsChanged = canonicalString(current.dataPermissions ?? [])
            !== canonicalString(next.dataPermissions ?? []);
        const sourceRecords = !nodePermissionChanged && !dataPermissionsChanged
            ? []
            : await loadMenuSourceRecords({
                repository: this.repository,
                schemes: this.schemes,
                reader,
                session,
                mongoFilter: { "sources.assetId": nodeId },
                matches: (source) => source.assetId === nodeId
                    && (
                        (nodePermissionChanged && source.contribution === "node")
                        || (dataPermissionsChanged && source.contribution === "data")
                    ),
            });
        for (const record of sourceRecords) {
            if (record.source.effect !== record.rule.effect) {
                persistedInvalid(`menu source ${record.source.sourceId} effect differs from its semantic rule`);
            }
        }
        const sourceImpacts = prepareSourceImpacts(sourceRecords, "permission-change", (record) => {
            if (record.source.contribution === "node") {
                return next.permission === undefined ? [] : [next.permission];
            }
            if (record.source.contribution === "data") return next.dataPermissions ?? [];
            return [];
        });
        conflicts.push(...sourceRewriteConflicts(sourceImpacts, request.sourceRewrite));

        const rbacReader = new RbacScopeReader(this.repository, this.schemes, reader.state, session);
        let sourceRewrite: PreparedSourceRewriteExecution | null = null;
        let affectedUsers = emptyAffectedUsers(`menu-update:${nodeId}`);
        let capacity: AuthorizationCapacityAssessment | null = null;
        let warnings = Object.freeze([] as ReturnType<typeof capacityMessages>["warnings"]);
        if (conflicts.length === 0 && sourceImpacts.length > 0) {
            sourceRewrite = await prepareSourceRewriteExecution({
                rbacReader,
                menuReader: reader,
                impacts: sourceImpacts,
                decision: request.sourceRewrite,
                now,
            });
            conflicts.push(...sourceRewrite.conflicts);
            if (sourceRewrite.conflicts.length === 0) {
                const sourceRoleIds = [...new Set(sourceRecords.map((record) => record.rule.roleId))].sort(compareUtf8);
                const affectedRoleIds = await loadAffectedRoleIds(
                    this.repository,
                    rbacReader,
                    sourceRoleIds,
                    session,
                );
                if (affectedRoleIds.length > 0) {
                    affectedUsers = await loadAffectedUsers(
                        this.repository,
                        rbacReader,
                        affectedRoleIds,
                        `menu-update:${nodeId}`,
                        session,
                    );
                }
                const direction = sourceResolutionDirection(sourceImpacts, request.sourceRewrite);
                const availabilityReaders = createMenuAvailabilityReaders({
                    rbacReader,
                    menuReader: reader,
                    after: { rules: sourceRewrite.afterRulesByRole },
                });
                const onlyRevokes = sourceImpacts.every((impact) =>
                    request.sourceRewrite.mode === "apply"
                    && request.sourceRewrite.resolutions[impact.record.source.sourceId]?.action === "revoke");
                capacity = await assessAuthorizationCapacity({
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
                warnings = messages.warnings;
                conflicts.push(...messages.conflicts);
            }
        }

        const estimatedSourceMutations = sourceRewrite?.sourceMutationCount ?? sourceImpacts.length;
        const mutationCount = (changed ? 1 : 0) + estimatedSourceMutations;
        if (mutationCount > 1_000) {
            conflicts.push({
                id: "menu-update-capacity",
                code: "LIMIT_EXCEEDED",
                message: `Menu update requires ${mutationCount} mutations; the atomic limit is 1000.`,
            });
        }
        const before = nodePreviewState(current);
        const after = nodePreviewState(next);
        const completePlan = toPolicyValue({
            nodeId,
            request,
            before,
            after,
            sourceImpacts: sourceImpacts.map((impact) => impact.public),
            sourceRewrite: sourceRewrite?.auditPlan ?? null,
            capacityDigest: capacity?.digest ?? null,
        });
        try {
            assertAuditChangeBudget({ kind: "menu-impact-update", plan: completePlan });
        } catch (error) {
            if (!(error instanceof PermissionCoreError) || error.code !== "LIMIT_EXCEEDED") throw error;
            conflicts.push({
                id: "menu-update-audit-budget",
                code: "LIMIT_EXCEEDED",
                message: "The complete menu update audit diff exceeds its atomic byte budget.",
            });
        }
        const inputHash = digestCanonical({ nodeId, request });
        const revisionEntities = [{ kind: "menu-node" as const, id: nodeId, revision: current.revision }];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities, sourceImpacts.length > 0);
        const planHash = menuPlanHash("menus.previewUpdate", inputHash, expectedRevisions, completePlan);
        const sourceSummary = sourceMutationSummary(sourceImpacts, request.sourceRewrite, estimatedSourceMutations);
        const summarySamples: BatchMutationSummary["samples"]["items"] = [
            { id: nodeId, outcome: changed ? "updated" : "unchanged" },
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
            method: "menus.previewUpdate",
            reader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: sourceRewriteDecisionDetailCount(sourceImpacts),
            publicPlan: (budget) => deepFreeze({
                nodeId,
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
        nodeIdInput: string,
        requestValue: MenuNodeImpactUpdateRequest,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<MenuNodeUpdatePlan>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const request = normalizeMenuNodeImpactUpdateRequest(requestValue, this.schemes);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planImpactUpdate(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                nodeId,
                request,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async executeUpdate(
        scope: PermissionScope,
        nodeIdInput: string,
        requestValue: MenuNodeImpactUpdateRequest,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<MenuNode>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const request = normalizeMenuNodeImpactUpdateRequest(requestValue, this.schemes);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        try {
            return await this.executor.execute({
                scope,
                operation: "menus.executeUpdate",
                action: "update",
                resource: `menu:${nodeId}`,
                request: toPolicyValue({ nodeId, request, expectedRevisions: options.expectedRevisions }),
                options,
                decodeReplay: (value) => decodeMenuNodeReplay(value, this.schemes),
                work: async ({ transaction, state, now }) => {
                    const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                    const prepared = await this.planImpactUpdate(reader, nodeId, request, now, transaction.session);
                    validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                    if (!prepared.changed) {
                        const data = menuNodeView(prepared.current);
                        return {
                            changed: false,
                            data,
                            primaryRevision: prepared.current.revision,
                            entity: { kind: "menu-node", id: nodeId, before: prepared.current.revision, after: prepared.current.revision },
                            revisionImpact: { rbac: false, menu: false },
                            change: { kind: "menu-impact-update", plan: prepared.completePlan },
                            cacheTargets: [],
                            validatedPlanHash: prepared.planHash,
                            capacity: toPolicyValue(prepared.capacity),
                        };
                    }
                    await assertNodeUniqueness(this.repository, state, prepared.next, transaction.session);
                    const aggregate = planMenuAggregate({
                        state,
                        beforeNodes: [prepared.current],
                        afterNodes: [prepared.next],
                    });
                    const result = await this.repository.collections.menuNodes.updateOne(
                        { scopeKey: state.scopeKey, nodeId, revision: prepared.current.revision },
                        nodeUpdateDocument(prepared.next),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`menu:${nodeId}`, prepared.current.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure("menu impact update did not modify exactly one document");
                    if (prepared.sourceRewrite !== null) {
                        await applySourceRewriteExecution({
                            repository: this.repository,
                            schemes: this.schemes,
                            session: transaction.session,
                            prepared: prepared.sourceRewrite,
                        });
                    }
                    const postImage = await reader.requireNode(nodeId);
                    if (canonicalString(postImage) !== canonicalString(prepared.next)) {
                        databaseWriteFailure("menu impact update post-image differs from the planned document");
                    }
                    const data = menuNodeView(postImage);
                    const changesAuthorization = prepared.sourceRewrite !== null
                        && prepared.sourceRewrite.roles.length > 0;
                    return {
                        changed: true,
                        data,
                        primaryRevision: data.revision,
                        entity: { kind: "menu-node", id: nodeId, before: prepared.current.revision, after: data.revision },
                        revisionImpact: { rbac: changesAuthorization, menu: true },
                        scopeAggregate: aggregate,
                        change: { kind: "menu-impact-update", plan: prepared.completePlan },
                        cacheTargets: changesAuthorization
                            ? authorizationCacheTargets(state.scopeKey, prepared.affectedUsers)
                            : [`scope:${state.scopeKey}:menu`],
                        validatedPlanHash: prepared.planHash,
                        capacity: toPolicyValue(prepared.capacity),
                    };
                },
            });
        } catch (error) {
            if (isMenuDuplicate(error)) {
                throw new PermissionCoreError("MENU_ALREADY_EXISTS", "The menu update conflicts with an existing path, name, or sibling code.", { cause: error });
            }
            throw error;
        }
    }

    private async loadRemovalInventory(
        reader: MenuScopeReader,
        nodeId: string,
        session: MongoSession,
    ) {
        const inventory = await reader.readCompleteInventory();
        const graph = validateMenuGraph(inventory.nodes);
        const current = graph.nodes.get(nodeId);
        if (current === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${nodeId} was not found.`);
        const descendants: Readonly<InternalMenuNodeDocument>[] = [];
        const stack = [...(graph.children.get(nodeId) ?? [])];
        while (stack.length > 0) {
            const node = stack.shift()!;
            descendants.push(node);
            stack.push(...(graph.children.get(node.nodeId) ?? []));
        }
        descendants.sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
        const subtreeIds = [nodeId, ...descendants.map((node) => node.nodeId)].sort(compareUtf8);
        const subtreeIdSet = new Set(subtreeIds);
        const bindings = inventory.bindings
            .filter((binding) => binding.owners.some((owner) => subtreeIdSet.has(owner.id)))
            .sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        const sourceRecords = await loadMenuSourceRecords({
            repository: this.repository,
            schemes: this.schemes,
            reader,
            session,
            mongoFilter: { "sources.assetId": { $in: subtreeIds } },
            matches: (source) => subtreeIdSet.has(source.assetId),
        });
        const bindingById = new Map(inventory.bindings.map((binding) => [binding.bindingId, binding] as const));
        for (const record of sourceRecords) {
            if (record.source.effect !== record.rule.effect) {
                persistedInvalid(`menu source ${record.source.sourceId} effect differs from its semantic rule`);
            }
            if (record.source.contribution !== "api") continue;
            const binding = bindingById.get(record.source.apiBindingId);
            if (binding === undefined) {
                persistedInvalid(`menu source ${record.source.sourceId} references missing API binding ${record.source.apiBindingId}`);
            }
            if (!binding.owners.some((owner) => owner.id === record.source.assetId)) {
                persistedInvalid(`menu source ${record.source.sourceId} has a mismatched API binding owner`);
            }
        }
        return Object.freeze({ inventory, graph, current, descendants, subtreeIds, bindings, sourceRecords });
    }

    private async planStatus(
        reader: MenuScopeReader,
        nodeId: string,
        status: EntityStatus,
        now: number,
        session: MongoSession,
    ): Promise<PreparedStatusPlan> {
        const current = await reader.requireNode(nodeId);
        const next = current.status === status
            ? current
            : statusDocument(current, status, reader.state, now, this.schemes);
        const mayChangeAvailability = current.status === "enabled" || status === "enabled";
        const sourceRecords = !mayChangeAvailability || current.status === status
            ? []
            : await loadMenuSourceRecords({
                repository: this.repository,
                schemes: this.schemes,
                reader,
                session,
                mongoFilter: { "sources.assetId": nodeId },
                matches: (source) => source.assetId === nodeId,
            });
        const bindingIds = sourceRecords.flatMap((record) => record.source.contribution === "api"
            ? [record.source.apiBindingId]
            : []);
        const bindings = await reader.readBindingsByIds(bindingIds);
        const activeAt = (record: MenuSourceRecord, candidateStatus: EntityStatus) => {
            if (record.source.effect !== record.rule.effect) {
                persistedInvalid(`menu source ${record.source.sourceId} effect differs from its semantic rule`);
            }
            if (candidateStatus !== "enabled") return false;
            if (record.source.contribution !== "api") return true;
            const binding = bindings.get(record.source.apiBindingId);
            if (binding === undefined) {
                persistedInvalid(`menu source ${record.source.sourceId} references missing API binding ${record.source.apiBindingId}`);
            }
            if (!binding.owners.some((owner) => owner.id === record.source.assetId)) {
                persistedInvalid(`menu source ${record.source.sourceId} has a mismatched API binding owner`);
            }
            return binding.status === "enabled";
        };
        const affectedRecords = sourceRecords.filter((record) =>
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
        const sourceRoleIds = [...new Set(affectedRecords.map((record) => record.rule.roleId))].sort(compareUtf8);
        const rbacReader = new RbacScopeReader(
            this.repository,
            this.schemes,
            reader.state,
            session,
        );
        const affectedRoleIds = await loadAffectedRoleIds(
            this.repository,
            rbacReader,
            sourceRoleIds,
            session,
        );
        const affectedUsers = await loadAffectedUsers(
            this.repository,
            rbacReader,
            affectedRoleIds,
            `menu-status:${nodeId}`,
            session,
        );
        const availabilityReaders = createMenuAvailabilityReaders({
            rbacReader,
            menuReader: reader,
            before: { nodes: new Map([[nodeId, current.status]]) },
            after: { nodes: new Map([[nodeId, status]]) },
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
        const inputHash = digestCanonical({ nodeId, status });
        const revisionEntities = [{ kind: "menu-node" as const, id: nodeId, revision: current.revision }];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities, true);
        const completePlan = toPolicyValue({
            nodeId,
            before: current.status,
            after: status,
            affectedSources,
            affectedRoles,
            affectedUsers: affectedUserSample,
            capacityDigest: capacity.digest,
        });
        const planHash = menuPlanHash("menus.previewSetStatus", inputHash, expectedRevisions, completePlan);
        const messages = capacityMessages(capacity);
        return {
            method: "menus.previewSetStatus",
            reader,
            inputHash,
            planHash,
            completePlan,
            publicPlan: (budget) => deepFreeze({
                nodeId,
                before: current.status,
                after: status,
                affectedSources: budgetCountSample(affectedSources, budget),
                affectedRoles: budgetCountSample(affectedRoles, budget),
                affectedUsers: budgetCountSample(affectedUserSample, budget),
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts(current.status === status
                ? { unchanged: 1 }
                : { updated: 1 }),
            summarySamples: [{ id: nodeId, outcome: current.status === status ? "unchanged" : "updated" }],
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
        nodeIdInput: string,
        statusInput: EntityStatus,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<MenuStatusPlan>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const status = normalizeMenuEntityStatus(statusInput, "status");
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planStatus(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                nodeId,
                status,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async setStatus(
        scope: PermissionScope,
        nodeIdInput: string,
        statusInput: EntityStatus,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<MenuNode>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const status = normalizeMenuEntityStatus(statusInput, "status");
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "menus.setStatus",
            action: "update",
            resource: `menu:${nodeId}`,
            request: toPolicyValue({ nodeId, status, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay: (value) => decodeMenuNodeReplay(value, this.schemes),
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.planStatus(reader, nodeId, status, now, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                if (prepared.current.status === status) {
                    const data = menuNodeView(prepared.current);
                    return {
                        changed: false,
                        data,
                        primaryRevision: prepared.current.revision,
                        entity: { kind: "menu-node", id: nodeId, before: prepared.current.revision, after: prepared.current.revision },
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "menu-status", plan: prepared.completePlan },
                        cacheTargets: [],
                        validatedPlanHash: prepared.planHash,
                        capacity: toPolicyValue(prepared.capacity),
                    };
                }
                const aggregate = planMenuAggregate({
                    state,
                    beforeNodes: [prepared.current],
                    afterNodes: [prepared.next],
                });
                const result = await this.repository.collections.menuNodes.updateOne(
                    { scopeKey: state.scopeKey, nodeId, revision: prepared.current.revision },
                    nodeUpdateDocument(prepared.next),
                    writeOptions(transaction.session),
                );
                if (result.matchedCount !== 1) revisionConflict(`menu:${nodeId}`, prepared.current.revision);
                if (result.modifiedCount !== 1) databaseWriteFailure("menu status did not update exactly one document");
                const postImage = await reader.requireNode(nodeId);
                if (canonicalString(postImage) !== canonicalString(prepared.next)) {
                    databaseWriteFailure("menu status post-image differs from the planned document");
                }
                const data = menuNodeView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: { kind: "menu-node", id: nodeId, before: prepared.current.revision, after: data.revision },
                    revisionImpact: { rbac: false, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "menu-status", plan: prepared.completePlan },
                    cacheTargets: authorizationCacheTargets(state.scopeKey, prepared.affectedUsers),
                    validatedPlanHash: prepared.planHash,
                    capacity: toPolicyValue(prepared.capacity),
                };
            },
        });
    }

    async getRemovalImpact(
        scope: PermissionScope,
        nodeIdInput: string,
    ): Promise<VersionedResult<MenuRemovalImpact>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        return this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
            const inventory = await this.loadRemovalInventory(reader, nodeId, transaction.session);
            const descendants = sampledCountSample(inventory.descendants.map((node) => node.nodeId));
            const apiBindings = sampledCountSample(inventory.bindings.map((binding) => binding.bindingId));
            const roleSources = sampledCountSample(inventory.sourceRecords.map((record) => record.source.sourceId));
            const budget = new DetailBudgetAllocator();
            const data = deepFreeze({
                nodeId,
                descendants: budgetCountSample(descendants, budget),
                apiBindings: budgetCountSample(apiBindings, budget),
                roleSources: budgetCountSample(roleSources, budget),
                removableWithoutCascade: descendants.total === 0 && apiBindings.total === 0 && roleSources.total === 0,
            });
            const queryHash = digestCanonical({
                method: "menus.getRemovalImpact",
                nodeId,
                globalRevision: state.revision,
                rbacRevision: state.rbacRevision,
                menuRevision: state.menuRevision,
            });
            const result = deepFreeze({
                data,
                revision: inventory.current.revision,
                revisions: revisionVector(state, [{
                    kind: "menu-node",
                    id: nodeId,
                    revision: inventory.current.revision,
                }]),
                etag: `W/"pc-menu-removal-${inventory.current.revision}-${queryHash}"`,
                detailBudget: budget.finish({ descendants, apiBindings, roleSources }),
            });
            assertAuthorizationResponseBudget(result);
            return result;
        });
    }

    private async planRemoval(
        reader: MenuScopeReader,
        nodeId: string,
        input: ReturnType<typeof normalizeMenuRemoveInput>,
        now: number,
        session: MongoSession,
    ): Promise<PreparedRemovalPlan> {
        const inventory = await this.loadRemovalInventory(reader, nodeId, session);
        const deletedNodes = (input.cascade
            ? [inventory.current, ...inventory.descendants]
            : [inventory.current])
            .sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
        const deletedNodeIds = deletedNodes.map((node) => node.nodeId);
        const deletedNodeIdSet = new Set(deletedNodeIds);
        const bindingUpdates = inventory.bindings
            .filter((binding) => binding.owners.some((owner) => deletedNodeIdSet.has(owner.id)))
            .map((before) => ({
                before,
                after: detachedBindingDocument(before, deletedNodeIdSet, now, this.schemes),
            }))
            .sort((left, right) => compareUtf8(left.before.bindingId, right.before.bindingId));
        const sourceRecords = inventory.sourceRecords
            .filter((record) => deletedNodeIdSet.has(record.source.assetId));
        const sourceImpacts = prepareSourceImpacts(sourceRecords, "asset-remove", () => []);

        const conflicts: ManagementConflict[] = [];
        if (!input.cascade && inventory.descendants.length > 0) {
            conflicts.push({
                id: "menu-descendants",
                code: "MENU_DEPENDENCY_EXISTS",
                message: `Menu node ${nodeId} has ${inventory.descendants.length} descendants; explicit cascade is required.`,
            });
        }
        if (!input.cascade && bindingUpdates.length > 0) {
            conflicts.push({
                id: "menu-api-bindings",
                code: "MENU_DEPENDENCY_EXISTS",
                message: `Menu node ${nodeId} owns ${bindingUpdates.length} API bindings; explicit cascade is required.`,
            });
        }
        if (!input.cascade && sourceImpacts.length > 0) {
            conflicts.push({
                id: "menu-role-sources",
                code: "MENU_DEPENDENCY_EXISTS",
                message: `Menu node ${nodeId} contributes ${sourceImpacts.length} role sources; explicit cascade is required.`,
            });
        }
        conflicts.push(...sourceRewriteConflicts(sourceImpacts, input.sourceRewrite));

        const currentSiblings = [...(inventory.graph.children.get(inventory.current.parentId) ?? [])];
        const survivingSiblings = currentSiblings.filter((node) => !deletedNodeIdSet.has(node.nodeId));
        const nodeUpdates = survivingSiblings
            .map((before, order) => ({
                before,
                after: before.order === order
                    ? before
                    : placementDocument(before, before.parentId, order, reader.state, now, this.schemes),
            }))
            .filter(({ before, after }) => before !== after)
            .sort((left, right) => compareUtf8(left.before.nodeId, right.before.nodeId));

        const rbacReader = new RbacScopeReader(this.repository, this.schemes, reader.state, session);
        let sourceRewrite: PreparedSourceRewriteExecution | null = null;
        if (conflicts.length === 0 && sourceImpacts.length > 0) {
            sourceRewrite = await prepareSourceRewriteExecution({
                rbacReader,
                menuReader: reader,
                impacts: sourceImpacts,
                decision: input.sourceRewrite,
                now,
            });
            conflicts.push(...sourceRewrite.conflicts);
        }

        const estimatedSourceMutations = sourceRewrite?.sourceMutationCount ?? sourceImpacts.length;
        const mutationCount = deletedNodes.length + nodeUpdates.length + bindingUpdates.length + estimatedSourceMutations;
        if (mutationCount > 1_000) {
            conflicts.push({
                id: "menu-removal-capacity",
                code: "LIMIT_EXCEEDED",
                message: `Menu removal requires ${mutationCount} mutations; the atomic limit is 1000.`,
            });
        }

        let affectedUsers = emptyAffectedUsers(`menu-remove:${nodeId}`);
        let capacity: AuthorizationCapacityAssessment | null = null;
        if (conflicts.length === 0 && sourceRewrite !== null) {
            const sourceRoleIds = [...new Set(sourceRecords.map((record) => record.rule.roleId))].sort(compareUtf8);
            const affectedRoleIds = await loadAffectedRoleIds(
                this.repository,
                rbacReader,
                sourceRoleIds,
                session,
            );
            affectedUsers = await loadAffectedUsers(
                this.repository,
                rbacReader,
                affectedRoleIds,
                `menu-remove:${nodeId}`,
                session,
            );
            let expands = false;
            let restricts = false;
            for (const impact of sourceImpacts) {
                const resolution = input.sourceRewrite.mode === "apply"
                    ? input.sourceRewrite.resolutions[impact.record.source.sourceId]
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
            const availabilityReaders = createMenuAvailabilityReaders({
                rbacReader,
                menuReader: reader,
                after: { rules: sourceRewrite.afterRulesByRole },
            });
            const onlyRevokes = sourceImpacts.every((impact) =>
                input.sourceRewrite.mode === "apply"
                && input.sourceRewrite.resolutions[impact.record.source.sourceId]?.action === "revoke");
            capacity = await assessAuthorizationCapacity({
                repository: this.repository,
                reader: rbacReader,
                affectedUsers,
                overlay: {},
                beforeReader: availabilityReaders.before,
                afterReader: availabilityReaders.after,
                structuralCapacityNonIncreasing: onlyRevokes,
                knownCapacityRiskMayBeAcknowledged: false,
                accessHint,
                session,
            });
            const messages = capacityMessages(capacity);
            conflicts.push(...messages.conflicts);
        }

        const revokedSources = sourceImpacts.filter((impact) =>
            input.sourceRewrite.mode === "apply"
            && input.sourceRewrite.resolutions[impact.record.source.sourceId]?.action === "revoke").length;
        const sourceUpdates = Math.max(0, estimatedSourceMutations - revokedSources);
        const completePlan = toPolicyValue({
            rootNodeId: nodeId,
            input,
            nodes: deletedNodes.map((node) => ({ before: menuNodeManifestItemFromDocument(node), after: null })),
            siblingUpdates: nodeUpdates.map(({ before, after }) => ({
                before: { nodeId: before.nodeId, parentId: before.parentId, order: before.order, revision: before.revision },
                after: { nodeId: after.nodeId, parentId: after.parentId, order: after.order, revision: after.revision },
            })),
            apiBindings: bindingUpdates.map(({ before, after }) => ({
                before: { ...apiBindingManifestItemFromDocument(before), revision: before.revision },
                after: { ...apiBindingManifestItemFromDocument(after), revision: after.revision },
            })),
            sourceImpacts: sourceImpacts.map((impact) => impact.public),
            sourceRewrite: sourceRewrite?.auditPlan ?? null,
            affectedUsers: capacity?.affectedUsers ?? sampledCountSample([]),
            capacityDigest: capacity?.digest ?? null,
        });
        try {
            assertAuditChangeBudget({ kind: "menu-remove", plan: completePlan });
        } catch (error) {
            if (!(error instanceof PermissionCoreError) || error.code !== "LIMIT_EXCEEDED") throw error;
            conflicts.push({
                id: "menu-removal-audit-budget",
                code: "LIMIT_EXCEEDED",
                message: "The complete menu removal audit diff exceeds its atomic byte budget.",
            });
        }

        const warnings = capacity === null ? [] : capacityMessages(capacity).warnings;
        const inputHash = digestCanonical({ nodeId, input });
        const revisionEntities = [{
            kind: "menu-node" as const,
            id: nodeId,
            revision: inventory.current.revision,
        }];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities, sourceImpacts.length > 0);
        const planHash = menuPlanHash("menus.previewRemove", inputHash, expectedRevisions, completePlan);
        const summarySamples: BatchMutationSummary["samples"]["items"] = [
            ...deletedNodes.map((node) => ({ id: node.nodeId, outcome: "deleted" as const })),
            ...nodeUpdates.map(({ before }) => ({ id: before.nodeId, outcome: "updated" as const })),
            ...bindingUpdates.map(({ before }) => ({ id: before.bindingId, outcome: "updated" as const })),
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
            method: "menus.previewRemove",
            reader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: sourceRewriteDecisionDetailCount(sourceImpacts),
            publicPlan: (budget) => {
                const publicSourceImpacts = budgetSourceImpacts(sourceImpacts, budget);
                return deepFreeze({
                    rootNodeId: nodeId,
                    cascade: input.cascade,
                    nodes: budget.bounded(deletedNodeIds),
                    detachedApiBindings: budget.bounded(bindingUpdates.map(({ before }) => before.bindingId)),
                    sourceImpacts: publicSourceImpacts,
                });
            },
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts({
                updated: nodeUpdates.length + bindingUpdates.length + sourceUpdates,
                deleted: deletedNodes.length + revokedSources,
                conflicted: conflicts.length,
            }),
            summarySamples,
            warnings,
            conflicts,
            capacity,
            current: inventory.current,
            deletedNodes,
            nodeUpdates,
            bindingUpdates,
            sourceImpacts,
            sourceRewrite,
            affectedUsers,
        };
    }

    async previewRemove(
        scope: PermissionScope,
        nodeIdInput: string,
        inputValue: MenuRemoveInput,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<MenuRemovalPlan>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const input = normalizeMenuRemoveInput(inputValue);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planRemoval(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                nodeId,
                input,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async remove(
        scope: PermissionScope,
        nodeIdInput: string,
        inputValue: MenuRemoveInput,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const input = normalizeMenuRemoveInput(inputValue);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "menus.remove",
            action: "remove",
            resource: `menu:${nodeId}`,
            request: toPolicyValue({ nodeId, input, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay: decodeBatchMutationSummaryReplay,
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.planRemoval(reader, nodeId, input, now, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                const aggregate = planMenuAggregate({
                    state,
                    beforeNodes: [
                        ...prepared.deletedNodes,
                        ...prepared.nodeUpdates.map((entry) => entry.before),
                    ],
                    afterNodes: prepared.nodeUpdates.map((entry) => entry.after),
                    beforeBindings: prepared.bindingUpdates.map((entry) => entry.before),
                    afterBindings: prepared.bindingUpdates.map((entry) => entry.after),
                });
                for (const node of [...prepared.deletedNodes].sort((left, right) => compareUtf8(right.nodeId, left.nodeId))) {
                    const result = await this.repository.collections.menuNodes.deleteOne(
                        { scopeKey: state.scopeKey, nodeId: node.nodeId, revision: node.revision },
                        writeOptions(transaction.session),
                    );
                    if (result.deletedCount !== 1) revisionConflict(`menu:${node.nodeId}`, node.revision);
                }
                for (const update of prepared.nodeUpdates) {
                    const result = await this.repository.collections.menuNodes.updateOne(
                        { scopeKey: state.scopeKey, nodeId: update.before.nodeId, revision: update.before.revision },
                        nodeUpdateDocument(update.after),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`menu:${update.before.nodeId}`, update.before.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure("menu removal sibling compaction did not update exactly one node");
                }
                for (const update of prepared.bindingUpdates) {
                    const result = await this.repository.collections.apiBindings.updateOne(
                        { scopeKey: state.scopeKey, bindingId: update.before.bindingId, revision: update.before.revision },
                        bindingUpdateDocument(update.after),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`api-binding:${update.before.bindingId}`, update.before.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure("menu removal owner detachment did not update exactly one API binding");
                }
                if (prepared.sourceRewrite !== null) {
                    await applySourceRewriteExecution({
                        repository: this.repository,
                        schemes: this.schemes,
                        session: transaction.session,
                        prepared: prepared.sourceRewrite,
                    });
                }

                const survivingDeletedNodes = await reader.readNodesByIds(prepared.deletedNodes.map((node) => node.nodeId));
                if (survivingDeletedNodes.size !== 0) databaseWriteFailure("removed menu nodes are still visible in the transaction");
                for (const update of prepared.nodeUpdates) {
                    const postImage = await reader.requireNode(update.after.nodeId);
                    if (canonicalString(postImage) !== canonicalString(update.after)) {
                        databaseWriteFailure(`menu sibling ${update.after.nodeId} post-image differs from its removal plan`);
                    }
                }
                for (const update of prepared.bindingUpdates) {
                    const postImage = await reader.requireBinding(update.after.bindingId);
                    if (canonicalString(postImage) !== canonicalString(update.after)) {
                        databaseWriteFailure(`API binding ${update.after.bindingId} post-image differs from its owner-detachment plan`);
                    }
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
                        kind: "menu-node",
                        id: nodeId,
                        before: prepared.current.revision,
                        after: prepared.current.revision + 1,
                    },
                    revisionImpact: { rbac: changesAuthorization, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "menu-remove", plan: prepared.completePlan },
                    cacheTargets: changesAuthorization
                        ? authorizationCacheTargets(state.scopeKey, prepared.affectedUsers)
                        : [`scope:${state.scopeKey}:menu`],
                    validatedPlanHash: prepared.planHash,
                    capacity: toPolicyValue(prepared.capacity),
                };
            },
        });
    }

    private async planMove(
        reader: MenuScopeReader,
        input: ReturnType<typeof normalizeMenuMoveInput>,
        now: number,
    ): Promise<PreparedMovePlan> {
        const inventory = await reader.readAllNodes();
        const graph = validateMenuGraph(inventory);
        const current = graph.nodes.get(input.nodeId);
        if (current === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${input.nodeId} was not found.`);
        if (current.status === "deprecated") {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated menu nodes cannot be moved.", {
                details: { kind: "validation", field: "move.nodeId", reason: "menu node is deprecated" },
            });
        }
        const parent = input.parentId === null ? undefined : graph.nodes.get(input.parentId);
        if (input.parentId !== null && parent === undefined) hierarchyInvalid(`parent ${input.parentId} does not exist`);
        if (parent === undefined && current.type === "button") hierarchyInvalid("button nodes cannot be roots");
        if (parent !== undefined && !parentAllows(parent.type, current.type)) {
            hierarchyInvalid(`${parent.type} cannot contain ${current.type}`);
        }

        const descendants: string[] = [];
        const queue = [...(graph.children.get(current.nodeId) ?? [])];
        while (queue.length > 0) {
            const node = queue.shift()!;
            descendants.push(node.nodeId);
            queue.push(...(graph.children.get(node.nodeId) ?? []));
        }
        if (input.parentId !== null && descendants.includes(input.parentId)) {
            hierarchyInvalid("a menu node cannot move below one of its descendants");
        }
        const currentDepth = graph.depths.get(current.nodeId)!;
        const maximumRelativeDepth = descendants.reduce((maximum, nodeId) =>
            Math.max(maximum, graph.depths.get(nodeId)! - currentDepth), 0);
        const nextDepth = parent === undefined ? 1 : graph.depths.get(parent.nodeId)! + 1;
        if (nextDepth + maximumRelativeDepth > MAX_MENU_DEPTH) {
            hierarchyInvalid(`the moved subtree would exceed depth ${MAX_MENU_DEPTH}`);
        }

        const currentSiblings = [...(graph.children.get(current.parentId) ?? [])];
        const destinationWithoutTarget = [...(graph.children.get(input.parentId) ?? [])]
            .filter((node) => node.nodeId !== current.nodeId);
        const anchorId = input.beforeId ?? input.afterId;
        let insertionIndex = destinationWithoutTarget.length;
        if (anchorId !== undefined) {
            const anchorIndex = destinationWithoutTarget.findIndex((node) => node.nodeId === anchorId);
            if (anchorIndex < 0) hierarchyInvalid(`move anchor ${anchorId} is not a target-parent sibling`);
            insertionIndex = input.beforeId === undefined ? anchorIndex + 1 : anchorIndex;
        }
        const destination = [...destinationWithoutTarget];
        destination.splice(insertionIndex, 0, current);
        const groups = new Map<string | null, readonly Readonly<InternalMenuNodeDocument>[]>()
            .set(input.parentId, destination);
        if (current.parentId !== input.parentId) {
            groups.set(current.parentId, currentSiblings.filter((node) => node.nodeId !== current.nodeId));
        }
        const updates: Array<{ before: Readonly<InternalMenuNodeDocument>; after: Readonly<InternalMenuNodeDocument> }> = [];
        for (const [parentId, siblings] of groups) {
            siblings.forEach((node, order) => {
                if (node.parentId !== parentId || node.order !== order) {
                    updates.push({
                        before: node,
                        after: placementDocument(node, parentId, order, reader.state, now, this.schemes),
                    });
                }
            });
        }
        updates.sort((left, right) => compareUtf8(left.before.nodeId, right.before.nodeId));
        const conflicts = updates.length > 1_000
            ? [{ id: "menu-move-capacity", code: "LIMIT_EXCEEDED", message: `Move requires ${updates.length} node writes; the atomic limit is 1000.` }]
            : [];
        const siblingsBefore = orderedCountSample(currentSiblings.map((node) => node.nodeId));
        const siblingsAfter = orderedCountSample(destination.map((node) => node.nodeId));
        const completePlan = toPolicyValue({
            nodeId: current.nodeId,
            fromParentId: current.parentId,
            toParentId: input.parentId,
            siblingsBefore: currentSiblings.map((node) => node.nodeId),
            siblingsAfter: destination.map((node) => node.nodeId),
            descendants,
            updates: updates.map(({ before, after }) => ({
                nodeId: before.nodeId,
                before: { parentId: before.parentId, order: before.order, revision: before.revision },
                after: { parentId: after.parentId, order: after.order, revision: after.revision },
            })),
        });
        const inputHash = digestCanonical({ input });
        const revisionEntities = [{ kind: "menu-node" as const, id: current.nodeId, revision: current.revision }];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities);
        const planHash = menuPlanHash("menus.previewMove", inputHash, expectedRevisions, completePlan);
        const summarySamples: BatchMutationSummary["samples"]["items"] = updates.length === 0
            ? [{ id: current.nodeId, outcome: "unchanged" }]
            : updates.map(({ before }) => ({ id: before.nodeId, outcome: "updated" as const }));
        return {
            method: "menus.previewMove",
            reader,
            inputHash,
            planHash,
            completePlan,
            publicPlan: (budget) => deepFreeze({
                nodeId: current.nodeId,
                fromParentId: current.parentId,
                toParentId: input.parentId,
                siblingsBefore: budgetCountSample(siblingsBefore, budget),
                siblingsAfter: budgetCountSample(siblingsAfter, budget),
                descendantCount: descendants.length,
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts({
                updated: updates.length,
                unchanged: updates.length === 0 ? 1 : 0,
                conflicted: conflicts.length,
            }),
            summarySamples,
            warnings: [],
            conflicts,
            capacity: null,
            current,
            updates,
        };
    }

    async previewMove(
        scope: PermissionScope,
        inputValue: MenuMoveInput,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<MenuMovePlan>> {
        const input = normalizeMenuMoveInput(inputValue);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planMove(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                input,
                issuedAt,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async move(
        scope: PermissionScope,
        inputValue: MenuMoveInput,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<MenuNode>> {
        const input = normalizeMenuMoveInput(inputValue);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "menus.move",
            action: "move",
            resource: `menu:${input.nodeId}`,
            request: toPolicyValue({ input, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay: (value) => decodeMenuNodeReplay(value, this.schemes),
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.planMove(reader, input, now);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                if (prepared.updates.length === 0) {
                    const data = menuNodeView(prepared.current);
                    return {
                        changed: false,
                        data,
                        primaryRevision: prepared.current.revision,
                        entity: { kind: "menu-node", id: input.nodeId, before: prepared.current.revision, after: prepared.current.revision },
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "menu-move", plan: prepared.completePlan },
                        cacheTargets: [],
                        validatedPlanHash: prepared.planHash,
                    };
                }
                const aggregate = planMenuAggregate({
                    state,
                    beforeNodes: prepared.updates.map((entry) => entry.before),
                    afterNodes: prepared.updates.map((entry) => entry.after),
                });
                for (const update of prepared.updates) {
                    const result = await this.repository.collections.menuNodes.updateOne(
                        { scopeKey: state.scopeKey, nodeId: update.before.nodeId, revision: update.before.revision },
                        nodeUpdateDocument(update.after),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`menu:${update.before.nodeId}`, update.before.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure("menu move did not update exactly one planned node");
                }
                const postImage = await reader.requireNode(input.nodeId);
                const expectedTarget = prepared.updates.find((entry) => entry.before.nodeId === input.nodeId)!.after;
                if (canonicalString(postImage) !== canonicalString(expectedTarget)) {
                    databaseWriteFailure("menu move target post-image differs from the planned document");
                }
                const data = menuNodeView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: { kind: "menu-node", id: input.nodeId, before: prepared.current.revision, after: data.revision },
                    revisionImpact: { rbac: false, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "menu-move", plan: prepared.completePlan },
                    cacheTargets: [`scope:${state.scopeKey}:menu`],
                    validatedPlanHash: prepared.planHash,
                };
            },
        });
    }

    private async planReorder(
        reader: MenuScopeReader,
        input: ReturnType<typeof normalizeMenuReorderInput>,
        now: number,
    ): Promise<PreparedReorderPlan> {
        const inventory = await reader.readAllNodes();
        const graph = validateMenuGraph(inventory);
        if (input.parentId !== null && !graph.nodes.has(input.parentId)) hierarchyInvalid(`parent ${input.parentId} does not exist`);
        const current = [...(graph.children.get(input.parentId) ?? [])];
        const currentIds = current.map((node) => node.nodeId);
        const expectedSet = [...currentIds].sort(compareUtf8);
        const inputSet = [...input.orderedNodeIds].sort(compareUtf8);
        if (canonicalString(expectedSet) !== canonicalString(inputSet)) {
            hierarchyInvalid("orderedNodeIds must contain exactly the current direct children");
        }
        const byId = new Map(current.map((node) => [node.nodeId, node] as const));
        const updates = input.orderedNodeIds
            .map((nodeId, order) => ({ node: byId.get(nodeId)!, order }))
            .filter(({ node, order }) => node.order !== order)
            .map(({ node, order }) => ({
                before: node,
                after: placementDocument(node, input.parentId, order, reader.state, now, this.schemes),
            }))
            .sort((left, right) => compareUtf8(left.before.nodeId, right.before.nodeId));
        const conflicts = updates.length > 1_000
            ? [{ id: "menu-reorder-capacity", code: "LIMIT_EXCEEDED", message: `Reorder requires ${updates.length} node writes; the atomic limit is 1000.` }]
            : [];
        const before = orderedCountSample(currentIds);
        const after = orderedCountSample(input.orderedNodeIds);
        const completePlan = toPolicyValue({
            parentId: input.parentId,
            before: currentIds,
            after: input.orderedNodeIds,
            updates: updates.map(({ before: oldNode, after: newNode }) => ({
                nodeId: oldNode.nodeId,
                before: { order: oldNode.order, revision: oldNode.revision },
                after: { order: newNode.order, revision: newNode.revision },
            })),
        });
        const inputHash = digestCanonical({ input });
        const expectedRevisions = expectedMenuRevisions(reader);
        const planHash = menuPlanHash("menus.previewReorder", inputHash, expectedRevisions, completePlan);
        const summarySamples: BatchMutationSummary["samples"]["items"] = updates.length === 0
            ? input.orderedNodeIds.map((id) => ({ id, outcome: "unchanged" as const }))
            : updates.map(({ before: node }) => ({ id: node.nodeId, outcome: "updated" as const }));
        return {
            method: "menus.previewReorder",
            reader,
            inputHash,
            planHash,
            completePlan,
            publicPlan: (budget) => deepFreeze({
                parentId: input.parentId,
                before: budgetCountSample(before, budget),
                after: budgetCountSample(after, budget),
            }),
            expectedRevisions,
            revisionEntities: [],
            summaryCounts: emptyBatchCounts({
                updated: updates.length,
                unchanged: updates.length === 0 ? input.orderedNodeIds.length : input.orderedNodeIds.length - updates.length,
                conflicted: conflicts.length,
            }),
            summarySamples,
            warnings: [],
            conflicts,
            capacity: null,
            updates,
        };
    }

    async previewReorder(
        scope: PermissionScope,
        inputValue: MenuReorderInput,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<MenuReorderPlan>> {
        const input = normalizeMenuReorderInput(inputValue);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planReorder(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                input,
                issuedAt,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async reorder(
        scope: PermissionScope,
        inputValue: MenuReorderInput,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        const input = normalizeMenuReorderInput(inputValue);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "menus.reorder",
            action: "reorder",
            resource: `menu-parent:${input.parentId ?? "root"}`,
            request: toPolicyValue({ input, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay: decodeBatchMutationSummaryReplay,
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.planReorder(reader, input, now);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                const changed = prepared.updates.length > 0;
                const data: BatchMutationSummary = deepFreeze({
                    ...prepared.summaryCounts,
                    samples: new DetailBudgetAllocator().bounded(sortBatchMutationSamples(prepared.summarySamples)),
                });
                if (!changed) {
                    return {
                        changed: false,
                        data,
                        primaryRevision: state.menuRevision,
                        entity: { kind: "scope", id: `menu:${state.scopeKey}`, before: state.menuRevision, after: state.menuRevision },
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "menu-reorder", plan: prepared.completePlan },
                        cacheTargets: [],
                        validatedPlanHash: prepared.planHash,
                    };
                }
                const aggregate = planMenuAggregate({
                    state,
                    beforeNodes: prepared.updates.map((entry) => entry.before),
                    afterNodes: prepared.updates.map((entry) => entry.after),
                });
                for (const update of prepared.updates) {
                    const result = await this.repository.collections.menuNodes.updateOne(
                        { scopeKey: state.scopeKey, nodeId: update.before.nodeId, revision: update.before.revision },
                        nodeUpdateDocument(update.after),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`menu:${update.before.nodeId}`, update.before.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure("menu reorder did not update exactly one planned node");
                }
                return {
                    changed: true,
                    data,
                    primaryRevision: state.menuRevision + 1,
                    entity: { kind: "scope", id: `menu:${state.scopeKey}`, before: state.menuRevision, after: state.menuRevision + 1 },
                    revisionImpact: { rbac: false, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "menu-reorder", plan: prepared.completePlan },
                    cacheTargets: [`scope:${state.scopeKey}:menu`],
                    validatedPlanHash: prepared.planHash,
                };
            },
        });
    }
}
