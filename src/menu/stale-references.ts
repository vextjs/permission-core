import type {
    ApiBindingCreateInput,
    BatchMutationSummary,
    CursorQuery,
    ImpactPreview,
    ManagementConflict,
    MutationResult,
    PageResult,
    PermissionScope,
    PolicyValue,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionVectorOptions,
    StaleReference,
    StaleRepairInput,
    StaleRepairPlan,
    StructuralStaleResolution,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
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
import { planMenuAggregate } from "./aggregate";
import {
    apiBindingDocumentFromInput,
    apiBindingManifestItemFromDocument,
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
import {
    collectStructuralStaleReferences,
    menuParentAllows,
    type ApiOwnerStaleRecord,
    type ParentStaleRecord,
    type StructuralStaleRecord,
} from "./stale-model";
import { MAX_MENU_DEPTH, MenuReadStore, MenuScopeReader } from "./store";
import {
    exactMenuRecord,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
    normalizeStaleRepairInput,
} from "./validation";
import { decodeBatchMutationSummaryReplay } from "./views";

const CURSOR_PURPOSE = "pc:v2:stale-reference-cursor";
const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_MAX_BYTES = 8 * 1024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const COMPLETE_DECISION_LIMIT = 100;
const MUTATION_LIMIT = 1_000;
const OPTIONAL_NODE_FIELDS = [
    "path", "name", "code", "component", "url", "icon", "i18nKey", "meta", "permission", "dataPermissions",
] as const;
const OPTIONAL_API_FIELDS = ["canonicalOwner", "description"] as const;

interface StaleCursorAnchor {
    readonly type: StaleReference["type"];
    readonly id: string;
}

interface NodeUpdate {
    readonly before: Readonly<InternalMenuNodeDocument>;
    readonly after: Readonly<InternalMenuNodeDocument>;
}

interface BindingUpdate {
    readonly before: Readonly<InternalApiBindingDocument>;
    readonly after: Readonly<InternalApiBindingDocument>;
}

interface ParentDecision {
    readonly record: ParentStaleRecord;
    readonly resolution: StructuralStaleResolution;
    readonly parentId: string | null;
}

interface ApiOwnerDecision {
    readonly record: ApiOwnerStaleRecord;
    readonly resolution: StructuralStaleResolution;
}

interface PreparedStaleRepairPlan extends PreparedMenuPlan<StaleRepairPlan> {
    readonly nodeUpdates: readonly NodeUpdate[];
    readonly bindingUpdates: readonly BindingUpdate[];
    readonly temporaryNodeIds: readonly string[];
}

function writeOptions(session: unknown) {
    return { session, cache: { invalidate: false as const }, collation: SIMPLE_COLLATION };
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The stale-reference write result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted structural reference state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function revisionConflict(owner: string, expected: number): never {
    throw new PermissionCoreError("REVISION_CONFLICT", `${owner} revision changed.`, {
        details: { kind: "revision-conflict", owner, expected },
    });
}

function cursorInvalid(reason: string): never {
    throw new PermissionCoreError("INVALID_CURSOR", "The stale-reference cursor is invalid.", {
        details: { kind: "validation", field: "cursor", reason },
    });
}

function cursorStale(owner: string, expected: number | string, current: number | string): never {
    throw new PermissionCoreError("CURSOR_STALE", "The stale-reference cursor no longer matches current menu state.", {
        details: { kind: "cursor-stale", owner, expected, current },
    });
}

function normalizeQuery(value?: CursorQuery) {
    const record = exactMenuRecord(value ?? {}, ["first", "after"], "query");
    const first = record.first ?? PAGE_DEFAULT;
    if (!Number.isSafeInteger(first) || (first as number) < 1 || (first as number) > PAGE_MAX) {
        throw validationError("INVALID_ARGUMENT", "query.first", `must be an integer between 1 and ${PAGE_MAX}`);
    }
    if (record.after !== undefined && (typeof record.after !== "string" || record.after.length === 0)) {
        throw validationError("INVALID_ARGUMENT", "query.after", "must be a non-empty cursor string");
    }
    return Object.freeze({
        first: first as number,
        ...(record.after === undefined ? {} : { after: record.after as string }),
    });
}

function exactCursorPayload(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) cursorInvalid("contains an invalid payload");
    const record = value as Readonly<Record<string, unknown>>;
    const allowed = new Set([
        "version", "purpose", "coreNamespaceHash", "scopeKey", "queryHash", "menuRevision", "anchor", "issuedAt", "expiresAt",
    ]);
    if (Object.keys(record).length !== allowed.size || Object.keys(record).some((key) => !allowed.has(key))) {
        cursorInvalid("contains an invalid payload shape");
    }
    if (
        typeof record.scopeKey !== "string"
        || typeof record.queryHash !== "string"
        || !Number.isSafeInteger(record.menuRevision)
        || (record.menuRevision as number) < 0
        || !Number.isSafeInteger(record.issuedAt)
        || !Number.isSafeInteger(record.expiresAt)
        || record.anchor === null
        || typeof record.anchor !== "object"
        || Array.isArray(record.anchor)
    ) {
        cursorInvalid("contains invalid scalar fields");
    }
    const anchor = record.anchor as Readonly<Record<string, unknown>>;
    if (
        Object.keys(anchor).length !== 2
        || !Object.hasOwn(anchor, "type")
        || !Object.hasOwn(anchor, "id")
        || (anchor.type !== "api-owner" && anchor.type !== "parent")
        || typeof anchor.id !== "string"
        || anchor.id.length === 0
    ) {
        cursorInvalid("contains an invalid anchor");
    }
    return Object.freeze({
        scopeKey: record.scopeKey as string,
        queryHash: record.queryHash as string,
        menuRevision: record.menuRevision as number,
        anchor: Object.freeze({ type: anchor.type, id: anchor.id }) as StaleCursorAnchor,
        issuedAt: record.issuedAt as number,
        expiresAt: record.expiresAt as number,
    });
}

function compareAnchor(left: StaleCursorAnchor, right: StaleCursorAnchor) {
    return compareUtf8(left.type, right.type) || compareUtf8(left.id, right.id);
}

function nodeInput(document: Readonly<InternalMenuNodeDocument>) {
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

function availabilityKey(
    bindingId: string,
    owner: Readonly<InternalApiBindingDocument["owners"][number]>,
) {
    return canonicalString([bindingId, owner.type, owner.id, owner.availabilityGroup ?? null]);
}

export class StructuralStaleReferenceService {
    private readonly store: MenuReadStore;
    private readonly executor: ManagementMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        invalidateCache?: CacheInvalidator,
    ) {
        this.store = new MenuReadStore(repository, schemes);
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
    }

    private async loadInventory(reader: MenuScopeReader) {
        const nodes = await reader.readAllNodes();
        const bindings = await reader.readAllBindings();
        return Object.freeze({ nodes, bindings });
    }

    private readCursor(token: string | undefined, reader: MenuScopeReader, queryHash: string) {
        if (token === undefined) return undefined;
        const payload = exactCursorPayload(this.tokens.decode(token, CURSOR_PURPOSE, "INVALID_CURSOR", CURSOR_MAX_BYTES));
        if (payload.scopeKey !== reader.state.scopeKey || payload.queryHash !== queryHash) {
            cursorInvalid("does not match the current scope or query");
        }
        if (payload.expiresAt - payload.issuedAt !== CURSOR_TTL_MS) cursorInvalid("contains an invalid validity interval");
        const now = Date.now();
        if (payload.issuedAt > now || payload.expiresAt <= now) cursorStale("manager-cursor-expiry", payload.expiresAt, now);
        if (payload.menuRevision !== reader.state.menuRevision) cursorStale("scope.menu", payload.menuRevision, reader.state.menuRevision);
        return payload.anchor;
    }

    private writeCursor(reader: MenuScopeReader, queryHash: string, anchor: StaleCursorAnchor) {
        const issuedAt = Date.now();
        return this.tokens.encode(CURSOR_PURPOSE, {
            scopeKey: reader.state.scopeKey,
            queryHash,
            menuRevision: reader.state.menuRevision,
            anchor: { type: anchor.type, id: anchor.id },
            issuedAt,
            expiresAt: issuedAt + CURSOR_TTL_MS,
        });
    }

    async findStaleReferences(
        scope: PermissionScope,
        queryValue?: CursorQuery,
    ): Promise<PageResult<StaleReference>> {
        const query = normalizeQuery(queryValue);
        const reader = await this.store.open(scope);
        const queryHash = digestCanonical({ method: "menus.findStaleReferences", sortVersion: 1 });
        const cursor = this.readCursor(query.after, reader, queryHash);
        const inventory = await this.loadInventory(reader);
        const records = collectStructuralStaleReferences(inventory);
        const eligible = cursor === undefined
            ? records
            : records.filter((record) => compareAnchor(record.reference, cursor) > 0);
        const hasNext = eligible.length > query.first;
        const page = eligible.slice(0, query.first);
        await reader.verifyMenuUnchanged();
        const endCursor = hasNext && page.length > 0
            ? this.writeCursor(reader, queryHash, page[page.length - 1]!.reference)
            : null;
        const result = deepFreeze({
            items: page.map((record) => record.reference),
            pageInfo: { hasNext, endCursor },
            revision: reader.state.menuRevision,
            revisions: revisionVector(reader.state),
            etag: `W/"pc-menu-stale-${reader.state.menuRevision}-${queryHash}"`,
            detailBudget: new DetailBudgetAllocator().finish([]),
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    private addConflict(
        conflicts: Map<string, ManagementConflict>,
        id: string,
        code: string,
        message: string,
    ) {
        if (!conflicts.has(id)) conflicts.set(id, deepFreeze({ id, code, message }));
    }

    private validateAffectedParentChains(
        nodes: readonly Readonly<InternalMenuNodeDocument>[],
        parentTargets: ReadonlyMap<string, ParentDecision>,
        conflicts: Map<string, ManagementConflict>,
    ) {
        const nodesById = new Map(nodes.map((node) => [node.nodeId, node] as const));
        const candidateParentId = (node: Readonly<InternalMenuNodeDocument>) => {
            const decision = parentTargets.get(node.nodeId);
            return decision === undefined ? node.parentId : decision.parentId;
        };
        const children = new Map<string, InternalMenuNodeDocument[]>();
        for (const node of nodes) {
            const parentId = candidateParentId(node);
            if (parentId === null) continue;
            const parent = nodesById.get(parentId);
            if (parent === undefined || !menuParentAllows(parent.type, node.type)) continue;
            const group = children.get(parentId) ?? [];
            group.push(node);
            children.set(parentId, group);
        }
        for (const group of children.values()) group.sort((left, right) => compareUtf8(left.nodeId, right.nodeId));

        for (const decision of parentTargets.values()) {
            const referenceId = decision.record.reference.id;
            const seenAncestors = new Set<string>();
            let current: Readonly<InternalMenuNodeDocument> = decision.record.node;
            let depth = 1;
            let invalidReason: string | null = null;
            while (true) {
                if (seenAncestors.has(current.nodeId)) {
                    invalidReason = "The selected parent replacement forms or retains a cycle.";
                    break;
                }
                seenAncestors.add(current.nodeId);
                const parentId = candidateParentId(current);
                if (parentId === null) {
                    if (current.type === "button") invalidReason = "A button cannot be repaired into a root node.";
                    break;
                }
                const parent = nodesById.get(parentId);
                if (parent === undefined) {
                    invalidReason = `Replacement ancestry references missing node ${parentId}.`;
                    break;
                }
                if (!menuParentAllows(parent.type, current.type)) {
                    invalidReason = `${parent.type} ${parent.nodeId} cannot contain ${current.type} ${current.nodeId}.`;
                    break;
                }
                current = parent;
                depth += 1;
                if (depth > MAX_MENU_DEPTH) {
                    invalidReason = `The selected parent replacement exceeds menu depth ${MAX_MENU_DEPTH}.`;
                    break;
                }
            }
            if (invalidReason === null) {
                const queue = [...(children.get(decision.record.node.nodeId) ?? [])]
                    .map((node) => ({ node, depth: depth + 1 }));
                const seenDescendants = new Set<string>([decision.record.node.nodeId]);
                for (let index = 0; index < queue.length; index += 1) {
                    const entry = queue[index]!;
                    if (seenDescendants.has(entry.node.nodeId)) {
                        invalidReason = "The selected parent replacement forms or retains a descendant cycle.";
                        break;
                    }
                    seenDescendants.add(entry.node.nodeId);
                    if (entry.depth > MAX_MENU_DEPTH) {
                        invalidReason = `The selected parent replacement makes its subtree exceed menu depth ${MAX_MENU_DEPTH}.`;
                        break;
                    }
                    queue.push(...(children.get(entry.node.nodeId) ?? [])
                        .map((node) => ({ node, depth: entry.depth + 1 })));
                }
            }
            if (invalidReason !== null) {
                this.addConflict(conflicts, referenceId, "STALE_REPLACEMENT_INVALID", invalidReason);
            }
        }
    }

    private buildNodeUpdates(input: {
        readonly reader: MenuScopeReader;
        readonly nodes: readonly Readonly<InternalMenuNodeDocument>[];
        readonly decisions: readonly ParentDecision[];
        readonly conflicts: Map<string, ManagementConflict>;
        readonly now: number;
    }) {
        const parentTargets = new Map<string, ParentDecision>();
        const nodesById = new Map(input.nodes.map((node) => [node.nodeId, node] as const));
        for (const decision of input.decisions) {
            const { node } = decision.record;
            if (decision.resolution.action === "remove") {
                if (node.type === "button") {
                    this.addConflict(input.conflicts, decision.record.reference.id, "STALE_REPLACEMENT_INVALID", "A button parent reference cannot be removed; rebind it to a page or menu.");
                    continue;
                }
            } else {
                const replacement = nodesById.get(decision.resolution.replacementId);
                if (replacement === undefined) {
                    this.addConflict(input.conflicts, decision.record.reference.id, "STALE_REPLACEMENT_INVALID", `Replacement node ${decision.resolution.replacementId} does not exist.`);
                    continue;
                }
                if (!menuParentAllows(replacement.type, node.type)) {
                    this.addConflict(input.conflicts, decision.record.reference.id, "STALE_REPLACEMENT_INVALID", `${replacement.type} ${replacement.nodeId} cannot contain ${node.type} ${node.nodeId}.`);
                    continue;
                }
            }
            parentTargets.set(node.nodeId, decision);
        }

        this.validateAffectedParentChains(input.nodes, parentTargets, input.conflicts);
        const impactedParents = new Set<string | null>();
        for (const decision of parentTargets.values()) {
            impactedParents.add(decision.record.node.parentId);
            impactedParents.add(decision.parentId);
        }
        const specifications = new Map<string, { parentId: string | null; order: number }>();
        for (const parentId of impactedParents) {
            const currentGroup = input.nodes
                .filter((node) => node.parentId === parentId)
                .sort((left, right) => left.order - right.order || compareUtf8(left.nodeId, right.nodeId));
            currentGroup.forEach((node, index) => {
                if (node.order !== index) persistedInvalid(`sibling order under ${parentId ?? "root"} is not dense`);
            });
            const base = currentGroup.filter((node) => !parentTargets.has(node.nodeId));
            const incoming = [...parentTargets.values()]
                .filter((decision) => decision.parentId === parentId)
                .sort((left, right) => compareUtf8(left.record.reference.id, right.record.reference.id));
            const finalMembers = [
                ...base.map((node) => ({ node, referenceId: null as string | null })),
                ...incoming.map((decision) => ({ node: decision.record.node, referenceId: decision.record.reference.id })),
            ];
            const codeOwners = new Map<string, Array<{ nodeId: string; referenceId: string | null }>>();
            for (const member of finalMembers) {
                if (member.node.code === undefined) continue;
                const owners = codeOwners.get(member.node.code) ?? [];
                owners.push({ nodeId: member.node.nodeId, referenceId: member.referenceId });
                codeOwners.set(member.node.code, owners);
            }
            for (const [code, owners] of codeOwners) {
                if (owners.length < 2) continue;
                const referenceIds = owners.flatMap((owner) => owner.referenceId === null ? [] : [owner.referenceId]);
                if (referenceIds.length === 0) persistedInvalid(`sibling code ${code} is already duplicated`);
                for (const referenceId of referenceIds) {
                    this.addConflict(input.conflicts, referenceId, "STALE_REPLACEMENT_INVALID", `Replacement would duplicate sibling code ${code}.`);
                }
            }

            finalMembers.forEach((member, order) => {
                specifications.set(member.node.nodeId, { parentId, order });
            });
        }

        const updates: NodeUpdate[] = [];
        for (const [nodeId, specification] of specifications) {
            const before = nodesById.get(nodeId)!;
            if (before.parentId === specification.parentId && before.order === specification.order) continue;
            const normalized = normalizeMenuNodeCreateInput({
                ...nodeInput(before),
                parentId: specification.parentId,
            }, this.schemes);
            const after = menuNodeDocumentFromInput(
                input.reader.state.scopeKey,
                input.reader.state.scope,
                normalized,
                specification.order,
                before.revision + 1,
                before.createdAt,
                input.now,
            );
            updates.push({ before, after });
        }
        updates.sort((left, right) => compareUtf8(left.before.nodeId, right.before.nodeId));
        return Object.freeze({
            updates: Object.freeze(updates),
            temporaryNodeIds: Object.freeze([...parentTargets.keys()].sort(compareUtf8)),
        });
    }

    private buildBindingUpdates(input: {
        readonly reader: MenuScopeReader;
        readonly nodes: readonly Readonly<InternalMenuNodeDocument>[];
        readonly bindings: readonly Readonly<InternalApiBindingDocument>[];
        readonly decisions: readonly ApiOwnerDecision[];
        readonly conflicts: Map<string, ManagementConflict>;
        readonly now: number;
    }) {
        const nodesById = new Map(input.nodes.map((node) => [node.nodeId, node] as const));
        const decisionsByBinding = new Map<string, ApiOwnerDecision[]>();
        for (const decision of input.decisions) {
            const group = decisionsByBinding.get(decision.record.binding.bindingId) ?? [];
            group.push(decision);
            decisionsByBinding.set(decision.record.binding.bindingId, group);
        }
        const updates = new Map<string, BindingUpdate>();
        const changedOwnerReferences = new Map<string, Set<string>>();
        for (const [bindingId, decisions] of decisionsByBinding) {
            const before = decisions[0]!.record.binding;
            const owners = before.owners.map((owner) => ({ ...owner }));
            let canonicalOwner = before.canonicalOwner === undefined ? undefined : { ...before.canonicalOwner };
            let invalid = false;
            for (const decision of decisions.sort((left, right) => compareUtf8(left.record.reference.id, right.record.reference.id))) {
                const ownerIndex = owners.findIndex((owner) =>
                    owner.type === decision.record.owner.type && owner.id === decision.record.owner.id);
                if (ownerIndex < 0) {
                    this.addConflict(input.conflicts, decision.record.reference.id, "STALE_REFERENCE_NOT_FOUND", "The API owner relation changed before planning completed.");
                    invalid = true;
                    continue;
                }
                const currentOwner = owners[ownerIndex]!;
                const canonicalMatches = canonicalOwner?.type === currentOwner.type && canonicalOwner.id === currentOwner.id;
                if (decision.resolution.action === "remove") {
                    owners.splice(ownerIndex, 1);
                    if (canonicalMatches) canonicalOwner = undefined;
                    continue;
                }
                const replacement = nodesById.get(decision.resolution.replacementId);
                if (replacement === undefined || replacement.type !== currentOwner.type) {
                    this.addConflict(input.conflicts, decision.record.reference.id, "STALE_REPLACEMENT_INVALID", `Replacement ${decision.resolution.replacementId} must exist as ${currentOwner.type}.`);
                    invalid = true;
                    continue;
                }
                const nextOwner = { ...currentOwner, id: replacement.nodeId };
                owners[ownerIndex] = nextOwner;
                if (canonicalMatches) canonicalOwner = { type: nextOwner.type, id: nextOwner.id };
                const key = availabilityKey(bindingId, nextOwner);
                const references = changedOwnerReferences.get(key) ?? new Set<string>();
                references.add(decision.record.reference.id);
                changedOwnerReferences.set(key, references);
            }
            if (invalid) continue;
            const candidate = {
                ...apiBindingManifestItemFromDocument(before),
                owners,
                ...(canonicalOwner === undefined ? {} : { canonicalOwner }),
            } as Record<string, unknown>;
            if (canonicalOwner === undefined) delete candidate.canonicalOwner;
            try {
                const normalized = normalizeApiBindingCreateInput(candidate as unknown as ApiBindingCreateInput, this.schemes);
                const after = apiBindingDocumentFromInput(
                    input.reader.state.scopeKey,
                    input.reader.state.scope,
                    normalized,
                    before.revision + 1,
                    before.createdAt,
                    input.now,
                );
                updates.set(bindingId, { before, after });
            } catch (error) {
                if (!(error instanceof PermissionCoreError)) throw error;
                for (const decision of decisions) {
                    this.addConflict(input.conflicts, decision.record.reference.id, "STALE_REPLACEMENT_INVALID", "The API owner replacement violates binding owner invariants.");
                }
            }
        }

        const finalBindings = input.bindings.map((binding) => updates.get(binding.bindingId)?.after ?? binding);
        const availabilityGroups = new Map<string, Array<{
            readonly mode: "all" | "any";
            readonly referenceIds: readonly string[];
        }>>();
        for (const binding of finalBindings) {
            for (const owner of binding.owners) {
                if (owner.availabilityGroup === undefined) continue;
                const key = canonicalString([owner.type, owner.id, owner.availabilityGroup]);
                const entries = availabilityGroups.get(key) ?? [];
                entries.push({
                    mode: owner.availabilityMode!,
                    referenceIds: [...(changedOwnerReferences.get(availabilityKey(binding.bindingId, owner)) ?? [])],
                });
                availabilityGroups.set(key, entries);
            }
        }
        for (const entries of availabilityGroups.values()) {
            if (new Set(entries.map((entry) => entry.mode)).size < 2) continue;
            const referenceIds = [...new Set(entries.flatMap((entry) => entry.referenceIds))];
            if (referenceIds.length === 0) persistedInvalid("API availability group modes already conflict outside the selected stale references");
            for (const referenceId of referenceIds) {
                this.addConflict(input.conflicts, referenceId, "STALE_REPLACEMENT_INVALID", "The API owner replacement would mix all/any availability modes.");
            }
        }
        return Object.freeze([...updates.values()].sort((left, right) => compareUtf8(left.before.bindingId, right.before.bindingId)));
    }

    private async planRepair(
        reader: MenuScopeReader,
        input: ReturnType<typeof normalizeStaleRepairInput>,
        now: number,
    ): Promise<PreparedStaleRepairPlan> {
        const inventory = await this.loadInventory(reader);
        const records = collectStructuralStaleReferences(inventory);
        const recordsById = new Map<string, StructuralStaleRecord>();
        for (const record of records) {
            if (recordsById.has(record.reference.id)) persistedInvalid("structural stale reference identities collide");
            recordsById.set(record.reference.id, record);
        }
        const conflicts = new Map<string, ManagementConflict>();
        const operations = input.referenceIds.map((referenceId) => {
            const resolution = input.resolutions[referenceId]!;
            return deepFreeze({
                referenceId,
                action: resolution.action,
                ...(resolution.action === "rebind" ? { replacementId: resolution.replacementId } : {}),
            });
        });
        let nodeUpdates: readonly NodeUpdate[] = Object.freeze([]);
        let bindingUpdates: readonly BindingUpdate[] = Object.freeze([]);
        let temporaryNodeIds: readonly string[] = Object.freeze([]);
        if (input.referenceIds.length > COMPLETE_DECISION_LIMIT) {
            this.addConflict(
                conflicts,
                "stale-repair-decision-limit",
                "LIMIT_EXCEEDED",
                `Structural stale repair requires ${input.referenceIds.length} complete decisions; the executable preview limit is ${COMPLETE_DECISION_LIMIT}.`,
            );
        } else {
            const parentDecisions: ParentDecision[] = [];
            const apiOwnerDecisions: ApiOwnerDecision[] = [];
            for (const referenceId of input.referenceIds) {
                const record = recordsById.get(referenceId);
                if (record === undefined) {
                    this.addConflict(conflicts, referenceId, "STALE_REFERENCE_NOT_FOUND", "The selected structural reference is not currently stale.");
                    continue;
                }
                const resolution = input.resolutions[referenceId]!;
                if (record.kind === "parent") {
                    parentDecisions.push({
                        record,
                        resolution,
                        parentId: resolution.action === "remove" ? null : resolution.replacementId,
                    });
                } else {
                    apiOwnerDecisions.push({ record, resolution });
                }
            }
            const nodePlan = this.buildNodeUpdates({
                reader,
                nodes: inventory.nodes,
                decisions: parentDecisions,
                conflicts,
                now,
            });
            nodeUpdates = nodePlan.updates;
            temporaryNodeIds = nodePlan.temporaryNodeIds;
            bindingUpdates = this.buildBindingUpdates({
                reader,
                nodes: inventory.nodes,
                bindings: inventory.bindings,
                decisions: apiOwnerDecisions,
                conflicts,
                now,
            });
            const physicalMutations = temporaryNodeIds.length + nodeUpdates.length + bindingUpdates.length;
            if (physicalMutations > MUTATION_LIMIT) {
                this.addConflict(
                    conflicts,
                    "stale-repair-mutation-limit",
                    "LIMIT_EXCEEDED",
                    `Structural stale repair requires ${physicalMutations} writes; the atomic limit is ${MUTATION_LIMIT}.`,
                );
            }
        }

        const completePlan = toPolicyValue({ operations, sourceImpacts: [] });
        try {
            assertAuditChangeBudget({ kind: "menu-stale-repair", plan: completePlan });
        } catch (error) {
            if (!(error instanceof PermissionCoreError) || error.code !== "LIMIT_EXCEEDED") throw error;
            this.addConflict(conflicts, "stale-repair-audit-limit", "LIMIT_EXCEEDED", "The structural stale repair audit plan exceeds its byte budget.");
        }
        const sortedConflicts = [...conflicts.values()]
            .sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.id, right.id));
        const referenceIdSet = new Set(input.referenceIds);
        const globalBlocked = sortedConflicts.some((conflict) => !referenceIdSet.has(conflict.id));
        const conflictedIds = new Set(sortedConflicts.map((conflict) => conflict.id));
        const summarySamples = input.referenceIds.map((referenceId) => ({
            id: referenceId,
            outcome: (globalBlocked || conflictedIds.has(referenceId) ? "conflicted" : "updated") as "conflicted" | "updated",
        }));
        const conflicted = summarySamples.filter((sample) => sample.outcome === "conflicted").length;
        const summaryCounts = emptyBatchCounts({
            updated: summarySamples.length - conflicted,
            conflicted,
        });
        const revisionEntities = [{
            kind: "scope" as const,
            id: reader.state.scopeKey,
            revision: reader.state.revision,
        }];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities);
        const inputHash = digestCanonical(input);
        const planHash = menuPlanHash(
            "menus.previewRepairStaleReferences",
            inputHash,
            expectedRevisions,
            completePlan,
        );
        return {
            method: "menus.previewRepairStaleReferences",
            reader,
            inputHash,
            planHash,
            completePlan,
            requiredDecisionDetailCount: sortedConflicts.length === 0 ? operations.length : 0,
            publicPlan: (budget) => deepFreeze({
                operations: budget.bounded(operations),
                sourceImpacts: budget.bounded([]),
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts,
            summarySamples,
            warnings: Object.freeze([]),
            conflicts: Object.freeze(sortedConflicts),
            capacity: null,
            nodeUpdates,
            bindingUpdates,
            temporaryNodeIds,
        };
    }

    async previewRepairStaleReferences(
        scope: PermissionScope,
        inputValue: StaleRepairInput,
        optionsValue?: PreviewOptions,
    ): Promise<ImpactPreview<StaleRepairPlan>> {
        const input = normalizeStaleRepairInput(inputValue);
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const state = await this.repository.scopeStates.read(scope, transaction.session);
            return this.planRepair(
                new MenuScopeReader(this.repository, this.schemes, state, transaction.session),
                input,
                issuedAt,
            );
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared });
    }

    async repairStaleReferences(
        scope: PermissionScope,
        inputValue: StaleRepairInput,
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<BatchMutationSummary>> {
        const input = normalizeStaleRepairInput(inputValue);
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation: "menus.repairStaleReferences",
            action: "repair",
            resource: "menu:stale-references",
            request: toPolicyValue({ input, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay: decodeBatchMutationSummaryReplay,
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.planRepair(reader, input, now);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                const data: BatchMutationSummary = deepFreeze({
                    ...prepared.summaryCounts,
                    samples: new DetailBudgetAllocator().bounded(sortBatchMutationSamples(prepared.summarySamples)),
                });
                const changed = prepared.nodeUpdates.length > 0 || prepared.bindingUpdates.length > 0;
                if (!changed) {
                    return {
                        changed: false,
                        data,
                        primaryRevision: state.menuRevision,
                        entity: { kind: "scope", id: `menu:${state.scopeKey}`, before: state.menuRevision, after: state.menuRevision },
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "menu-stale-repair", plan: prepared.completePlan },
                        cacheTargets: [],
                        validatedPlanHash: prepared.planHash,
                    };
                }
                const aggregate = planMenuAggregate({
                    state,
                    beforeNodes: prepared.nodeUpdates.map((entry) => entry.before),
                    afterNodes: prepared.nodeUpdates.map((entry) => entry.after),
                    beforeBindings: prepared.bindingUpdates.map((entry) => entry.before),
                    afterBindings: prepared.bindingUpdates.map((entry) => entry.after),
                });
                const nodeUpdates = new Map(prepared.nodeUpdates.map((entry) => [entry.before.nodeId, entry] as const));
                const temporaryNodeIds = new Set(prepared.temporaryNodeIds);
                for (const [index, nodeId] of prepared.temporaryNodeIds.entries()) {
                    const update = nodeUpdates.get(nodeId);
                    if (update === undefined) databaseWriteFailure(`temporary menu node ${nodeId} has no final update`);
                    const result = await this.repository.collections.menuNodes.updateOne(
                        { scopeKey: state.scopeKey, nodeId, revision: update.before.revision },
                        {
                            $set: { parentId: update.after.parentId, order: -(index + 1) },
                            ...(update.before.code === undefined ? {} : { $unset: { code: "" } }),
                        },
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`menu:${nodeId}`, update.before.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure(`temporary menu node ${nodeId} was not moved`);
                }
                const compactionUpdates = prepared.nodeUpdates
                    .filter((entry) => !temporaryNodeIds.has(entry.before.nodeId))
                    .sort((left, right) =>
                        compareUtf8(left.before.parentId ?? "", right.before.parentId ?? "")
                        || left.before.order - right.before.order
                        || compareUtf8(left.before.nodeId, right.before.nodeId));
                for (const update of compactionUpdates) {
                    const result = await this.repository.collections.menuNodes.updateOne(
                        { scopeKey: state.scopeKey, nodeId: update.before.nodeId, revision: update.before.revision },
                        nodeUpdateDocument(update.after),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`menu:${update.before.nodeId}`, update.before.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure(`menu node ${update.before.nodeId} was not compacted`);
                }
                for (const nodeId of prepared.temporaryNodeIds) {
                    const update = nodeUpdates.get(nodeId)!;
                    const result = await this.repository.collections.menuNodes.updateOne(
                        { scopeKey: state.scopeKey, nodeId, revision: update.before.revision },
                        nodeUpdateDocument(update.after),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`menu:${nodeId}`, update.before.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure(`menu node ${nodeId} was not finalized`);
                }
                for (const update of prepared.bindingUpdates) {
                    const result = await this.repository.collections.apiBindings.updateOne(
                        { scopeKey: state.scopeKey, bindingId: update.before.bindingId, revision: update.before.revision },
                        bindingUpdateDocument(update.after),
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) revisionConflict(`api-binding:${update.before.bindingId}`, update.before.revision);
                    if (result.modifiedCount !== 1) databaseWriteFailure(`API binding ${update.before.bindingId} was not repaired`);
                }
                for (const update of prepared.nodeUpdates) {
                    const postImage = await reader.requireNode(update.after.nodeId);
                    if (canonicalString(postImage) !== canonicalString(update.after)) {
                        databaseWriteFailure(`menu node ${update.after.nodeId} differs from its repair plan`);
                    }
                }
                for (const update of prepared.bindingUpdates) {
                    const postImage = await reader.requireBinding(update.after.bindingId);
                    if (canonicalString(postImage) !== canonicalString(update.after)) {
                        databaseWriteFailure(`API binding ${update.after.bindingId} differs from its repair plan`);
                    }
                }
                return {
                    changed: true,
                    data,
                    primaryRevision: state.menuRevision + 1,
                    entity: { kind: "scope", id: `menu:${state.scopeKey}`, before: state.menuRevision, after: state.menuRevision + 1 },
                    revisionImpact: { rbac: false, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "menu-stale-repair", plan: prepared.completePlan },
                    cacheTargets: [`scope:${state.scopeKey}:menu`],
                    validatedPlanHash: prepared.planHash,
                };
            },
        });
    }
}
