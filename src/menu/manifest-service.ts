import type { MongoSession } from "monsqlize";
import type {
    ApiBindingCreateInput,
    AuthorizationCapacityAssessment,
    BatchMutationSummary,
    CursorQuery,
    EntityStatus,
    FrontendMenuManifest,
    ImpactPreview,
    ManagementConflict,
    MenuManifestExportRecord,
    MenuManifestInput,
    MenuManifestNodeInput,
    MenuManifestPlan,
    MutationResult,
    PageResult,
    PermissionRuleInput,
    PermissionScope,
    PolicyValue,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionVectorOptions,
    SourceRewriteDecision,
    VersionedResult,
} from "../types";
import type { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { SignedTokenCodec } from "../internal/signed-token";
import {
    assertAuditChangeBudget,
    type InternalApiBindingDocument,
    type InternalMenuNodeDocument,
} from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import { mapDatabaseReadError, type PermissionRepository } from "../persistence/repository";
import {
    MAX_API_BINDING_COUNT,
    MAX_MENU_NODE_COUNT,
    MAX_REPLACE_MANIFEST_BYTES,
} from "../persistence/scope-state";
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
import {
    DetailBudgetAllocator,
    assertAuthorizationResponseBudget,
    revisionVector,
} from "../rbac/result";
import { RbacScopeReader } from "../rbac/store";
import { normalizeRbacId } from "../rbac/validation";
import { calculateReplaceManifestBytes, planMenuAggregate } from "./aggregate";
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
    materializeApiBindingDocument,
    materializeMenuNodeDocument,
    menuNodeDocumentFromInput,
    menuNodeManifestItemFromDocument,
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
import { readNestedDuplicate, revisionConflict } from "./api-mutations";
import { validateMenuGraph } from "./queries";
import {
    applySourceRewriteExecution,
    budgetSourceImpacts,
    createMenuAvailabilityReaders,
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
import { MAX_MENU_DEPTH, MenuReadStore, MenuScopeReader } from "./store";
import { decodeBatchMutationSummaryReplay } from "./views";
import { exactMenuRecord, normalizeMenuManifestInput } from "./validation";

const CURSOR_TTL_MS = 15 * 60 * 1_000;
const CURSOR_MAX_BYTES = 8 * 1_024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const MANIFEST_MUTATION_LIMIT = 1_000;

type NormalizedManifest = ReturnType<typeof normalizeMenuManifestInput>;
type NormalizedManifestNode = NormalizedManifest["nodes"][number];
type NormalizedManifestBinding = NormalizedManifest["apiBindings"][number];

interface DocumentUpdate<T> {
    readonly before: Readonly<T>;
    readonly after: Readonly<T>;
}

interface PreparedManifestPlan extends PreparedMenuPlan<MenuManifestPlan> {
    readonly nodeInserts: readonly Readonly<InternalMenuNodeDocument>[];
    readonly nodeUpdates: readonly DocumentUpdate<InternalMenuNodeDocument>[];
    readonly nodeDeletes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly bindingInserts: readonly Readonly<InternalApiBindingDocument>[];
    readonly bindingUpdates: readonly DocumentUpdate<InternalApiBindingDocument>[];
    readonly bindingDeletes: readonly Readonly<InternalApiBindingDocument>[];
    readonly targetNodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly targetBindings: readonly Readonly<InternalApiBindingDocument>[];
    readonly sourceImpacts: readonly PreparedSourceImpact[];
    readonly sourceRewrite: PreparedSourceRewriteExecution | null;
    readonly affectedUsers: AffectedUsers;
}

interface ManifestCursorAnchor {
    readonly kind: MenuManifestExportRecord["kind"];
    readonly id: string;
}

interface ManifestCursorProgress {
    readonly menuNodeCount: number;
    readonly apiBindingCount: number;
    readonly itemBytes: number;
}

interface ManifestPageRecord {
    readonly record: MenuManifestExportRecord;
    readonly manifestItemBytes: number;
}

function advanceManifestCursorProgress(
    initial: ManifestCursorProgress | undefined,
    selected: readonly ManifestPageRecord[],
): ManifestCursorProgress {
    let menuNodeCount = initial?.menuNodeCount ?? 0;
    let apiBindingCount = initial?.apiBindingCount ?? 0;
    let itemBytes = initial?.itemBytes ?? 0;
    for (const selectedRecord of selected) {
        if (selectedRecord.record.kind === "node") menuNodeCount += 1;
        else apiBindingCount += 1;
        itemBytes += selectedRecord.manifestItemBytes;
        if (!Number.isSafeInteger(itemBytes) || itemBytes > MAX_REPLACE_MANIFEST_BYTES) {
            persistedInvalid("manifest page progress contains an invalid item byte total");
        }
    }
    return deepFreeze({ menuNodeCount, apiBindingCount, itemBytes });
}

function readOptions(session?: MongoSession) {
    return { ...(session === undefined ? {} : { session }), cache: 0, collation: SIMPLE_COLLATION };
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
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu manifest state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The menu manifest write result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function parentAllows(parentType: InternalMenuNodeDocument["type"], childType: InternalMenuNodeDocument["type"]) {
    if (parentType === "directory") return childType !== "button";
    if (parentType === "menu") return childType !== "directory";
    if (parentType === "page") return childType === "button";
    return false;
}

function nodeManifestEqual(
    left: Readonly<InternalMenuNodeDocument>,
    right: Readonly<InternalMenuNodeDocument>,
) {
    return canonicalString(menuNodeManifestItemFromDocument(left))
        === canonicalString(menuNodeManifestItemFromDocument(right));
}

function bindingManifestEqual(
    left: Readonly<InternalApiBindingDocument>,
    right: Readonly<InternalApiBindingDocument>,
) {
    return canonicalString(apiBindingManifestItemFromDocument(left))
        === canonicalString(apiBindingManifestItemFromDocument(right));
}

function duplicateInputConflicts(input: NormalizedManifest) {
    const conflicts: ManagementConflict[] = [];
    const nodeIds = new Set<string>();
    const listedOrders = new Map<string, string>();
    for (const node of input.nodes) {
        if (nodeIds.has(node.id)) {
            conflicts.push({
                id: `manifest-node:${node.id}`,
                code: "MENU_ALREADY_EXISTS",
                message: `The manifest contains duplicate menu node ${node.id}.`,
            });
        }
        nodeIds.add(node.id);
        const orderKey = canonicalString([node.parentId ?? null, node.order]);
        const existing = listedOrders.get(orderKey);
        if (existing !== undefined && existing !== node.id) {
            conflicts.push({
                id: `manifest-order:${digestCanonical({ parentId: node.parentId ?? null, order: node.order })}`,
                code: "MENU_HIERARCHY_INVALID",
                message: `Listed siblings ${existing} and ${node.id} use the same order ${node.order}.`,
            });
        } else {
            listedOrders.set(orderKey, node.id);
        }
    }
    const bindingIds = new Set<string>();
    for (const binding of input.apiBindings) {
        if (bindingIds.has(binding.id)) {
            conflicts.push({
                id: `manifest-api-binding:${binding.id}`,
                code: "API_BINDING_ALREADY_EXISTS",
                message: `The manifest contains duplicate API binding ${binding.id}.`,
            });
        }
        bindingIds.add(binding.id);
    }
    return conflicts;
}

function firstNodesById(nodes: readonly NormalizedManifestNode[]) {
    const result = new Map<string, NormalizedManifestNode>();
    for (const node of nodes) {
        if (!result.has(node.id)) result.set(node.id, node);
    }
    return result;
}

function firstBindingsById(bindings: readonly NormalizedManifestBinding[]) {
    const result = new Map<string, NormalizedManifestBinding>();
    for (const binding of bindings) {
        if (!result.has(binding.id)) result.set(binding.id, binding);
    }
    return result;
}

function buildTargetNodes(input: {
    readonly manifest: NormalizedManifest;
    readonly current: readonly Readonly<InternalMenuNodeDocument>[];
    readonly scopeKey: string;
    readonly scope: Readonly<PermissionScope>;
    readonly now: number;
}) {
    const currentById = new Map(input.current.map((node) => [node.nodeId, node] as const));
    const listedById = firstNodesById(input.manifest.nodes);
    const candidates = new Map<string, NormalizedManifestNode>();
    if (input.manifest.mode === "merge") {
        for (const node of input.current) {
            candidates.set(node.nodeId, menuNodeManifestItemFromDocument(node) as NormalizedManifestNode);
        }
    }
    for (const [nodeId, node] of listedById) candidates.set(nodeId, node);

    const groups = new Map<string | null, NormalizedManifestNode[]>();
    for (const node of candidates.values()) {
        const group = groups.get(node.parentId) ?? [];
        group.push(node);
        groups.set(node.parentId, group);
    }
    const denseOrder = new Map<string, number>();
    for (const group of groups.values()) {
        group.sort((left, right) => left.order - right.order || compareUtf8(left.id, right.id));
        group.forEach((node, order) => denseOrder.set(node.id, order));
    }

    const target = [...candidates.values()].map((node) => {
        const current = currentById.get(node.id);
        const { order: _order, ...create } = node;
        const candidate = menuNodeDocumentFromInput(
            input.scopeKey,
            input.scope,
            create,
            denseOrder.get(node.id)!,
            current === undefined ? 1 : current.revision + 1,
            current?.createdAt ?? input.now,
            input.now,
        );
        return current !== undefined && nodeManifestEqual(current, candidate) ? current : candidate;
    }).sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
    return deepFreeze({ target, currentById, listedById });
}

function buildTargetBindings(input: {
    readonly manifest: NormalizedManifest;
    readonly current: readonly Readonly<InternalApiBindingDocument>[];
    readonly scopeKey: string;
    readonly scope: Readonly<PermissionScope>;
    readonly now: number;
}) {
    const currentById = new Map(input.current.map((binding) => [binding.bindingId, binding] as const));
    const listedById = firstBindingsById(input.manifest.apiBindings);
    const candidates = new Map<string, NormalizedManifestBinding>();
    if (input.manifest.mode === "merge") {
        for (const binding of input.current) {
            candidates.set(binding.bindingId, apiBindingManifestItemFromDocument(binding) as NormalizedManifestBinding);
        }
    }
    for (const [bindingId, binding] of listedById) candidates.set(bindingId, binding);
    const target = [...candidates.values()].map((binding) => {
        const current = currentById.get(binding.id);
        const candidate = apiBindingDocumentFromInput(
            input.scopeKey,
            input.scope,
            binding,
            current === undefined ? 1 : current.revision + 1,
            current?.createdAt ?? input.now,
            input.now,
        );
        return current !== undefined && bindingManifestEqual(current, candidate) ? current : candidate;
    }).sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
    return deepFreeze({ target, currentById, listedById });
}

function targetNodeConflicts(input: {
    readonly target: readonly Readonly<InternalMenuNodeDocument>[];
    readonly currentById: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
    readonly listedById: ReadonlyMap<string, NormalizedManifestNode>;
}) {
    const conflicts: ManagementConflict[] = [];
    const nodes = new Map<string, Readonly<InternalMenuNodeDocument>>();
    const paths = new Map<string, string>();
    const names = new Map<string, string>();
    const codes = new Map<string, string>();
    for (const node of input.target) {
        nodes.set(node.nodeId, node);
        const current = input.currentById.get(node.nodeId);
        if (current !== undefined && input.listedById.has(node.nodeId) && current.type !== node.type) {
            conflicts.push({
                id: `manifest-node-type:${node.nodeId}`,
                code: "INVALID_ARGUMENT",
                message: `Existing menu node ${node.nodeId} cannot change type from ${current.type} to ${node.type}.`,
            });
        }
        for (const [value, owners, label] of [
            [node.path, paths, "path"],
            [node.name, names, "name"],
            [node.code === undefined ? undefined : canonicalString([node.parentId, node.code]), codes, "sibling code"],
        ] as const) {
            if (value === undefined) continue;
            const owner = owners.get(value);
            if (owner !== undefined && owner !== node.nodeId) {
                conflicts.push({
                    id: `manifest-node-${label}:${digestCanonical({ value })}`,
                    code: "MENU_ALREADY_EXISTS",
                    message: `Menu nodes ${owner} and ${node.nodeId} have the same ${label}.`,
                });
            } else {
                owners.set(value, node.nodeId);
            }
        }
    }
    for (const node of input.target) {
        if (node.type === "button" && node.parentId === null) {
            conflicts.push({
                id: `manifest-parent:${node.nodeId}`,
                code: "MENU_HIERARCHY_INVALID",
                message: `Button ${node.nodeId} cannot be a root node.`,
            });
            continue;
        }
        const seen = new Set<string>();
        let current: Readonly<InternalMenuNodeDocument> | undefined = node;
        let depth = 0;
        while (current !== undefined) {
            if (seen.has(current.nodeId)) {
                conflicts.push({
                    id: `manifest-cycle:${node.nodeId}`,
                    code: "MENU_HIERARCHY_INVALID",
                    message: `Menu node ${node.nodeId} participates in a parent cycle.`,
                });
                break;
            }
            seen.add(current.nodeId);
            depth += 1;
            if (depth > MAX_MENU_DEPTH) {
                conflicts.push({
                    id: `manifest-depth:${node.nodeId}`,
                    code: "MENU_HIERARCHY_INVALID",
                    message: `Menu node ${node.nodeId} exceeds depth ${MAX_MENU_DEPTH}.`,
                });
                break;
            }
            if (current.parentId === null) break;
            const parent = nodes.get(current.parentId);
            if (parent === undefined) {
                conflicts.push({
                    id: `manifest-parent:${node.nodeId}`,
                    code: "MENU_NOT_FOUND",
                    message: `Parent ${current.parentId} for menu node ${current.nodeId} does not exist in the target inventory.`,
                });
                break;
            }
            if (!parentAllows(parent.type, current.type)) {
                conflicts.push({
                    id: `manifest-parent-type:${current.nodeId}`,
                    code: "MENU_HIERARCHY_INVALID",
                    message: `${parent.type} ${parent.nodeId} cannot contain ${current.type} ${current.nodeId}.`,
                });
                break;
            }
            current = parent;
        }
    }
    return conflicts;
}

function targetBindingConflicts(
    bindings: readonly Readonly<InternalApiBindingDocument>[],
    nodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>,
) {
    const conflicts: ManagementConflict[] = [];
    const endpoints = new Map<string, string>();
    const availabilityModes = new Map<string, "all" | "any">();
    for (const binding of bindings) {
        const endpoint = canonicalString([binding.method, binding.path]);
        const endpointOwner = endpoints.get(endpoint);
        if (endpointOwner !== undefined && endpointOwner !== binding.bindingId) {
            conflicts.push({
                id: `manifest-api-endpoint:${digestCanonical({ method: binding.method, path: binding.path })}`,
                code: "API_BINDING_ALREADY_EXISTS",
                message: `${binding.method} ${binding.path} is assigned to both ${endpointOwner} and ${binding.bindingId}.`,
            });
        } else {
            endpoints.set(endpoint, binding.bindingId);
        }
        for (const owner of binding.owners) {
            const node = nodes.get(owner.id);
            if (node === undefined) {
                conflicts.push({
                    id: `manifest-api-owner:${binding.bindingId}:${owner.id}`,
                    code: "MENU_NOT_FOUND",
                    message: `API owner ${owner.id} does not exist in the target inventory.`,
                });
                continue;
            }
            if (node.type !== owner.type) {
                conflicts.push({
                    id: `manifest-api-owner:${binding.bindingId}:${owner.id}`,
                    code: "INVALID_ARGUMENT",
                    message: `API owner ${owner.id} is ${node.type}, not ${owner.type}.`,
                });
            }
            if (owner.availabilityGroup === undefined) continue;
            const key = canonicalString([owner.type, owner.id, owner.availabilityGroup]);
            const mode = availabilityModes.get(key);
            if (mode !== undefined && mode !== owner.availabilityMode) {
                conflicts.push({
                    id: `manifest-api-availability:${digestCanonical({ key })}`,
                    code: "INVALID_ARGUMENT",
                    message: `Availability group ${owner.availabilityGroup} mixes all and any modes.`,
                });
            } else {
                availabilityModes.set(key, owner.availabilityMode!);
            }
        }
    }
    return conflicts;
}

function bindingSourceSelector(
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
    return deepFreeze({ allSources, removedOwnerIds });
}

function sourceIsActive(
    record: MenuSourceRecord,
    nodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>,
    bindings: ReadonlyMap<string, Readonly<InternalApiBindingDocument>>,
) {
    const node = nodes.get(record.source.assetId);
    if (node === undefined || node.status !== "enabled") return false;
    if (record.source.contribution !== "api") return true;
    const binding = bindings.get(record.source.apiBindingId);
    return binding !== undefined
        && binding.status === "enabled"
        && binding.owners.some((owner) => owner.id === record.source.assetId);
}

function sourceResolutionSummary(
    impacts: readonly PreparedSourceImpact[],
    decision: SourceRewriteDecision,
    sourceMutationCount: number,
) {
    const revoked = impacts.filter((impact) =>
        decision.mode === "apply"
        && decision.resolutions[impact.record.source.sourceId]?.action === "revoke").length;
    return deepFreeze({ revoked, updated: Math.max(0, sourceMutationCount - revoked) });
}

function sourceDirection(input: {
    readonly affectedRecords: readonly MenuSourceRecord[];
    readonly impacts: readonly PreparedSourceImpact[];
    readonly decision: SourceRewriteDecision;
    readonly currentNodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
    readonly targetNodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
    readonly currentBindings: ReadonlyMap<string, Readonly<InternalApiBindingDocument>>;
    readonly targetBindings: ReadonlyMap<string, Readonly<InternalApiBindingDocument>>;
}) {
    let expands = false;
    let restricts = false;
    const impactBySourceId = new Map(input.impacts.map((impact) => [impact.record.source.sourceId, impact] as const));
    for (const record of input.affectedRecords) {
        const impact = impactBySourceId.get(record.source.sourceId);
        const resolution = input.decision.mode === "apply" && impact !== undefined
            ? input.decision.resolutions[record.source.sourceId]
            : undefined;
        if (resolution?.action === "replace" && resolution.replacementSemanticKey !== record.rule.semanticKey) {
            expands = true;
            restricts = true;
            continue;
        }
        if (resolution?.action === "revoke") {
            if (record.rule.effect === "allow") restricts = true;
            else expands = true;
            continue;
        }
        const before = sourceIsActive(record, input.currentNodes, input.currentBindings);
        const after = sourceIsActive(record, input.targetNodes, input.targetBindings);
        if (before === after) continue;
        if (after) {
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
    return deepFreeze({ expands, restricts, accessHint });
}

function nodePermissionRule(node: Readonly<InternalMenuNodeDocument>) {
    return node.permission === undefined
        ? []
        : [{ action: node.permission.action, resource: node.permission.resource } satisfies PermissionRuleInput];
}

function nodeDataRules(node: Readonly<InternalMenuNodeDocument>, dataResource: string) {
    return (node.dataPermissions ?? []).flatMap((permission) =>
        permission.resource !== dataResource
            ? []
            : [{
                action: permission.action,
                resource: permission.resource,
                ...(permission.where === undefined ? {} : { where: permission.where }),
            } satisfies PermissionRuleInput]);
}

function normalizeManifestPageQuery(value?: CursorQuery & { kind?: MenuManifestExportRecord["kind"] }) {
    const record = exactMenuRecord(value ?? {}, ["first", "after", "kind"], "query");
    const first = record.first ?? PAGE_DEFAULT;
    if (!Number.isSafeInteger(first) || (first as number) < 1 || (first as number) > PAGE_MAX) {
        throw validationError("INVALID_ARGUMENT", "query.first", `must be an integer between 1 and ${PAGE_MAX}`);
    }
    if (record.after !== undefined && (typeof record.after !== "string" || record.after.length === 0)) {
        throw validationError("INVALID_ARGUMENT", "query.after", "must be a non-empty cursor string");
    }
    if (record.kind !== undefined && record.kind !== "node" && record.kind !== "api-binding") {
        throw validationError("INVALID_ARGUMENT", "query.kind", "must be node or api-binding");
    }
    return deepFreeze({
        first: first as number,
        ...(record.after === undefined ? {} : { after: record.after as string }),
        ...(record.kind === undefined ? {} : { kind: record.kind as MenuManifestExportRecord["kind"] }),
    });
}

function cursorInvalid(reason: string): never {
    throw new PermissionCoreError("INVALID_CURSOR", "The cursor is invalid.", {
        details: { kind: "validation", field: "cursor", reason },
    });
}

function cursorStale(expected: number, current: number): never {
    throw new PermissionCoreError("CURSOR_STALE", "The cursor no longer matches current menu state.", {
        details: { kind: "cursor-stale", owner: "scope.menu", expected, current },
    });
}

function exactManifestCursorPayload(value: Readonly<Record<string, unknown>>) {
    const allowed = new Set([
        "version", "purpose", "coreNamespaceHash", "method", "scopeKey", "queryHash",
        "menuRevision", "anchor", "progress", "issuedAt", "expiresAt",
    ]);
    if (Object.keys(value).length !== allowed.size || Object.keys(value).some((key) => !allowed.has(key))) {
        cursorInvalid("contains an invalid payload shape");
    }
    if (
        value.method !== "menus.manifest.exportPage"
        || typeof value.scopeKey !== "string"
        || typeof value.queryHash !== "string"
        || !Number.isSafeInteger(value.menuRevision)
        || (value.menuRevision as number) < 0
        || !Number.isSafeInteger(value.issuedAt)
        || !Number.isSafeInteger(value.expiresAt)
        || (value.issuedAt as number) < 0
        || (value.expiresAt as number) <= (value.issuedAt as number)
        || value.anchor === null
        || typeof value.anchor !== "object"
        || Array.isArray(value.anchor)
        || value.progress === null
        || typeof value.progress !== "object"
        || Array.isArray(value.progress)
    ) {
        cursorInvalid("contains invalid payload fields");
    }
    const anchor = value.anchor as Readonly<Record<string, unknown>>;
    if (
        Object.keys(anchor).length !== 2
        || !Object.hasOwn(anchor, "kind")
        || !Object.hasOwn(anchor, "id")
        || (anchor.kind !== "node" && anchor.kind !== "api-binding")
    ) {
        cursorInvalid("contains an invalid manifest anchor");
    }
    let id: string;
    try {
        id = normalizeRbacId(anchor.id, "cursor.id");
    } catch {
        return cursorInvalid("contains an invalid manifest ID");
    }
    if (id !== anchor.id) cursorInvalid("contains a non-canonical manifest ID");
    const progress = value.progress as Readonly<Record<string, unknown>>;
    if (
        Object.keys(progress).length !== 3
        || !Object.hasOwn(progress, "menuNodeCount")
        || !Object.hasOwn(progress, "apiBindingCount")
        || !Object.hasOwn(progress, "itemBytes")
        || !Number.isSafeInteger(progress.menuNodeCount)
        || !Number.isSafeInteger(progress.apiBindingCount)
        || !Number.isSafeInteger(progress.itemBytes)
        || (progress.menuNodeCount as number) < 0
        || (progress.apiBindingCount as number) < 0
        || (progress.itemBytes as number) < 0
        || (progress.menuNodeCount as number) > MAX_MENU_NODE_COUNT
        || (progress.apiBindingCount as number) > MAX_API_BINDING_COUNT
        || (progress.itemBytes as number) > MAX_REPLACE_MANIFEST_BYTES
        || (
            anchor.kind === "node"
            ? (progress.menuNodeCount as number) < 1
            : (progress.apiBindingCount as number) < 1
        )
    ) {
        cursorInvalid("contains invalid manifest progress");
    }
    return deepFreeze({
        method: value.method,
        scopeKey: value.scopeKey,
        queryHash: value.queryHash,
        menuRevision: value.menuRevision as number,
        anchor: { kind: anchor.kind as MenuManifestExportRecord["kind"], id },
        progress: {
            menuNodeCount: progress.menuNodeCount as number,
            apiBindingCount: progress.apiBindingCount as number,
            itemBytes: progress.itemBytes as number,
        },
        issuedAt: value.issuedAt as number,
        expiresAt: value.expiresAt as number,
    });
}

function manifestRecordId(record: MenuManifestExportRecord) {
    return record.value.id;
}

function manifestEtag(revision: number, queryHash: string) {
    return `W/"pc-menu-manifest-${revision}-${queryHash}"`;
}

export class MenuManifestService {
    private readonly executor: ManagementMutationExecutor;
    private readonly store: MenuReadStore;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
        this.store = new MenuReadStore(repository, schemes);
    }

    private async loadSourceRecords(input: {
        readonly reader: MenuScopeReader;
        readonly currentNodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
        readonly targetNodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
        readonly currentBindings: ReadonlyMap<string, Readonly<InternalApiBindingDocument>>;
        readonly targetBindings: ReadonlyMap<string, Readonly<InternalApiBindingDocument>>;
        readonly entityMutationCount: number;
        readonly session: MongoSession;
    }) {
        if (input.entityMutationCount > MANIFEST_MUTATION_LIMIT) {
            return Object.freeze([] as MenuSourceRecord[]);
        }
        const nodeIds = new Set<string>();
        for (const [nodeId, current] of input.currentNodes) {
            const target = input.targetNodes.get(nodeId);
            if (
                target === undefined
                || current.status !== target.status
                || canonicalString(current.permission ?? null) !== canonicalString(target.permission ?? null)
                || canonicalString(current.dataPermissions ?? null) !== canonicalString(target.dataPermissions ?? null)
            ) {
                nodeIds.add(nodeId);
            }
        }
        const bindingIds = new Set<string>();
        for (const [bindingId, current] of input.currentBindings) {
            const target = input.targetBindings.get(bindingId);
            if (
                target === undefined
                || current.status !== target.status
                || current.method !== target.method
                || current.path !== target.path
                || canonicalString(current.authorization) !== canonicalString(target.authorization)
                || canonicalString(current.owners) !== canonicalString(target.owners)
            ) {
                bindingIds.add(bindingId);
            }
        }
        if (nodeIds.size === 0 && bindingIds.size === 0) return Object.freeze([] as MenuSourceRecord[]);
        const clauses: Record<string, unknown>[] = [];
        if (nodeIds.size > 0) clauses.push({ "sources.assetId": { $in: [...nodeIds].sort(compareUtf8) } });
        if (bindingIds.size > 0) clauses.push({ "sources.apiBindingId": { $in: [...bindingIds].sort(compareUtf8) } });
        const records = await loadMenuSourceRecords({
            repository: this.repository,
            schemes: this.schemes,
            reader: input.reader,
            session: input.session,
            mongoFilter: clauses.length === 1 ? clauses[0]! : { $or: clauses },
            matches: (source) => nodeIds.has(source.assetId)
                || (source.contribution === "api" && bindingIds.has(source.apiBindingId)),
        });
        for (const record of records) {
            if (record.source.effect !== record.rule.effect) {
                persistedInvalid(`menu source ${record.source.sourceId} effect differs from its semantic rule`);
            }
            const node = input.currentNodes.get(record.source.assetId);
            if (node === undefined) persistedInvalid(`menu source ${record.source.sourceId} references a missing node`);
            if (record.source.contribution !== "api") continue;
            const binding = input.currentBindings.get(record.source.apiBindingId);
            if (binding === undefined) {
                persistedInvalid(`menu source ${record.source.sourceId} references a missing API binding`);
            }
            if (!binding.owners.some((owner) => owner.id === record.source.assetId)) {
                persistedInvalid(`menu source ${record.source.sourceId} has a mismatched API owner`);
            }
        }
        return records;
    }

    private async prepareSourceEffects(input: {
        readonly reader: MenuScopeReader;
        readonly records: readonly MenuSourceRecord[];
        readonly currentNodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
        readonly targetNodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
        readonly currentBindings: ReadonlyMap<string, Readonly<InternalApiBindingDocument>>;
        readonly targetBindings: ReadonlyMap<string, Readonly<InternalApiBindingDocument>>;
        readonly decision: SourceRewriteDecision;
        readonly now: number;
        readonly session: MongoSession;
        readonly existingConflicts: readonly ManagementConflict[];
    }) {
        const removedRecords: MenuSourceRecord[] = [];
        const permissionRecords: MenuSourceRecord[] = [];
        const bindingRecords: MenuSourceRecord[] = [];
        for (const record of input.records) {
            const currentNode = input.currentNodes.get(record.source.assetId)!;
            const targetNode = input.targetNodes.get(record.source.assetId);
            if (targetNode === undefined) {
                removedRecords.push(record);
                continue;
            }
            if (record.source.contribution === "node") {
                if (canonicalString(currentNode.permission ?? null) !== canonicalString(targetNode.permission ?? null)) {
                    permissionRecords.push(record);
                }
                continue;
            }
            if (record.source.contribution === "data") {
                if (canonicalString(currentNode.dataPermissions ?? null) !== canonicalString(targetNode.dataPermissions ?? null)) {
                    permissionRecords.push(record);
                }
                continue;
            }
            const currentBinding = input.currentBindings.get(record.source.apiBindingId);
            const targetBinding = input.targetBindings.get(record.source.apiBindingId);
            if (currentBinding === undefined) persistedInvalid(`menu source ${record.source.sourceId} lost its current API binding`);
            if (targetBinding === undefined) {
                removedRecords.push(record);
                continue;
            }
            const selector = bindingSourceSelector(currentBinding, targetBinding);
            if (selector.allSources || selector.removedOwnerIds.has(record.source.assetId)) {
                bindingRecords.push(record);
            }
        }
        const impacts = [
            ...prepareSourceImpacts(removedRecords, "asset-remove", () => []),
            ...prepareSourceImpacts(permissionRecords, "permission-change", (record) => {
                const target = input.targetNodes.get(record.source.assetId)!;
                return record.source.contribution === "node"
                    ? nodePermissionRule(target)
                    : record.source.contribution === "data"
                        ? nodeDataRules(target, record.source.dataResource)
                        : [];
            }),
            ...prepareSourceImpacts(bindingRecords, "binding-change", (record) => {
                if (record.source.contribution !== "api") return [];
                const target = input.targetBindings.get(record.source.apiBindingId);
                if (target === undefined || !target.owners.some((owner) => owner.id === record.source.assetId)) return [];
                return target.authorization.permissions;
            }),
        ].sort((left, right) => compareUtf8(left.record.source.sourceId, right.record.source.sourceId));
        const impactIds = impacts.map((impact) => impact.record.source.sourceId);
        if (new Set(impactIds).size !== impactIds.length) {
            persistedInvalid("manifest source impacts contain duplicate source identities");
        }
        const conflicts: ManagementConflict[] = [...sourceRewriteConflicts(impacts, input.decision)];
        const impactIdSet = new Set(impactIds);
        const affectedRecords = input.records.filter((record) =>
            impactIdSet.has(record.source.sourceId)
            || sourceIsActive(record, input.currentNodes, input.currentBindings)
                !== sourceIsActive(record, input.targetNodes, input.targetBindings));
        let sourceRewrite: PreparedSourceRewriteExecution | null = null;
        let affectedUsers = emptyAffectedUsers("menu-manifest-import");
        let capacity: AuthorizationCapacityAssessment | null = null;
        let warnings = Object.freeze([] as ReturnType<typeof capacityMessages>["warnings"]);
        if (input.existingConflicts.length === 0 && conflicts.length === 0 && affectedRecords.length > 0) {
            const rbacReader = new RbacScopeReader(this.repository, this.schemes, input.reader.state, input.session);
            if (impacts.length > 0) {
                sourceRewrite = await prepareSourceRewriteExecution({
                    rbacReader,
                    menuReader: input.reader,
                    impacts,
                    decision: input.decision,
                    now: input.now,
                });
                conflicts.push(...sourceRewrite.conflicts);
            }
            if (conflicts.length === 0) {
                const sourceRoleIds = [...new Set(affectedRecords.map((record) => record.rule.roleId))].sort(compareUtf8);
                const affectedRoleIds = await loadAffectedRoleIds(
                    this.repository,
                    rbacReader,
                    sourceRoleIds,
                    input.session,
                );
                affectedUsers = affectedRoleIds.length === 0
                    ? affectedUsers
                    : await loadAffectedUsers(
                        this.repository,
                        rbacReader,
                        affectedRoleIds,
                        "menu-manifest-import",
                        input.session,
                    );
                const afterNodeStatuses = new Map<string, EntityStatus>();
                for (const [nodeId, current] of input.currentNodes) {
                    const target = input.targetNodes.get(nodeId);
                    if (target === undefined || target.status !== current.status) {
                        afterNodeStatuses.set(nodeId, target?.status ?? "disabled");
                    }
                }
                const afterBindingStatuses = new Map<string, EntityStatus>();
                for (const [bindingId, current] of input.currentBindings) {
                    const target = input.targetBindings.get(bindingId);
                    if (target === undefined || target.status !== current.status) {
                        afterBindingStatuses.set(bindingId, target?.status ?? "disabled");
                    }
                }
                const availabilityReaders = createMenuAvailabilityReaders({
                    rbacReader,
                    menuReader: input.reader,
                    after: {
                        ...(afterNodeStatuses.size === 0 ? {} : { nodes: afterNodeStatuses }),
                        ...(afterBindingStatuses.size === 0 ? {} : { bindings: afterBindingStatuses }),
                        ...(sourceRewrite === null ? {} : { rules: sourceRewrite.afterRulesByRole }),
                    },
                });
                const direction = sourceDirection({
                    affectedRecords,
                    impacts,
                    decision: input.decision,
                    currentNodes: input.currentNodes,
                    targetNodes: input.targetNodes,
                    currentBindings: input.currentBindings,
                    targetBindings: input.targetBindings,
                });
                capacity = await assessAuthorizationCapacity({
                    repository: this.repository,
                    reader: rbacReader,
                    affectedUsers,
                    overlay: {},
                    beforeReader: availabilityReaders.before,
                    afterReader: availabilityReaders.after,
                    structuralCapacityNonIncreasing: !direction.expands,
                    knownCapacityRiskMayBeAcknowledged: false,
                    accessHint: direction.accessHint,
                    session: input.session,
                });
                const messages = capacityMessages(capacity);
                warnings = messages.warnings;
                conflicts.push(...messages.conflicts);
            }
        }
        return deepFreeze({
            impacts,
            affectedRecords,
            sourceRewrite,
            affectedUsers,
            capacity,
            warnings,
            conflicts,
        });
    }

    private async planManifest(
        reader: MenuScopeReader,
        input: NormalizedManifest,
        now: number,
        session: MongoSession,
    ): Promise<PreparedManifestPlan> {
        const inventory = await reader.readCompleteInventory();
        validateMenuGraph(inventory.nodes);
        const conflicts: ManagementConflict[] = duplicateInputConflicts(input);
        const nodeState = buildTargetNodes({
            manifest: input,
            current: inventory.nodes,
            scopeKey: reader.state.scopeKey,
            scope: reader.state.scope,
            now,
        });
        const bindingState = buildTargetBindings({
            manifest: input,
            current: inventory.bindings,
            scopeKey: reader.state.scopeKey,
            scope: reader.state.scope,
            now,
        });
        conflicts.push(...targetNodeConflicts(nodeState));
        const targetNodesById = new Map(nodeState.target.map((node) => [node.nodeId, node] as const));
        conflicts.push(...targetBindingConflicts(bindingState.target, targetNodesById));

        const nodeInserts = nodeState.target.filter((node) => !nodeState.currentById.has(node.nodeId));
        const nodeUpdates = nodeState.target.flatMap((after) => {
            const before = nodeState.currentById.get(after.nodeId);
            return before === undefined || before === after ? [] : [{ before, after }];
        });
        const nodeDeletes = inventory.nodes.filter((node) => !targetNodesById.has(node.nodeId));
        const unchangedNodeIds = nodeState.target
            .filter((node) => nodeState.currentById.get(node.nodeId) === node)
            .map((node) => node.nodeId)
            .sort(compareUtf8);

        const targetBindingsById = new Map(bindingState.target.map((binding) => [binding.bindingId, binding] as const));
        const bindingInserts = bindingState.target.filter((binding) => !bindingState.currentById.has(binding.bindingId));
        const bindingUpdates = bindingState.target.flatMap((after) => {
            const before = bindingState.currentById.get(after.bindingId);
            return before === undefined || before === after ? [] : [{ before, after }];
        });
        const bindingDeletes = inventory.bindings.filter((binding) => !targetBindingsById.has(binding.bindingId));
        const unchangedBindingIds = bindingState.target
            .filter((binding) => bindingState.currentById.get(binding.bindingId) === binding)
            .map((binding) => binding.bindingId)
            .sort(compareUtf8);

        const entityMutationCount = nodeInserts.length + nodeUpdates.length + nodeDeletes.length
            + bindingInserts.length + bindingUpdates.length + bindingDeletes.length;
        if (entityMutationCount > MANIFEST_MUTATION_LIMIT) {
            conflicts.push({
                id: "manifest-entity-capacity",
                code: "LIMIT_EXCEEDED",
                message: `Manifest import requires ${entityMutationCount} node and binding mutations; the atomic limit is ${MANIFEST_MUTATION_LIMIT}.`,
            });
        }
        const currentNodesById = new Map(inventory.nodes.map((node) => [node.nodeId, node] as const));
        const currentBindingsById = new Map(inventory.bindings.map((binding) => [binding.bindingId, binding] as const));
        const sourceRecords = await this.loadSourceRecords({
            reader,
            currentNodes: currentNodesById,
            targetNodes: targetNodesById,
            currentBindings: currentBindingsById,
            targetBindings: targetBindingsById,
            entityMutationCount,
            session,
        });
        const effects = await this.prepareSourceEffects({
            reader,
            records: sourceRecords,
            currentNodes: currentNodesById,
            targetNodes: targetNodesById,
            currentBindings: currentBindingsById,
            targetBindings: targetBindingsById,
            decision: input.sourceRewrite,
            now,
            session,
            existingConflicts: conflicts,
        });
        conflicts.push(...effects.conflicts);
        const estimatedSourceMutations = effects.sourceRewrite?.sourceMutationCount ?? effects.impacts.length;
        const mutationCount = entityMutationCount + estimatedSourceMutations;
        if (entityMutationCount <= MANIFEST_MUTATION_LIMIT && mutationCount > MANIFEST_MUTATION_LIMIT) {
            conflicts.push({
                id: "manifest-total-capacity",
                code: "LIMIT_EXCEEDED",
                message: `Manifest import requires ${mutationCount} entity and source mutations; the atomic limit is ${MANIFEST_MUTATION_LIMIT}.`,
            });
        }

        const nodeOperations = [
            ...nodeInserts.map((node) => ({ id: node.nodeId, action: "insert" as const })),
            ...nodeUpdates.map((update) => ({ id: update.before.nodeId, action: "update" as const })),
            ...nodeDeletes.map((node) => ({ id: node.nodeId, action: "delete" as const })),
        ].sort((left, right) => compareUtf8(left.id, right.id));
        const bindingOperations = [
            ...bindingInserts.map((binding) => ({ id: binding.bindingId, action: "insert" as const })),
            ...bindingUpdates.map((update) => ({ id: update.before.bindingId, action: "update" as const })),
            ...bindingDeletes.map((binding) => ({ id: binding.bindingId, action: "delete" as const })),
        ].sort((left, right) => compareUtf8(left.id, right.id));
        const unchangedNodes = sampledCountSample(unchangedNodeIds);
        const unchangedBindings = sampledCountSample(unchangedBindingIds);
        const completeNodeOperations = [
            ...nodeInserts.map((after) => ({ id: after.nodeId, action: "insert", before: null, after: menuNodeManifestItemFromDocument(after) })),
            ...nodeUpdates.map(({ before, after }) => ({
                id: before.nodeId,
                action: "update",
                before: menuNodeManifestItemFromDocument(before),
                after: menuNodeManifestItemFromDocument(after),
            })),
            ...nodeDeletes.map((before) => ({ id: before.nodeId, action: "delete", before: menuNodeManifestItemFromDocument(before), after: null })),
        ].sort((left, right) => compareUtf8(left.id, right.id));
        const completeBindingOperations = [
            ...bindingInserts.map((after) => ({ id: after.bindingId, action: "insert", before: null, after: apiBindingManifestItemFromDocument(after) })),
            ...bindingUpdates.map(({ before, after }) => ({
                id: before.bindingId,
                action: "update",
                before: apiBindingManifestItemFromDocument(before),
                after: apiBindingManifestItemFromDocument(after),
            })),
            ...bindingDeletes.map((before) => ({ id: before.bindingId, action: "delete", before: apiBindingManifestItemFromDocument(before), after: null })),
        ].sort((left, right) => compareUtf8(left.id, right.id));
        const completePlan = toPolicyValue({
            mode: input.mode,
            inputDigest: digestCanonical(input),
            sourceRewriteDecision: input.sourceRewrite,
            nodeOperations: completeNodeOperations,
            unchangedNodes,
            bindingOperations: completeBindingOperations,
            unchangedBindings,
            sourceImpacts: effects.impacts.map((impact) => impact.public),
            sourceRewrite: effects.sourceRewrite?.auditPlan ?? null,
            capacityDigest: effects.capacity?.digest ?? null,
        });
        try {
            assertAuditChangeBudget({ kind: "menu-manifest-import", plan: completePlan });
        } catch (error) {
            if (!(error instanceof PermissionCoreError) || error.code !== "LIMIT_EXCEEDED") throw error;
            conflicts.push({
                id: "manifest-audit-budget",
                code: "LIMIT_EXCEEDED",
                message: "The complete manifest audit diff exceeds its atomic byte budget.",
            });
        }
        const inputHash = digestCanonical({ input });
        const revisionEntities = [{ kind: "scope" as const, id: reader.state.scopeKey, revision: reader.state.revision }];
        const expectedRevisions = expectedMenuRevisions(
            reader,
            revisionEntities,
            effects.affectedRecords.length > 0,
        );
        const planHash = menuPlanHash("menus.manifest.preview", inputHash, expectedRevisions, completePlan);
        const sourceSummary = sourceResolutionSummary(effects.impacts, input.sourceRewrite, estimatedSourceMutations);
        const summarySamples: BatchMutationSummary["samples"]["items"] = [
            ...nodeInserts.map((node) => ({ id: `node:${node.nodeId}`, outcome: "inserted" as const })),
            ...nodeUpdates.map((update) => ({ id: `node:${update.before.nodeId}`, outcome: "updated" as const })),
            ...unchangedNodeIds.map((nodeId) => ({ id: `node:${nodeId}`, outcome: "unchanged" as const })),
            ...nodeDeletes.map((node) => ({ id: `node:${node.nodeId}`, outcome: "deleted" as const })),
            ...bindingInserts.map((binding) => ({ id: `api-binding:${binding.bindingId}`, outcome: "inserted" as const })),
            ...bindingUpdates.map((update) => ({ id: `api-binding:${update.before.bindingId}`, outcome: "updated" as const })),
            ...unchangedBindingIds.map((bindingId) => ({ id: `api-binding:${bindingId}`, outcome: "unchanged" as const })),
            ...bindingDeletes.map((binding) => ({ id: `api-binding:${binding.bindingId}`, outcome: "deleted" as const })),
            ...effects.impacts.map((impact) => ({
                id: impact.record.source.sourceId,
                outcome: input.sourceRewrite.mode === "reject"
                    ? "conflicted" as const
                    : input.sourceRewrite.resolutions[impact.record.source.sourceId]?.action === "revoke"
                        ? "deleted" as const
                        : "updated" as const,
            })),
        ];
        return {
            method: "menus.manifest.preview",
            reader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: sourceRewriteDecisionDetailCount(effects.impacts),
            publicPlan: (budget) => deepFreeze({
                mode: input.mode as "merge" | "replace",
                nodeOperations: budget.bounded(nodeOperations),
                unchangedNodes: budgetCountSample(unchangedNodes, budget),
                bindingOperations: budget.bounded(bindingOperations),
                unchangedBindings: budgetCountSample(unchangedBindings, budget),
                sourceImpacts: budgetSourceImpacts(effects.impacts, budget),
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts({
                inserted: nodeInserts.length + bindingInserts.length,
                updated: nodeUpdates.length + bindingUpdates.length + sourceSummary.updated,
                unchanged: unchangedNodeIds.length + unchangedBindingIds.length,
                deleted: nodeDeletes.length + bindingDeletes.length + sourceSummary.revoked,
                conflicted: conflicts.length,
            }),
            summarySamples,
            warnings: effects.warnings,
            conflicts,
            capacity: effects.capacity,
            nodeInserts,
            nodeUpdates,
            nodeDeletes,
            bindingInserts,
            bindingUpdates,
            bindingDeletes,
            targetNodes: nodeState.target,
            targetBindings: bindingState.target,
            sourceImpacts: effects.impacts,
            sourceRewrite: effects.sourceRewrite,
            affectedUsers: effects.affectedUsers,
        };
    }

    async preview(
        scope: PermissionScope,
        inputValue: MenuManifestInput,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<MenuManifestPlan>> {
        const input = normalizeMenuManifestInput(inputValue, this.schemes);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planManifest(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                input,
                issuedAt,
                transaction.session,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async import(
        scope: PermissionScope,
        inputValue: MenuManifestInput,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        const input = normalizeMenuManifestInput(inputValue, this.schemes);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "menus.manifest.import",
            action: "import",
            resource: "menu-manifest:*",
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
                const prepared = await this.planManifest(reader, input, now, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                const data: BatchMutationSummary = deepFreeze({
                    ...prepared.summaryCounts,
                    samples: new DetailBudgetAllocator().bounded(sortBatchMutationSamples(prepared.summarySamples)),
                });
                const changed = prepared.nodeInserts.length > 0
                    || prepared.nodeUpdates.length > 0
                    || prepared.nodeDeletes.length > 0
                    || prepared.bindingInserts.length > 0
                    || prepared.bindingUpdates.length > 0
                    || prepared.bindingDeletes.length > 0;
                if (!changed) {
                    return {
                        changed: false,
                        data,
                        primaryRevision: state.revision,
                        entity: { kind: "scope", id: state.scopeKey, before: state.revision, after: state.revision },
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "menu-manifest-import", plan: prepared.completePlan },
                        cacheTargets: [],
                        validatedPlanHash: prepared.planHash,
                        capacity: toPolicyValue(prepared.capacity),
                    };
                }
                const aggregate = planMenuAggregate({
                    state,
                    beforeNodes: [
                        ...prepared.nodeDeletes,
                        ...prepared.nodeUpdates.map((update) => update.before),
                    ],
                    afterNodes: [
                        ...prepared.nodeInserts,
                        ...prepared.nodeUpdates.map((update) => update.after),
                    ],
                    beforeBindings: [
                        ...prepared.bindingDeletes,
                        ...prepared.bindingUpdates.map((update) => update.before),
                    ],
                    afterBindings: [
                        ...prepared.bindingInserts,
                        ...prepared.bindingUpdates.map((update) => update.after),
                    ],
                });

                const removedBindings = [
                    ...prepared.bindingDeletes,
                    ...prepared.bindingUpdates.map((update) => update.before),
                ].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
                for (const binding of removedBindings) {
                    const result = await this.repository.collections.apiBindings.deleteOne(
                        { scopeKey: state.scopeKey, bindingId: binding.bindingId, revision: binding.revision },
                        writeOptions(transaction.session),
                    );
                    if (result.deletedCount !== 1) revisionConflict(`api-binding:${binding.bindingId}`, binding.revision);
                }
                const removedNodes = [
                    ...prepared.nodeDeletes,
                    ...prepared.nodeUpdates.map((update) => update.before),
                ].sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
                for (const node of removedNodes) {
                    const result = await this.repository.collections.menuNodes.deleteOne(
                        { scopeKey: state.scopeKey, nodeId: node.nodeId, revision: node.revision },
                        writeOptions(transaction.session),
                    );
                    if (result.deletedCount !== 1) revisionConflict(`menu-node:${node.nodeId}`, node.revision);
                }

                const insertedNodes = [
                    ...prepared.nodeInserts,
                    ...prepared.nodeUpdates.map((update) => update.after),
                ].sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
                for (const node of insertedNodes) {
                    let result;
                    try {
                        result = await this.repository.collections.menuNodes.insertOne(
                            { ...node },
                            insertOptions(transaction.session),
                        );
                    } catch (error) {
                        if (readNestedDuplicate(error)) {
                            throw new PermissionCoreError(
                                "MENU_ALREADY_EXISTS",
                                "The manifest conflicts with an existing menu identity, path, name, or sibling code.",
                                { cause: error },
                            );
                        }
                        throw error;
                    }
                    if (result.acknowledged !== true) databaseWriteFailure(`menu node ${node.nodeId} insert was not acknowledged`);
                }
                const insertedBindings = [
                    ...prepared.bindingInserts,
                    ...prepared.bindingUpdates.map((update) => update.after),
                ].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
                for (const binding of insertedBindings) {
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
                                "The manifest conflicts with an existing API binding ID or endpoint.",
                                { cause: error },
                            );
                        }
                        throw error;
                    }
                    if (result.acknowledged !== true) databaseWriteFailure(`API binding ${binding.bindingId} insert was not acknowledged`);
                }
                if (prepared.sourceRewrite !== null) {
                    await applySourceRewriteExecution({
                        repository: this.repository,
                        schemes: this.schemes,
                        session: transaction.session,
                        prepared: prepared.sourceRewrite,
                    });
                }

                for (const node of prepared.nodeDeletes) {
                    if (await reader.readNode(node.nodeId) !== null) {
                        databaseWriteFailure(`deleted menu node ${node.nodeId} is still visible in the transaction`);
                    }
                }
                for (const binding of prepared.bindingDeletes) {
                    if (await reader.readBinding(binding.bindingId) !== null) {
                        databaseWriteFailure(`deleted API binding ${binding.bindingId} is still visible in the transaction`);
                    }
                }
                for (const node of insertedNodes) {
                    const postImage = await reader.requireNode(node.nodeId);
                    if (canonicalString(postImage) !== canonicalString(node)) {
                        databaseWriteFailure(`menu node ${node.nodeId} post-image differs from the manifest plan`);
                    }
                }
                for (const binding of insertedBindings) {
                    const postImage = await reader.requireBinding(binding.bindingId);
                    if (canonicalString(postImage) !== canonicalString(binding)) {
                        databaseWriteFailure(`API binding ${binding.bindingId} post-image differs from the manifest plan`);
                    }
                }
                const [nodeCount, bindingCount] = await Promise.all([
                    this.repository.collections.menuNodes.count({ scopeKey: state.scopeKey }, readOptions(transaction.session)),
                    this.repository.collections.apiBindings.count({ scopeKey: state.scopeKey }, readOptions(transaction.session)),
                ]);
                if (nodeCount !== prepared.targetNodes.length || bindingCount !== prepared.targetBindings.length) {
                    databaseWriteFailure("manifest post-count differs from its complete target inventory");
                }
                const changesRbac = prepared.sourceRewrite !== null && prepared.sourceRewrite.roles.length > 0;
                return {
                    changed: true,
                    data,
                    primaryRevision: state.revision + 1,
                    entity: { kind: "scope", id: state.scopeKey, before: state.revision, after: state.revision + 1 },
                    revisionImpact: { rbac: changesRbac, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "menu-manifest-import", plan: prepared.completePlan },
                    cacheTargets: prepared.capacity === null
                        ? [`scope:${state.scopeKey}:menu`]
                        : authorizationCacheTargets(state.scopeKey, prepared.affectedUsers),
                    validatedPlanHash: prepared.planHash,
                    capacity: toPolicyValue(prepared.capacity),
                };
            },
        });
    }

    async export(scope: PermissionScope): Promise<VersionedResult<FrontendMenuManifest>> {
        const reader = await this.store.open(scope);
        const inventory = await reader.readCompleteInventory();
        validateMenuGraph(inventory.nodes);
        const data = deepFreeze({
            schemaVersion: 2 as const,
            nodes: inventory.nodes
                .map(menuNodeManifestItemFromDocument)
                .sort((left, right) => compareUtf8(left.id, right.id)),
            apiBindings: inventory.bindings
                .map(apiBindingManifestItemFromDocument)
                .sort((left, right) => compareUtf8(left.id, right.id)),
        });
        await reader.verifyMenuUnchanged();
        const queryHash = digestCanonical({ method: "menus.manifest.export", schemaVersion: 2, sortVersion: 1 });
        const result = deepFreeze({
            data,
            revision: reader.state.menuRevision,
            revisions: revisionVector(reader.state),
            etag: manifestEtag(reader.state.menuRevision, queryHash),
            detailBudget: new DetailBudgetAllocator().finish([]),
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    private readCursor(
        token: string | undefined,
        reader: MenuScopeReader,
        queryHash: string,
    ) {
        if (token === undefined) return undefined;
        const payload = exactManifestCursorPayload(
            this.tokens.decode(token, "pc:v2:manager-cursor", "INVALID_CURSOR", CURSOR_MAX_BYTES),
        );
        if (payload.scopeKey !== reader.state.scopeKey || payload.queryHash !== queryHash) {
            cursorInvalid("does not match the current scope or query");
        }
        if (payload.expiresAt - payload.issuedAt !== CURSOR_TTL_MS) {
            cursorInvalid("contains an invalid validity interval");
        }
        const now = Date.now();
        if (payload.issuedAt > now || payload.expiresAt <= now) {
            throw new PermissionCoreError("CURSOR_STALE", "The manifest cursor has expired.", {
                details: { kind: "cursor-stale", owner: "manager-cursor-expiry", expected: payload.expiresAt, current: now },
            });
        }
        if (payload.menuRevision !== reader.state.menuRevision) {
            cursorStale(payload.menuRevision, reader.state.menuRevision);
        }
        return payload;
    }

    private writeCursor(
        reader: MenuScopeReader,
        queryHash: string,
        anchor: ManifestCursorAnchor,
        progress: ManifestCursorProgress,
    ) {
        const issuedAt = Date.now();
        return this.tokens.encode("pc:v2:manager-cursor", {
            method: "menus.manifest.exportPage",
            scopeKey: reader.state.scopeKey,
            queryHash,
            menuRevision: reader.state.menuRevision,
            anchor: { ...anchor },
            progress: { ...progress },
            issuedAt,
            expiresAt: issuedAt + CURSOR_TTL_MS,
        });
    }

    private async readManifestKindPage(
        reader: MenuScopeReader,
        kind: MenuManifestExportRecord["kind"],
        after: string | undefined,
        limit: number,
    ): Promise<ManifestPageRecord[]> {
        const records: ManifestPageRecord[] = [];
        const idField = kind === "node" ? "nodeId" : "bindingId";
        const collection = kind === "node"
            ? this.repository.collections.menuNodes
            : this.repository.collections.apiBindings;
        let nextAfter = after;
        try {
            while (records.length < limit) {
                const pageSize = Math.min(this.repository.findMaxLimit, limit - records.length);
                const base = { scopeKey: reader.state.scopeKey };
                const filter = nextAfter === undefined
                    ? base
                    : { ...base, [idField]: { $gt: nextAfter } };
                const rows = await collection.find(filter, readOptions())
                    .sort({ [idField]: 1 })
                    .limit(pageSize)
                    .toArray();
                if (rows.length > pageSize) persistedInvalid("manifest page exceeds the host query budget");
                if (!reader.state.persisted && rows.length > 0) {
                    persistedInvalid("manifest documents exist without their owning scope state");
                }
                if (rows.length === 0) break;
                for (const row of rows) {
                    if (kind === "node") {
                        const document = materializeMenuNodeDocument(
                            row,
                            reader.state.scope,
                            reader.state.scopeKey,
                            this.schemes,
                        );
                        if (nextAfter !== undefined && compareUtf8(document.nodeId, nextAfter) <= 0) {
                            persistedInvalid("manifest node keyset did not advance");
                        }
                        nextAfter = document.nodeId;
                        records.push({
                            record: { kind, value: menuNodeManifestItemFromDocument(document) },
                            manifestItemBytes: document.manifestItemBytes,
                        });
                    } else {
                        const document = materializeApiBindingDocument(
                            row,
                            reader.state.scope,
                            reader.state.scopeKey,
                            this.schemes,
                        );
                        if (nextAfter !== undefined && compareUtf8(document.bindingId, nextAfter) <= 0) {
                            persistedInvalid("manifest API binding keyset did not advance");
                        }
                        nextAfter = document.bindingId;
                        records.push({
                            record: { kind, value: apiBindingManifestItemFromDocument(document) },
                            manifestItemBytes: document.manifestItemBytes,
                        });
                    }
                }
                if (rows.length < pageSize) break;
            }
            return records;
        } catch (error) {
            throw mapDatabaseReadError("The menu manifest page read failed.", error);
        }
    }

    private async readManifestPageRecords(
        reader: MenuScopeReader,
        kind: MenuManifestExportRecord["kind"] | undefined,
        cursor: ReturnType<typeof exactManifestCursorPayload> | undefined,
        limit: number,
    ) {
        if (kind !== undefined && cursor !== undefined && cursor.anchor.kind !== kind) {
            cursorInvalid("does not match the requested manifest kind");
        }
        if (
            cursor !== undefined
            && (
                kind === "node" && cursor.progress.apiBindingCount !== 0
                || kind === "api-binding" && cursor.progress.menuNodeCount !== 0
            )
        ) {
            cursorInvalid("contains progress for a different manifest kind");
        }
        if (
            kind === undefined
            && cursor?.anchor.kind === "api-binding"
            && cursor.progress.menuNodeCount !== 0
        ) {
            cursorInvalid("contains node progress before the API binding phase completed");
        }
        if (
            kind === undefined
            && cursor?.anchor.kind === "node"
            && cursor.progress.apiBindingCount !== reader.state.apiBindingCount
        ) {
            persistedInvalid("manifest cursor entered the node phase before the API inventory completed");
        }

        const kinds: readonly MenuManifestExportRecord["kind"][] = kind !== undefined
            ? [kind]
            : cursor?.anchor.kind === "node" ? ["node"] : ["api-binding", "node"];
        const records: ManifestPageRecord[] = [];
        for (const currentKind of kinds) {
            const after = currentKind === cursor?.anchor.kind ? cursor.anchor.id : undefined;
            records.push(...await this.readManifestKindPage(reader, currentKind, after, limit - records.length));
            if (records.length >= limit) break;
        }
        return records;
    }

    private assertManifestProgress(
        reader: MenuScopeReader,
        kind: MenuManifestExportRecord["kind"] | undefined,
        progress: ManifestCursorProgress,
    ) {
        if (
            progress.menuNodeCount > reader.state.menuNodeCount
            || progress.apiBindingCount > reader.state.apiBindingCount
        ) {
            persistedInvalid("manifest page progress exceeds the declared aggregate count");
        }
        if (kind === "node") {
            if (progress.menuNodeCount !== reader.state.menuNodeCount) {
                persistedInvalid("scope menuNodeCount does not match the paged menu inventory");
            }
            return;
        }
        if (kind === "api-binding") {
            if (progress.apiBindingCount !== reader.state.apiBindingCount) {
                persistedInvalid("scope apiBindingCount does not match the paged API inventory");
            }
            return;
        }
        if (
            progress.menuNodeCount !== reader.state.menuNodeCount
            || progress.apiBindingCount !== reader.state.apiBindingCount
        ) {
            persistedInvalid("scope aggregate counts do not match the paged manifest inventory");
        }
        const replaceManifestBytes = calculateReplaceManifestBytes({
            menuNodeCount: progress.menuNodeCount,
            apiBindingCount: progress.apiBindingCount,
            itemBytes: progress.itemBytes,
        });
        if (replaceManifestBytes !== reader.state.replaceManifestBytes) {
            persistedInvalid("scope replaceManifestBytes does not match the paged manifest inventory");
        }
    }

    async exportPage(
        scope: PermissionScope,
        queryValue?: CursorQuery & { kind?: MenuManifestExportRecord["kind"] },
    ): Promise<PageResult<MenuManifestExportRecord>> {
        const query = normalizeManifestPageQuery(queryValue);
        const reader = await this.store.open(scope);
        const queryHash = digestCanonical({
            method: "menus.manifest.exportPage",
            kind: query.kind ?? null,
            sortVersion: 1,
        });
        const cursor = this.readCursor(query.after, reader, queryHash);
        const records = await this.readManifestPageRecords(reader, query.kind, cursor, query.first + 1);
        const hasNext = records.length > query.first;
        const selected = records.slice(0, query.first);
        const progress = advanceManifestCursorProgress(cursor?.progress, selected);
        if (
            progress.menuNodeCount > reader.state.menuNodeCount
            || progress.apiBindingCount > reader.state.apiBindingCount
        ) {
            persistedInvalid("manifest page progress exceeds the declared aggregate count");
        }
        if (!hasNext) this.assertManifestProgress(reader, query.kind, progress);
        const items = deepFreeze(selected.map((item) => item.record));
        const last = items.at(-1);
        const endCursor = hasNext && last !== undefined
            ? this.writeCursor(reader, queryHash, { kind: last.kind, id: manifestRecordId(last) }, progress)
            : null;
        await reader.verifyMenuUnchanged();
        const result = deepFreeze({
            items,
            pageInfo: { hasNext, endCursor },
            revision: reader.state.menuRevision,
            revisions: revisionVector(reader.state),
            etag: manifestEtag(reader.state.menuRevision, queryHash),
            detailBudget: new DetailBudgetAllocator().finish([]),
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }
}
