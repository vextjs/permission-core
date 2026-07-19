import { types as utilTypes } from "node:util";
import type { MongoSession } from "monsqlize";
import type {
    CursorQuery,
    EntityStatus,
    PageResult,
    PermissionRuleView,
    PermissionScope,
    Role,
    RoleRemovalImpact,
    UserRoleBindingSet,
    VersionedResult,
} from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { SignedTokenCodec } from "../internal/signed-token";
import { compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { PermissionRepository } from "../persistence/repository";
import type { InternalRoleRuleDocument } from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import {
    materializeRoleDocument,
    materializeRoleRuleDocument,
    materializeUserRoleSetDocument,
} from "./materialize";
import {
    effectiveRoleRulesView,
    loadEffectiveRoleHierarchy,
    loadRoleHierarchy,
    loadRoleManagementAuthorization,
    roleChainView,
    userEffectiveRolesView,
} from "./effective";
import { normalizeRbacId } from "./validation";
import {
    completePermissionRuleView,
    permissionRuleView,
    roleView,
    userRoleBindingView,
} from "./views";
import {
    RbacReadStore,
    type RbacAuthorizationResolver,
    type RbacScopeReader,
} from "./store";
import {
    DetailBudgetAllocator,
    assertAuthorizationResponseBudget,
    fitAuthorizationPage,
    rbacEtag,
    revisionVector,
} from "./result";

const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_MAX_BYTES = 8 * 1024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

type RoleListQuery = CursorQuery & {
    status?: EntityStatus;
    search?: string;
    parentId?: string | null;
};

type RuleListQuery = CursorQuery & {
    effect?: "allow" | "deny";
    sourceKind?: "manual" | "menu";
};

interface NormalizedPage {
    readonly first: number;
    readonly after?: string;
}

function exactRecord(value: unknown, field: string, allowed: readonly string[]) {
    const input = value ?? {};
    if (input === null || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain object");
    }
    const record: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !allowed.includes(key)) {
            throw validationError("INVALID_ARGUMENT", field, `contains unsupported key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw validationError("INVALID_ARGUMENT", `${field}.${key}`, "must be an enumerable defined data property");
        }
        record[key] = descriptor.value;
    }
    return record;
}

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

function normalizeRoleListQuery(value: unknown) {
    const record = exactRecord(value, "query", ["first", "after", "status", "search", "parentId"]);
    const page = normalizePage(record);
    if (record.status !== undefined && record.status !== "enabled" && record.status !== "disabled" && record.status !== "deprecated") {
        throw validationError("INVALID_ARGUMENT", "query.status", "must be enabled, disabled, or deprecated");
    }
    let search: string | undefined;
    if (record.search !== undefined) {
        if (typeof record.search !== "string") {
            throw validationError("INVALID_ARGUMENT", "query.search", "must be a string");
        }
        search = record.search.trim();
        if (!search || Buffer.byteLength(search, "utf8") > 128) {
            throw validationError("INVALID_ARGUMENT", "query.search", "must contain 1..128 UTF-8 bytes after trimming");
        }
    }
    const parentId = record.parentId === null
        ? null
        : record.parentId === undefined ? undefined : normalizeRbacId(record.parentId, "query.parentId");
    return deepFreeze({
        ...page,
        ...(record.status === undefined ? {} : { status: record.status as EntityStatus }),
        ...(search === undefined ? {} : { search }),
        ...(parentId === undefined ? {} : { parentId }),
    });
}

function normalizeRuleListQuery(value: unknown) {
    const record = exactRecord(value, "query", ["first", "after", "effect", "sourceKind"]);
    const page = normalizePage(record);
    if (record.effect !== undefined && record.effect !== "allow" && record.effect !== "deny") {
        throw validationError("INVALID_ARGUMENT", "query.effect", "must be allow or deny");
    }
    if (record.sourceKind !== undefined && record.sourceKind !== "manual" && record.sourceKind !== "menu") {
        throw validationError("INVALID_ARGUMENT", "query.sourceKind", "must be manual or menu");
    }
    return deepFreeze({
        ...page,
        ...(record.effect === undefined ? {} : { effect: record.effect as "allow" | "deny" }),
        ...(record.sourceKind === undefined ? {} : { sourceKind: record.sourceKind as "manual" | "menu" }),
    });
}

function normalizeBasicPage(value: unknown) {
    return normalizePage(exactRecord(value, "query", ["first", "after"]));
}

function cursorStale(owner: string, expected: number | string, current: number | string): never {
    throw new PermissionCoreError("CURSOR_STALE", "The cursor no longer matches current RBAC state.", {
        details: { kind: "cursor-stale", owner, expected, current },
    });
}

function cursorInvalid(reason: string): never {
    throw new PermissionCoreError("INVALID_CURSOR", "The cursor is invalid.", {
        details: { kind: "validation", field: "cursor", reason },
    });
}

function exactCursorPayload(record: Readonly<Record<string, unknown>>) {
    const allowed = new Set([
        "version", "purpose", "coreNamespaceHash", "method", "scopeKey", "queryHash",
        "rbacRevision", "menuRevision", "anchor", "issuedAt", "expiresAt",
    ]);
    const keys = Object.keys(record);
    if (keys.some((key) => !allowed.has(key))) {
        cursorInvalid("contains an invalid payload shape");
    }
    if (
        typeof record.method !== "string"
        || typeof record.scopeKey !== "string"
        || typeof record.queryHash !== "string"
        || !Number.isSafeInteger(record.rbacRevision)
        || (record.rbacRevision as number) < 0
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
    const authorizationSensitive = record.method === "roles.listOwnRules";
    if (
        Object.hasOwn(record, "menuRevision") !== authorizationSensitive
        || keys.length !== (authorizationSensitive ? allowed.size : allowed.size - 1)
        || (authorizationSensitive && (!Number.isSafeInteger(record.menuRevision) || (record.menuRevision as number) < 0))
    ) {
        cursorInvalid("contains an invalid revision binding");
    }
    return record as Readonly<Record<string, unknown>> & {
        method: string;
        scopeKey: string;
        queryHash: string;
        rbacRevision: number;
        menuRevision?: number;
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
    if (normalized !== value) {
        cursorInvalid(`contains a non-canonical ${field}`);
    }
    return normalized;
}

function exactCursorAnchor(
    method: string,
    anchor: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
    const keys = Object.keys(anchor);
    if (method === "roles.list") {
        if (keys.length !== 1 || keys[0] !== "roleId") {
            cursorInvalid("contains an invalid role anchor shape");
        }
        return Object.freeze({ roleId: exactCursorId(anchor.roleId, "roleId") });
    }
    if (method === "roles.listOwnRules") {
        if (
            keys.length !== 2
            || !keys.includes("effect")
            || !keys.includes("semanticKey")
            || (anchor.effect !== "allow" && anchor.effect !== "deny")
            || typeof anchor.semanticKey !== "string"
            || !/^[A-Za-z0-9_-]{43}$/u.test(anchor.semanticKey)
        ) {
            cursorInvalid("contains an invalid rule anchor shape");
        }
        return Object.freeze({ effect: anchor.effect, semanticKey: anchor.semanticKey });
    }
    if (method === "userRoles.listUsersByRole") {
        if (keys.length !== 1 || keys[0] !== "userId") {
            cursorInvalid("contains an invalid user anchor shape");
        }
        return Object.freeze({ userId: exactCursorId(anchor.userId, "userId") });
    }
    return cursorInvalid("contains an unsupported cursor method");
}

function readOptions() {
    return { cache: 0, collation: SIMPLE_COLLATION };
}

function assertCount(value: number, field: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new PermissionCoreError("PERSISTED_STATE_INVALID", "A role impact count is malformed.", {
            details: { kind: "persisted-state-invalid", stage: "load", reason: `${field} count is invalid` },
        });
    }
    return value;
}

export class RbacQueryService {
    private readonly store: RbacReadStore;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly resourceSchemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        private readonly authorizationResolver?: RbacAuthorizationResolver,
    ) {
        this.store = new RbacReadStore(repository, resourceSchemes, authorizationResolver);
    }

    open(scope: PermissionScope, session?: MongoSession) {
        return this.store.open(scope, session);
    }

    private readCursor(
        token: string | undefined,
        method: string,
        reader: RbacScopeReader,
        queryHash: string,
    ) {
        if (token === undefined) {
            return undefined;
        }
        const payload = exactCursorPayload(this.tokens.decode(
            token,
            "pc:v2:manager-cursor",
            "INVALID_CURSOR",
            CURSOR_MAX_BYTES,
        ));
        if (payload.method !== method || payload.scopeKey !== reader.state.scopeKey || payload.queryHash !== queryHash) {
            cursorInvalid("does not match the current method, scope, or query");
        }
        if (payload.expiresAt - payload.issuedAt !== CURSOR_TTL_MS) {
            cursorInvalid("contains an invalid validity interval");
        }
        const now = Date.now();
        if (payload.issuedAt > now || payload.expiresAt <= now) {
            cursorStale("manager-cursor-expiry", payload.expiresAt, now);
        }
        if (payload.rbacRevision !== reader.state.rbacRevision) {
            cursorStale("scope.rbac", payload.rbacRevision, reader.state.rbacRevision);
        }
        if (payload.menuRevision !== undefined && payload.menuRevision !== reader.state.menuRevision) {
            cursorStale("scope.menu", payload.menuRevision, reader.state.menuRevision);
        }
        return exactCursorAnchor(method, payload.anchor);
    }

    private writeCursor(
        method: string,
        reader: RbacScopeReader,
        queryHash: string,
        anchor: Readonly<Record<string, string>>,
    ) {
        const issuedAt = Date.now();
        return this.tokens.encode("pc:v2:manager-cursor", {
            method,
            scopeKey: reader.state.scopeKey,
            queryHash,
            rbacRevision: reader.state.rbacRevision,
            ...(method === "roles.listOwnRules" ? { menuRevision: reader.state.menuRevision } : {}),
            anchor,
            issuedAt,
            expiresAt: issuedAt + CURSOR_TTL_MS,
        });
    }

    private pageResult<T>(
        reader: RbacScopeReader,
        items: readonly T[],
        hasNext: boolean,
        endCursor: string | null,
        queryHash: string,
        completeDetails: unknown = [],
        detailAllocator = new DetailBudgetAllocator(),
        authorizationSensitive = false,
    ): PageResult<T> {
        const detailBudget = detailAllocator.finish(completeDetails);
        const result = deepFreeze({
            items: [...items],
            pageInfo: { hasNext, endCursor },
            revision: reader.state.rbacRevision,
            revisions: revisionVector(reader.state),
            etag: rbacEtag(
                reader.state.rbacRevision,
                authorizationSensitive
                    ? digestCanonical({ queryHash, menuRevision: reader.state.menuRevision })
                    : queryHash,
            ),
            detailBudget,
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async getRole(scope: PermissionScope, roleIdInput: string): Promise<VersionedResult<Role>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const reader = await this.open(scope);
        const role = await reader.requireRole(roleId);
        await reader.verifyRbacUnchanged();
        const data = roleView(role);
        const detailBudget = new DetailBudgetAllocator().finish([]);
        return deepFreeze({
            data,
            revision: role.revision,
            revisions: revisionVector(reader.state, [{ kind: "role", id: role.roleId, revision: role.revision }]),
            etag: rbacEtag(role.revision, digestCanonical({ method: "roles.get", roleId: role.roleId })),
            detailBudget,
        });
    }

    async listRoles(scope: PermissionScope, queryInput?: RoleListQuery): Promise<PageResult<Role>> {
        const query = normalizeRoleListQuery(queryInput);
        const reader = await this.open(scope);
        const queryHash = digestCanonical({
            method: "roles.list",
            status: query.status ?? null,
            search: query.search ?? null,
            parentId: query.parentId === undefined ? "__any__" : query.parentId,
            sortVersion: 1,
        });
        const cursor = this.readCursor(query.after, "roles.list", reader, queryHash);
        const cursorRoleId = cursor?.roleId;
        if (cursorRoleId !== undefined && typeof cursorRoleId !== "string") {
            cursorInvalid("contains an invalid role anchor");
        }
        let after: string | undefined = cursorRoleId;
        const matches: Role[] = [];
        const base: Record<string, unknown> = { scopeKey: reader.state.scopeKey };
        if (query.status !== undefined) base.status = query.status;
        if (query.parentId !== undefined) base.parentId = query.parentId;
        const pageSize = Math.min(this.repository.findMaxLimit, PAGE_MAX);
        while (matches.length < query.first + 1) {
            const filter = after === undefined ? base : { $and: [base, { roleId: { $gt: after } }] };
            const rows = await this.repository.collections.roles.find(filter, readOptions())
                .sort({ roleId: 1 })
                .limit(pageSize)
                .toArray();
            if (rows.length === 0) break;
            for (const row of rows) {
                const role = materializeRoleDocument(row, reader.state.scope, reader.state.scopeKey);
                if (after !== undefined && compareUtf8(role.roleId, after) <= 0) {
                    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Role pagination did not advance.", {
                        details: { kind: "persisted-state-invalid", stage: "load", reason: "role cursor order is non-monotonic" },
                    });
                }
                after = role.roleId;
                const view = roleView(role);
                if (
                    query.search === undefined
                    || view.id.toLocaleLowerCase("en-US").includes(query.search.toLocaleLowerCase("en-US"))
                    || view.label.toLocaleLowerCase("en-US").includes(query.search.toLocaleLowerCase("en-US"))
                ) {
                    matches.push(view);
                    if (matches.length >= query.first + 1) break;
                }
            }
            if (rows.length < pageSize) break;
        }
        await reader.verifyRbacUnchanged();
        const hasNext = matches.length > query.first;
        const items = matches.slice(0, query.first);
        const endCursor = hasNext && items.length > 0
            ? this.writeCursor("roles.list", reader, queryHash, { roleId: items[items.length - 1]!.id })
            : null;
        return this.pageResult(reader, items, hasNext, endCursor, queryHash);
    }

    async getOwnRules(scope: PermissionScope, roleIdInput: string): Promise<VersionedResult<PermissionRuleView[]>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const reader = await this.open(scope);
        const role = await reader.requireRole(roleId);
        const persistedRules = await reader.readRulesForRole(role.roleId);
        const resolved = await reader.resolveRulesForManagement([role.roleId], persistedRules);
        const budget = new DetailBudgetAllocator();
        const rules = persistedRules.map((rule) => permissionRuleView(rule, resolved.sourceViews, budget));
        await reader.verifyAuthorizationUnchanged();
        const detailBudget = budget.finish(
            persistedRules.map((rule) => completePermissionRuleView(rule, resolved.sourceViews)),
        );
        const data = deepFreeze(rules);
        assertAuthorizationResponseBudget({ data, detailBudget });
        return deepFreeze({
            data,
            revision: role.revision,
            revisions: revisionVector(reader.state, [{ kind: "role", id: role.roleId, revision: role.revision }]),
            etag: rbacEtag(role.revision, digestCanonical({
                method: "roles.getOwnRules",
                roleId: role.roleId,
                menuRevision: reader.state.menuRevision,
            })),
            detailBudget,
        });
    }

    async listOwnRules(scope: PermissionScope, roleIdInput: string, queryInput?: RuleListQuery) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const query = normalizeRuleListQuery(queryInput);
        const reader = await this.open(scope);
        await reader.requireRole(roleId);
        const queryHash = digestCanonical({
            method: "roles.listOwnRules",
            roleId,
            effect: query.effect ?? null,
            sourceKind: query.sourceKind ?? null,
            sortVersion: 1,
        });
        const cursor = this.readCursor(query.after, "roles.listOwnRules", reader, queryHash);
        let afterEffect = cursor?.effect;
        let afterSemanticKey = cursor?.semanticKey;
        if (
            (afterEffect !== undefined && afterEffect !== "allow" && afterEffect !== "deny")
            || (afterSemanticKey !== undefined && typeof afterSemanticKey !== "string")
            || ((afterEffect === undefined) !== (afterSemanticKey === undefined))
        ) {
            cursorInvalid("contains an invalid rule anchor");
        }
        const base: Record<string, unknown> = { scopeKey: reader.state.scopeKey, roleId };
        if (query.effect !== undefined) base.effect = query.effect;
        const matches: Readonly<InternalRoleRuleDocument>[] = [];
        const pageSize = Math.min(this.repository.findMaxLimit, PAGE_MAX);
        while (matches.length < query.first + 1) {
            const filter = afterEffect === undefined
                ? base
                : {
                    $and: [base, { $or: [
                        { effect: { $gt: afterEffect } },
                        { effect: afterEffect, semanticKey: { $gt: afterSemanticKey } },
                    ] }],
                };
            const rows = await this.repository.collections.roleRules.find(filter, readOptions())
                .sort({ effect: 1, semanticKey: 1 })
                .limit(pageSize)
                .toArray();
            if (rows.length === 0) break;
            for (const row of rows) {
                const rule = materializeRoleRuleDocument(row, reader.state.scope, reader.state.scopeKey, this.resourceSchemes);
                if (
                    afterEffect !== undefined
                    && (
                        compareUtf8(rule.effect, afterEffect as string) < 0
                        || (rule.effect === afterEffect && compareUtf8(rule.semanticKey, afterSemanticKey as string) <= 0)
                    )
                ) {
                    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Rule pagination did not advance.", {
                        details: { kind: "persisted-state-invalid", stage: "load", reason: "rule cursor order is non-monotonic" },
                    });
                }
                afterEffect = rule.effect;
                afterSemanticKey = rule.semanticKey;
                if (query.sourceKind === undefined || rule.sources.some((source) => source.kind === query.sourceKind)) {
                    matches.push(rule);
                    if (matches.length >= query.first + 1) break;
                }
            }
            if (rows.length < pageSize) break;
        }
        const resolved = await reader.resolveRulesForManagement([roleId]);
        await reader.verifyAuthorizationUnchanged();
        return fitAuthorizationPage(Math.min(query.first, matches.length), (itemCount) => {
            const itemRules = matches.slice(0, itemCount);
            const budget = new DetailBudgetAllocator();
            const items = itemRules.map((rule) => permissionRuleView(rule, resolved.sourceViews, budget));
            const hasNext = matches.length > itemCount;
            const last = items[items.length - 1];
            const endCursor = hasNext && last
                ? this.writeCursor("roles.listOwnRules", reader, queryHash, { effect: last.effect, semanticKey: last.semanticKey })
                : null;
            const completeRuleDetails = itemRules
                .map((rule) => completePermissionRuleView(rule, resolved.sourceViews));
            return this.pageResult(
                reader,
                items,
                hasNext,
                endCursor,
                queryHash,
                completeRuleDetails,
                budget,
                true,
            );
        });
    }

    async getEffectiveRules(scope: PermissionScope, roleIdInput: string) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const reader = await this.open(scope);
        const state = await loadRoleManagementAuthorization(reader, roleId);
        await reader.verifyAuthorizationUnchanged();
        const { result, detailBudget } = effectiveRoleRulesView(
            state.requested,
            state.roles,
            state.rules,
            state.sourceViews,
        );
        return deepFreeze({
            data: result,
            revision: state.requested.revision,
            revisions: revisionVector(reader.state, state.roles.map((role) => ({
                kind: "role" as const,
                id: role.document.roleId,
                revision: role.document.revision,
            }))),
            etag: rbacEtag(state.requested.revision, digestCanonical({
                method: "roles.getEffectiveRules",
                roleId,
                menuRevision: reader.state.menuRevision,
            })),
            detailBudget,
        });
    }

    async getChain(scope: PermissionScope, roleIdInput: string) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const reader = await this.open(scope);
        const state = await loadRoleHierarchy(reader, roleId);
        await reader.verifyRbacUnchanged();
        const data = [...roleChainView(state.roles)];
        const detailBudget = new DetailBudgetAllocator().finish(data);
        return deepFreeze({
            data,
            revision: state.requested.revision,
            revisions: revisionVector(reader.state, state.roles.map((role) => ({ kind: "role" as const, id: role.document.roleId, revision: role.document.revision }))),
            etag: rbacEtag(state.requested.revision, digestCanonical({ method: "roles.getChain", roleId })),
            detailBudget,
        });
    }

    async getRemovalImpact(scope: PermissionScope, roleIdInput: string): Promise<VersionedResult<RoleRemovalImpact>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const reader = await this.open(scope);
        const role = await reader.requireRole(roleId);
        const childFilter = { scopeKey: reader.state.scopeKey, parentId: roleId };
        const userFilter = { scopeKey: reader.state.scopeKey, roleIds: roleId };
        const [childrenTotal, usersTotal, rules] = await Promise.all([
            this.repository.collections.roles.count(childFilter, readOptions()),
            this.repository.collections.userRoleSets.count(userFilter, readOptions()),
            reader.readRulesForRole(roleId),
        ]);
        const sampleLimit = Math.min(this.repository.findMaxLimit, 100);
        const childRows = await this.repository.collections.roles.find(childFilter, readOptions()).sort({ roleId: 1 }).limit(sampleLimit).toArray();
        const userRows = await this.repository.collections.userRoleSets.find(userFilter, readOptions()).sort({ userId: 1 }).limit(sampleLimit).toArray();
        const childIds = childRows.map((row) => materializeRoleDocument(row, reader.state.scope, reader.state.scopeKey).roleId);
        const userIds = userRows.map((row) => materializeUserRoleSetDocument(row, reader.state.scope, reader.state.scopeKey).userId);
        await reader.verifyRbacUnchanged();
        const budget = new DetailBudgetAllocator();
        const childDetails = budget.bounded(childIds);
        const userDetails = budget.bounded(userIds);
        const blockers = [
            ...(childrenTotal > 0 ? ["children"] : []),
            ...(usersTotal > 0 ? ["bound-users"] : []),
            ...(rules.length > 0 ? ["own-rules"] : []),
            ...(role.menuSourceCount > 0 || role.menuGrantCount > 0 ? ["menu-sources"] : []),
        ];
        const data: RoleRemovalImpact = deepFreeze({
            roleId,
            children: {
                total: assertCount(childrenTotal, "children"),
                sampleIds: childDetails.items,
                truncated: childrenTotal > childDetails.items.length,
                digest: digestCanonical({ query: "children", rbacRevision: reader.state.rbacRevision, total: childrenTotal, sampleIds: childIds }),
            },
            boundUsers: {
                total: assertCount(usersTotal, "boundUsers"),
                sampleIds: userDetails.items,
                truncated: usersTotal > userDetails.items.length,
                digest: digestCanonical({ query: "bound-users", rbacRevision: reader.state.rbacRevision, total: usersTotal, sampleIds: userIds }),
            },
            ownRules: rules.length,
            menuSources: role.menuSourceCount,
            removable: blockers.length === 0,
            blockers: budget.bounded(blockers),
        });
        const detailBudget = budget.finish({ childIds, userIds, blockers });
        return deepFreeze({
            data,
            revision: role.revision,
            revisions: revisionVector(reader.state, [{ kind: "role", id: roleId, revision: role.revision }]),
            etag: rbacEtag(role.revision, digestCanonical({ method: "roles.getRemovalImpact", roleId })),
            detailBudget,
        });
    }

    async getDirectUserRoles(scope: PermissionScope, userIdInput: string): Promise<VersionedResult<UserRoleBindingSet>> {
        const userId = normalizeRbacId(userIdInput, "userId");
        const reader = await this.open(scope);
        const direct = await reader.readUserRoleSet(userId);
        await reader.verifyRbacUnchanged();
        const data = userRoleBindingView(direct);
        const detailBudget = new DetailBudgetAllocator().finish([]);
        return deepFreeze({
            data,
            revision: direct.revision,
            revisions: revisionVector(reader.state, [{ kind: "user-role-set", id: userId, revision: direct.revision }]),
            etag: rbacEtag(direct.revision, digestCanonical({ method: "userRoles.getDirect", userId })),
            detailBudget,
        });
    }

    async getEffectiveUserRoles(scope: PermissionScope, userIdInput: string) {
        const userId = normalizeRbacId(userIdInput, "userId");
        const reader = await this.open(scope);
        const direct = await reader.readUserRoleSet(userId);
        const state = await loadEffectiveRoleHierarchy(reader, direct);
        await reader.verifyRbacUnchanged();
        const { result, detailBudget } = userEffectiveRolesView(state);
        return deepFreeze({
            data: result,
            revision: direct.revision,
            revisions: revisionVector(reader.state, [{ kind: "user-role-set", id: userId, revision: direct.revision }]),
            etag: rbacEtag(direct.revision, digestCanonical({ method: "userRoles.getEffective", userId })),
            detailBudget,
        });
    }

    async listUsersByRole(scope: PermissionScope, roleIdInput: string, queryInput?: CursorQuery) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const query = normalizeBasicPage(queryInput);
        const reader = await this.open(scope);
        await reader.requireRole(roleId);
        const queryHash = digestCanonical({ method: "userRoles.listUsersByRole", roleId, sortVersion: 1 });
        const cursor = this.readCursor(query.after, "userRoles.listUsersByRole", reader, queryHash);
        const cursorUserId = cursor?.userId;
        if (cursorUserId !== undefined && typeof cursorUserId !== "string") cursorInvalid("contains an invalid user anchor");
        let after: string | undefined = cursorUserId;
        const base = { scopeKey: reader.state.scopeKey, roleIds: roleId };
        const matches: UserRoleBindingSet[] = [];
        const pageSize = Math.min(this.repository.findMaxLimit, query.first + 1);
        while (matches.length < query.first + 1) {
            const filter = after === undefined ? base : { $and: [base, { userId: { $gt: after } }] };
            const rows = await this.repository.collections.userRoleSets.find(filter, readOptions()).sort({ userId: 1 }).limit(pageSize).toArray();
            if (rows.length === 0) break;
            for (const row of rows) {
                const set = materializeUserRoleSetDocument(row, reader.state.scope, reader.state.scopeKey);
                if (after !== undefined && compareUtf8(set.userId, after) <= 0) {
                    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "User pagination did not advance.", {
                        details: { kind: "persisted-state-invalid", stage: "load", reason: "user cursor order is non-monotonic" },
                    });
                }
                after = set.userId;
                matches.push(userRoleBindingView(set));
                if (matches.length >= query.first + 1) break;
            }
            if (rows.length < pageSize) break;
        }
        await reader.verifyRbacUnchanged();
        const hasNext = matches.length > query.first;
        const items = matches.slice(0, query.first);
        const last = items[items.length - 1];
        const endCursor = hasNext && last
            ? this.writeCursor("userRoles.listUsersByRole", reader, queryHash, { userId: last.userId })
            : null;
        return this.pageResult(reader, items, hasNext, endCursor, queryHash);
    }
}
