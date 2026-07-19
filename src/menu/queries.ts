import type {
    ApiBinding,
    ApiBindingFilter,
    CursorQuery,
    MenuNode,
    MenuNodeFilter,
    MenuNodeType,
    MenuTreeNode,
    PageResult,
    PermissionScope,
    VersionedResult,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
import { compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { SignedTokenCodec } from "../internal/signed-token";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import type { InternalMenuNodeDocument } from "../persistence/documents";
import {
    DetailBudgetAllocator,
    assertAuthorizationResponseBudget,
    revisionVector,
} from "../rbac/result";
import { normalizeRbacId } from "../rbac/validation";
import { apiBindingView, materializeApiBindingDocument, materializeMenuNodeDocument, menuNodeView } from "./materialize";
import { MAX_MENU_DEPTH, MAX_MENU_TREE_NODES, MenuReadStore, type MenuScopeReader } from "./store";
import {
    exactMenuRecord,
    normalizeApiBindingFilter,
    normalizeDeclaredPath,
    normalizeMenuNodeFilter,
} from "./validation";

const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_MAX_BYTES = 8 * 1024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

interface NormalizedPage {
    readonly first: number;
    readonly after?: string;
}

interface MenuCursorAnchor {
    readonly parentId: string | null;
    readonly order: number;
    readonly nodeId: string;
    readonly mongoId: string;
}

interface ApiBindingCursorAnchor {
    readonly method: string;
    readonly path: string;
    readonly bindingId: string;
    readonly mongoId: string;
}

type MenuManagerCursorAnchor = MenuCursorAnchor | ApiBindingCursorAnchor;

function normalizePage(record: Readonly<Record<string, unknown>>): NormalizedPage {
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

function normalizeMenuQuery(value?: CursorQuery & MenuNodeFilter) {
    const record = exactMenuRecord(value ?? {}, ["first", "after", "parentId", "type", "status", "hidden", "search"], "query");
    const page = normalizePage(record);
    const filter = normalizeMenuNodeFilter(Object.fromEntries(
        ["parentId", "type", "status", "hidden", "search"]
            .filter((key) => Object.hasOwn(record, key))
            .map((key) => [key, record[key]]),
    ));
    return deepFreeze({ ...page, ...filter });
}

function normalizeBindingQuery(value?: CursorQuery & ApiBindingFilter) {
    const record = exactMenuRecord(value ?? {}, ["first", "after", "method", "path", "status", "purpose", "ownerId"], "query");
    const page = normalizePage(record);
    const filter = normalizeApiBindingFilter(Object.fromEntries(
        ["method", "path", "status", "purpose", "ownerId"]
            .filter((key) => Object.hasOwn(record, key))
            .map((key) => [key, record[key]]),
    ));
    return deepFreeze({ ...page, ...filter });
}

function cursorInvalid(reason: string): never {
    throw new PermissionCoreError("INVALID_CURSOR", "The cursor is invalid.", {
        details: { kind: "validation", field: "cursor", reason },
    });
}

function cursorStale(owner: string, expected: number | string, current: number | string): never {
    throw new PermissionCoreError("CURSOR_STALE", "The cursor no longer matches current menu state.", {
        details: { kind: "cursor-stale", owner, expected, current },
    });
}

function exactCursorPayload(record: Readonly<Record<string, unknown>>) {
    const allowed = new Set([
        "version", "purpose", "coreNamespaceHash", "method", "scopeKey", "queryHash",
        "menuRevision", "anchor", "issuedAt", "expiresAt",
    ]);
    if (Object.keys(record).length !== allowed.size || Object.keys(record).some((key) => !allowed.has(key))) {
        cursorInvalid("contains an invalid payload shape");
    }
    if (
        typeof record.method !== "string"
        || typeof record.scopeKey !== "string"
        || typeof record.queryHash !== "string"
        || !Number.isSafeInteger(record.menuRevision)
        || (record.menuRevision as number) < 0
        || record.anchor === null
        || typeof record.anchor !== "object"
        || Array.isArray(record.anchor)
        || !Number.isSafeInteger(record.issuedAt)
        || !Number.isSafeInteger(record.expiresAt)
        || (record.issuedAt as number) < 0
        || (record.expiresAt as number) <= (record.issuedAt as number)
    ) {
        cursorInvalid("contains invalid payload fields");
    }
    return record as typeof record & {
        method: string;
        scopeKey: string;
        queryHash: string;
        menuRevision: number;
        anchor: Readonly<Record<string, unknown>>;
        issuedAt: number;
        expiresAt: number;
    };
}

function exactCursorId(value: unknown, field: string) {
    let normalized: string;
    try {
        normalized = normalizeRbacId(value, field);
    } catch {
        return cursorInvalid(`contains an invalid ${field}`);
    }
    if (normalized !== value) cursorInvalid(`contains a non-canonical ${field}`);
    return normalized;
}

function exactCursorMongoId(value: unknown) {
    if (typeof value !== "string" || !/^(?:oid:[0-9a-f]{24}|str:[A-Za-z0-9_-]{1,342})$/u.test(value)) {
        cursorInvalid("contains an invalid MongoDB tie-breaker");
    }
    return value;
}

function exactCursorAnchor(method: string, value: Readonly<Record<string, unknown>>): MenuManagerCursorAnchor {
    const keys = Object.keys(value);
    if (method === "menus.list") {
        if (
            keys.length !== 4
            || !keys.includes("parentId")
            || !keys.includes("order")
            || !keys.includes("nodeId")
            || !keys.includes("mongoId")
            || (value.parentId !== null && typeof value.parentId !== "string")
            || !Number.isSafeInteger(value.order)
            || (value.order as number) < 0
        ) {
            cursorInvalid("contains an invalid menu anchor shape");
        }
        return Object.freeze({
            parentId: value.parentId === null ? null : exactCursorId(value.parentId, "cursor.parentId"),
            order: value.order as number,
            nodeId: exactCursorId(value.nodeId, "cursor.nodeId"),
            mongoId: exactCursorMongoId(value.mongoId),
        });
    }
    if (method === "apiBindings.list") {
        if (
            keys.length !== 4
            || !keys.includes("method")
            || !keys.includes("path")
            || !keys.includes("bindingId")
            || !keys.includes("mongoId")
            || typeof value.method !== "string"
            || typeof value.path !== "string"
        ) {
            cursorInvalid("contains an invalid API binding anchor shape");
        }
        let path: string;
        try {
            path = normalizeDeclaredPath(value.path, "cursor.path");
        } catch {
            return cursorInvalid("contains an invalid API binding path");
        }
        if (path !== value.path || value.method !== value.method.toUpperCase() || !/^[A-Z][A-Z0-9-]{0,31}$/u.test(value.method)) {
            cursorInvalid("contains a non-canonical API binding anchor");
        }
        return Object.freeze({
            method: value.method,
            path,
            bindingId: exactCursorId(value.bindingId, "cursor.bindingId"),
            mongoId: exactCursorMongoId(value.mongoId),
        });
    }
    return cursorInvalid("contains an unsupported cursor method");
}

function mongoIdAnchor(row: Readonly<Record<string, unknown>>, kind: string) {
    if (!Object.hasOwn(row, "_id")) throw persistedGraph(`${kind} is missing its MongoDB identity`);
    const value = row._id;
    if (typeof value === "string") {
        const bytes = Buffer.from(value, "utf8");
        if (bytes.length === 0 || bytes.length > 256) throw persistedGraph(`${kind} has an invalid MongoDB string identity`);
        return `str:${bytes.toString("base64url")}`;
    }
    if (value !== null && typeof value === "object") {
        const toHexString = (value as { toHexString?: unknown }).toHexString;
        if (typeof toHexString === "function") {
            let hex: unknown;
            try {
                hex = toHexString.call(value);
            } catch {
                throw persistedGraph(`${kind} has an unreadable MongoDB ObjectId`);
            }
            if (typeof hex === "string" && /^[0-9a-fA-F]{24}$/u.test(hex)) return `oid:${hex.toLowerCase()}`;
        }
    }
    throw persistedGraph(`${kind} has an unsupported MongoDB identity`);
}

function compareNullableId(left: string | null, right: string | null) {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    return compareUtf8(left, right);
}

function compareMenuAnchor(left: MenuCursorAnchor, right: MenuCursorAnchor) {
    return compareNullableId(left.parentId, right.parentId)
        || left.order - right.order
        || compareUtf8(left.nodeId, right.nodeId)
        || compareUtf8(left.mongoId, right.mongoId);
}

function compareApiBindingAnchor(left: ApiBindingCursorAnchor, right: ApiBindingCursorAnchor) {
    return compareUtf8(left.method, right.method)
        || compareUtf8(left.path, right.path)
        || compareUtf8(left.bindingId, right.bindingId)
        || compareUtf8(left.mongoId, right.mongoId);
}

function menuAfterFilter(anchor: MenuCursorAnchor) {
    const sameParentTail = [
        { parentId: anchor.parentId, order: { $gt: anchor.order } },
        { parentId: anchor.parentId, order: anchor.order, nodeId: { $gt: anchor.nodeId } },
    ];
    return {
        $or: anchor.parentId === null
            ? [...sameParentTail, { parentId: { $ne: null } }]
            : [{ parentId: { $gt: anchor.parentId } }, ...sameParentTail],
    };
}

function apiBindingAfterFilter(anchor: ApiBindingCursorAnchor) {
    return {
        $or: [
            { method: { $gt: anchor.method } },
            { method: anchor.method, path: { $gt: anchor.path } },
            { method: anchor.method, path: anchor.path, bindingId: { $gt: anchor.bindingId } },
        ],
    };
}

function menuEtag(revision: number, queryHash: string) {
    return `W/"pc-menu-${revision}-${queryHash}"`;
}

function readOptions() {
    return { cache: 0, collation: SIMPLE_COLLATION };
}

function parentAllows(parentType: MenuNodeType, childType: MenuNodeType) {
    if (parentType === "directory") return childType !== "button";
    if (parentType === "menu") return childType !== "directory";
    if (parentType === "page") return childType === "button";
    return false;
}

interface ValidatedGraph {
    readonly nodes: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
    readonly children: ReadonlyMap<string | null, readonly Readonly<InternalMenuNodeDocument>[]>;
    readonly depths: ReadonlyMap<string, number>;
}

export function validateMenuGraph(rows: readonly Readonly<InternalMenuNodeDocument>[]): ValidatedGraph {
    const nodes = new Map<string, Readonly<InternalMenuNodeDocument>>();
    const paths = new Set<string>();
    const names = new Set<string>();
    const codes = new Set<string>();
    for (const node of rows) {
        if (nodes.has(node.nodeId)) throw persistedGraph("duplicate menu node identity");
        nodes.set(node.nodeId, node);
        for (const [value, set, label] of [
            [node.path, paths, "path"],
            [node.name, names, "name"],
            [node.code === undefined ? undefined : `${node.parentId ?? ""}\u0000${node.code}`, codes, "sibling code"],
        ] as const) {
            if (value !== undefined && set.has(value)) throw persistedGraph(`duplicate menu ${label}`);
            if (value !== undefined) set.add(value);
        }
    }
    const depths = new Map<string, number>();
    for (const node of rows) {
        const seen = new Set<string>();
        let current: Readonly<InternalMenuNodeDocument> | undefined = node;
        let depth = 0;
        while (current !== undefined) {
            if (seen.has(current.nodeId)) throw persistedGraph("menu hierarchy contains a cycle");
            seen.add(current.nodeId);
            depth += 1;
            if (depth > MAX_MENU_DEPTH) throw persistedGraph("menu hierarchy exceeds depth 64");
            if (current.parentId === null) break;
            const parent = nodes.get(current.parentId);
            if (!parent) throw persistedGraph("menu parent reference is missing");
            if (!parentAllows(parent.type, current.type)) throw persistedGraph("menu parent and child types are incompatible");
            current = parent;
        }
        if (node.type === "button" && node.parentId === null) throw persistedGraph("button cannot be a root node");
        depths.set(node.nodeId, depth);
    }
    const mutableChildren = new Map<string | null, Readonly<InternalMenuNodeDocument>[]>();
    for (const node of rows) {
        const group = mutableChildren.get(node.parentId) ?? [];
        group.push(node);
        mutableChildren.set(node.parentId, group);
    }
    const children = new Map<string | null, readonly Readonly<InternalMenuNodeDocument>[]>();
    for (const [parentId, group] of mutableChildren) {
        group.sort((left, right) => left.order - right.order || compareUtf8(left.nodeId, right.nodeId));
        group.forEach((node, index) => {
            if (node.order !== index) throw persistedGraph("menu sibling order is not dense");
        });
        children.set(parentId, Object.freeze(group));
    }
    return Object.freeze({ nodes, children, depths });
}

function persistedGraph(reason: string): PermissionCoreError {
    return new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu graph is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

export class MenuQueryService {
    private readonly store: MenuReadStore;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
    ) {
        this.store = new MenuReadStore(repository, schemes);
    }

    open(scope: PermissionScope) {
        return this.store.open(scope);
    }

    private readCursor(token: string | undefined, method: string, reader: MenuScopeReader, queryHash: string) {
        if (token === undefined) return undefined;
        const payload = exactCursorPayload(this.tokens.decode(token, "pc:v2:manager-cursor", "INVALID_CURSOR", CURSOR_MAX_BYTES));
        if (payload.method !== method || payload.scopeKey !== reader.state.scopeKey || payload.queryHash !== queryHash) {
            cursorInvalid("does not match the current method, scope, or query");
        }
        if (payload.expiresAt - payload.issuedAt !== CURSOR_TTL_MS) cursorInvalid("contains an invalid validity interval");
        const now = Date.now();
        if (payload.issuedAt > now || payload.expiresAt <= now) cursorStale("manager-cursor-expiry", payload.expiresAt, now);
        if (payload.menuRevision !== reader.state.menuRevision) cursorStale("scope.menu", payload.menuRevision, reader.state.menuRevision);
        return exactCursorAnchor(method, payload.anchor);
    }

    private writeCursor(
        method: string,
        reader: MenuScopeReader,
        queryHash: string,
        anchor: MenuManagerCursorAnchor,
    ) {
        const issuedAt = Date.now();
        return this.tokens.encode("pc:v2:manager-cursor", {
            method,
            scopeKey: reader.state.scopeKey,
            queryHash,
            menuRevision: reader.state.menuRevision,
            anchor: { ...anchor },
            issuedAt,
            expiresAt: issuedAt + CURSOR_TTL_MS,
        });
    }

    private pageResult<T>(reader: MenuScopeReader, items: readonly T[], hasNext: boolean, endCursor: string | null, queryHash: string): PageResult<T> {
        const detailBudget = new DetailBudgetAllocator().finish([]);
        const result = deepFreeze({
            items: [...items],
            pageInfo: { hasNext, endCursor },
            revision: reader.state.menuRevision,
            revisions: revisionVector(reader.state),
            etag: menuEtag(reader.state.menuRevision, queryHash),
            detailBudget,
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async getMenu(scope: PermissionScope, nodeIdInput: string): Promise<VersionedResult<MenuNode>> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const reader = await this.open(scope);
        const node = await reader.requireNode(nodeId);
        await reader.verifyMenuUnchanged();
        const data = menuNodeView(node);
        const result = deepFreeze({
            data,
            revision: node.revision,
            revisions: revisionVector(reader.state, [{ kind: "menu-node", id: node.nodeId, revision: node.revision }]),
            etag: menuEtag(node.revision, digestCanonical({ method: "menus.get", nodeId })),
            detailBudget: new DetailBudgetAllocator().finish([]),
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async listMenus(scope: PermissionScope, queryInput?: CursorQuery & MenuNodeFilter): Promise<PageResult<MenuNode>> {
        const query = normalizeMenuQuery(queryInput);
        const reader = await this.open(scope);
        const queryHash = digestCanonical({
            method: "menus.list",
            parentId: query.parentId === undefined ? "__any__" : query.parentId,
            type: query.type ?? null,
            status: query.status ?? null,
            hidden: query.hidden ?? null,
            search: query.search ?? null,
            sortVersion: 1,
        });
        const cursor = this.readCursor(query.after, "menus.list", reader, queryHash) as MenuCursorAnchor | undefined;
        let after = cursor;
        const matches: Array<{ readonly view: MenuNode; readonly anchor: MenuCursorAnchor }> = [];
        const base: Record<string, unknown> = { scopeKey: reader.state.scopeKey };
        if (query.parentId !== undefined) base.parentId = query.parentId;
        if (query.status !== undefined) base.status = query.status;
        if (query.hidden !== undefined) base.hidden = query.hidden;
        if (query.type !== undefined) base.type = Array.isArray(query.type) ? { $in: query.type } : query.type;
        const pageSize = Math.min(PAGE_MAX, this.repository.findMaxLimit);
        while (matches.length < query.first + 1) {
            const filter = after === undefined ? base : { $and: [base, menuAfterFilter(after)] };
            const rows = await this.repository.collections.menuNodes.find(filter, readOptions())
                .sort({ parentId: 1, order: 1, nodeId: 1, _id: 1 }).limit(pageSize).toArray();
            if (rows.length === 0) break;
            for (const row of rows) {
                const node = materializeMenuNodeDocument(row, reader.state.scope, reader.state.scopeKey, this.schemes);
                const rowAnchor: MenuCursorAnchor = Object.freeze({
                    parentId: node.parentId,
                    order: node.order,
                    nodeId: node.nodeId,
                    mongoId: mongoIdAnchor(row, "menu node"),
                });
                if (after !== undefined && compareMenuAnchor(rowAnchor, after) <= 0) throw persistedGraph("menu pagination did not advance");
                after = rowAnchor;
                const view = menuNodeView(node);
                const needle = query.search?.toLocaleLowerCase("en-US");
                if (!needle || view.id.toLocaleLowerCase("en-US").includes(needle) || view.title.toLocaleLowerCase("en-US").includes(needle)) {
                    matches.push({ view, anchor: rowAnchor });
                    if (matches.length >= query.first + 1) break;
                }
            }
            if (rows.length < pageSize) break;
        }
        await reader.verifyMenuUnchanged();
        const hasNext = matches.length > query.first;
        const page = matches.slice(0, query.first);
        const items = page.map((entry) => entry.view);
        const endCursor = hasNext && page.length > 0
            ? this.writeCursor("menus.list", reader, queryHash, page[page.length - 1]!.anchor)
            : null;
        return this.pageResult(reader, items, hasNext, endCursor, queryHash);
    }

    async getTree(scope: PermissionScope, optionsInput?: { rootId?: string; includeHidden?: boolean }): Promise<VersionedResult<MenuTreeNode[]>> {
        const options = exactMenuRecord(optionsInput ?? {}, ["rootId", "includeHidden"], "options");
        const rootId = Object.hasOwn(options, "rootId") ? normalizeRbacId(options.rootId, "options.rootId") : undefined;
        const includeHidden = Object.hasOwn(options, "includeHidden") ? options.includeHidden : false;
        if (typeof includeHidden !== "boolean") throw validationError("INVALID_ARGUMENT", "options.includeHidden", "must be a boolean");
        const reader = await this.open(scope);
        const rows = await reader.readAllNodes();
        const graph = validateMenuGraph(rows);
        if (rootId !== undefined && !graph.nodes.has(rootId)) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${rootId} was not found.`);
        const included = new Set<string>();
        const roots = rootId === undefined ? graph.children.get(null) ?? [] : [graph.nodes.get(rootId)!];
        const stack = [...roots].reverse();
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (!includeHidden && node.hidden) continue;
            included.add(node.nodeId);
            const children = graph.children.get(node.nodeId) ?? [];
            for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
        }
        if (included.size > MAX_MENU_TREE_NODES) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "The menu tree exceeds its node limit.", {
                details: {
                    kind: "limit-exceeded",
                    origin: "persisted-authorization-state",
                    limitName: "menu-tree-nodes",
                    current: included.size,
                    max: MAX_MENU_TREE_NODES,
                    unit: "items",
                },
            });
        }
        const mutable = new Map<string, MenuTreeNode & { children: MenuTreeNode[] }>();
        for (const node of rows) {
            if (included.has(node.nodeId)) mutable.set(node.nodeId, { ...menuNodeView(node), children: [] });
        }
        const ordered = [...rows].filter((node) => included.has(node.nodeId)).sort((left, right) =>
            (graph.depths.get(right.nodeId)! - graph.depths.get(left.nodeId)!) || compareUtf8(left.nodeId, right.nodeId));
        for (const node of ordered) {
            if (node.parentId !== null && included.has(node.parentId)) mutable.get(node.parentId)!.children.push(mutable.get(node.nodeId)!);
        }
        for (const entry of mutable.values()) {
            entry.children.sort((left, right) => left.order - right.order || compareUtf8(left.id, right.id));
            Object.freeze(entry.children);
            Object.freeze(entry);
        }
        const data = roots.filter((node) => included.has(node.nodeId)).map((node) => mutable.get(node.nodeId)!);
        await reader.verifyMenuUnchanged();
        const queryHash = digestCanonical({ method: "menus.getTree", rootId: rootId ?? null, includeHidden });
        const result = deepFreeze({
            data,
            revision: reader.state.menuRevision,
            revisions: revisionVector(reader.state),
            etag: menuEtag(reader.state.menuRevision, queryHash),
            detailBudget: new DetailBudgetAllocator().finish([]),
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async getApiBinding(scope: PermissionScope, bindingIdInput: string): Promise<VersionedResult<ApiBinding>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const reader = await this.open(scope);
        const binding = await reader.requireBinding(bindingId);
        await reader.verifyMenuUnchanged();
        const data = apiBindingView(binding);
        const result = deepFreeze({
            data,
            revision: binding.revision,
            revisions: revisionVector(reader.state, [{ kind: "api-binding", id: binding.bindingId, revision: binding.revision }]),
            etag: menuEtag(binding.revision, digestCanonical({ method: "apiBindings.get", bindingId })),
            detailBudget: new DetailBudgetAllocator().finish([]),
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async listApiBindings(scope: PermissionScope, queryInput?: CursorQuery & ApiBindingFilter): Promise<PageResult<ApiBinding>> {
        const query = normalizeBindingQuery(queryInput);
        const reader = await this.open(scope);
        const queryHash = digestCanonical({
            method: "apiBindings.list",
            methodFilter: query.method ?? null,
            path: query.path ?? null,
            status: query.status ?? null,
            purpose: query.purpose ?? null,
            ownerId: query.ownerId ?? null,
            sortVersion: 1,
        });
        const cursor = this.readCursor(query.after, "apiBindings.list", reader, queryHash) as ApiBindingCursorAnchor | undefined;
        let after = cursor;
        const matches: Array<{ readonly view: ApiBinding; readonly anchor: ApiBindingCursorAnchor }> = [];
        const base: Record<string, unknown> = { scopeKey: reader.state.scopeKey };
        if (query.method !== undefined) base.method = query.method;
        if (query.path !== undefined) base.path = query.path;
        if (query.status !== undefined) base.status = query.status;
        if (query.purpose !== undefined) base.purpose = query.purpose;
        if (query.ownerId !== undefined) base["owners.id"] = query.ownerId;
        const pageSize = Math.min(PAGE_MAX, this.repository.findMaxLimit);
        while (matches.length < query.first + 1) {
            const filter = after === undefined ? base : { $and: [base, apiBindingAfterFilter(after)] };
            const rows = await this.repository.collections.apiBindings.find(filter, readOptions())
                .sort({ method: 1, path: 1, bindingId: 1, _id: 1 }).limit(pageSize).toArray();
            if (rows.length === 0) break;
            for (const row of rows) {
                const binding = materializeApiBindingDocument(row, reader.state.scope, reader.state.scopeKey, this.schemes);
                const rowAnchor: ApiBindingCursorAnchor = Object.freeze({
                    method: binding.method,
                    path: binding.path,
                    bindingId: binding.bindingId,
                    mongoId: mongoIdAnchor(row, "API binding"),
                });
                if (after !== undefined && compareApiBindingAnchor(rowAnchor, after) <= 0) throw persistedGraph("API binding pagination did not advance");
                after = rowAnchor;
                matches.push({ view: apiBindingView(binding), anchor: rowAnchor });
                if (matches.length >= query.first + 1) break;
            }
            if (rows.length < pageSize) break;
        }
        await reader.verifyMenuUnchanged();
        const hasNext = matches.length > query.first;
        const page = matches.slice(0, query.first);
        const items = page.map((entry) => entry.view);
        const endCursor = hasNext && page.length > 0
            ? this.writeCursor("apiBindings.list", reader, queryHash, page[page.length - 1]!.anchor)
            : null;
        return this.pageResult(reader, items, hasNext, endCursor, queryHash);
    }
}
