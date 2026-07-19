import { types as utilTypes } from "node:util";
import type {
    AuthorizationTreeNode,
    CursorQuery,
    DirectMenuGrantSnapshot,
    DirectMenuPermissionSnapshot,
    EffectiveMenuPermissionSnapshot,
    PageResult,
    PermissionRuleAction,
    PermissionScope,
    RuleConflict,
    StaleMenuPermissionSource,
    VersionedResult,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { SignedTokenCodec } from "../internal/signed-token";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
    InternalRoleDocument,
    InternalRoleMenuGrantDocument,
    InternalRoleRuleDocument,
} from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import {
    collectEffectiveRuleStates,
    loadRoleHierarchy,
    type EffectiveRuleState,
} from "../rbac/effective";
import { materializeRoleDocument } from "../rbac/materialize";
import {
    DetailBudgetAllocator,
    assertAuthorizationResponseBudget,
    fitAuthorizationPage,
    rbacEtag,
    revisionVector,
} from "../rbac/result";
import {
    MAX_EFFECTIVE_RULES,
    MAX_RULES_PER_ROLE,
    RbacReadStore,
    type RbacAuthorizationResolver,
    type RbacScopeReader,
} from "../rbac/store";
import { normalizeRbacId } from "../rbac/validation";
import { completeDetails } from "../rbac/views";
import { menuNodeView } from "./materialize";
import {
    completeDirectMenuGrant,
    publicDirectMenuGrant,
    resolveRoleMenuRole,
    type ResolvedRoleMenuGrant,
    type RoleMenuInventoryView,
    type RoleMenuRoleResolution,
} from "./role-menu-resolution";
import { validateMenuGraph } from "./queries";
import {
    MAX_EFFECTIVE_ROLE_MENU_GRANTS,
    MAX_MENU_TREE_NODES,
    MAX_ROLE_MENU_GRANTS,
    MenuScopeReader,
} from "./store";

const CURSOR_PURPOSE = "pc:v2:manager-cursor";
const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_MAX_BYTES = 8 * 1024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const STALE_ROLE_BATCH_SIZE = Math.max(1, Math.min(
    PAGE_MAX,
    Math.floor(MAX_EFFECTIVE_RULES / MAX_RULES_PER_ROLE),
    Math.floor(MAX_EFFECTIVE_ROLE_MENU_GRANTS / MAX_ROLE_MENU_GRANTS),
));

interface DirectCursorAnchor {
    readonly effect: "allow" | "deny";
    readonly grantId: string;
}

interface StaleCursorAnchor {
    readonly roleId: string;
    readonly grantId: string;
    readonly sourceId: string;
}

type RoleMenuCursorAnchor = DirectCursorAnchor | StaleCursorAnchor;

interface EffectiveGrantState {
    readonly grant: ResolvedRoleMenuGrant;
    readonly sourceRoleId: string;
    readonly inherited: boolean;
    readonly depth: number;
}

function readOptions() {
    return { cache: 0, collation: SIMPLE_COLLATION };
}

function exactQuery(value: unknown, allowed: readonly string[]) {
    const input = value ?? {};
    if (input === null || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) {
        throw validationError("INVALID_ARGUMENT", "query", "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw validationError("INVALID_ARGUMENT", "query", "must be a plain object");
    }
    const record = input as Readonly<Record<string, unknown>>;
    const extra = Object.keys(record).find((key) => !allowed.includes(key));
    if (extra !== undefined) throw validationError("INVALID_ARGUMENT", `query.${extra}`, "is not supported");
    return record;
}

function normalizePage(record: Readonly<Record<string, unknown>>) {
    const first = record.first ?? PAGE_DEFAULT;
    if (!Number.isSafeInteger(first) || (first as number) < 1 || (first as number) > PAGE_MAX) {
        throw validationError("INVALID_ARGUMENT", "query.first", `must be an integer between 1 and ${PAGE_MAX}`);
    }
    if (record.after !== undefined && (typeof record.after !== "string" || record.after.length === 0)) {
        throw validationError("INVALID_ARGUMENT", "query.after", "must be a non-empty cursor string");
    }
    return {
        first: first as number,
        ...(record.after === undefined ? {} : { after: record.after as string }),
    };
}

function normalizeDirectQuery(value?: CursorQuery & { effect?: "allow" | "deny" }) {
    const record = exactQuery(value, ["first", "after", "effect"]);
    if (record.effect !== undefined && record.effect !== "allow" && record.effect !== "deny") {
        throw validationError("INVALID_ARGUMENT", "query.effect", "must be allow or deny");
    }
    return deepFreeze({ ...normalizePage(record), ...(record.effect === undefined ? {} : { effect: record.effect }) });
}

function normalizeStaleQuery(value?: CursorQuery) {
    return deepFreeze(normalizePage(exactQuery(value, ["first", "after"])));
}

function cursorInvalid(reason: string): never {
    throw new PermissionCoreError("INVALID_CURSOR", "The role-menu cursor is invalid.", {
        details: { kind: "validation", field: "cursor", reason },
    });
}

function cursorStale(owner: string, expected: number | string, current: number | string): never {
    throw new PermissionCoreError("CURSOR_STALE", "The role-menu cursor no longer matches current authorization state.", {
        details: { kind: "cursor-stale", owner, expected, current },
    });
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

function exactCursorPayload(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) cursorInvalid("contains an invalid payload");
    const record = value as Readonly<Record<string, unknown>>;
    const allowed = new Set([
        "version", "purpose", "coreNamespaceHash", "method", "scopeKey", "queryHash",
        "rbacRevision", "menuRevision", "anchor", "issuedAt", "expiresAt",
    ]);
    if (Object.keys(record).length !== allowed.size || Object.keys(record).some((key) => !allowed.has(key))) {
        cursorInvalid("contains an invalid payload shape");
    }
    if (
        typeof record.method !== "string"
        || typeof record.scopeKey !== "string"
        || typeof record.queryHash !== "string"
        || !Number.isSafeInteger(record.rbacRevision)
        || !Number.isSafeInteger(record.menuRevision)
        || !Number.isSafeInteger(record.issuedAt)
        || !Number.isSafeInteger(record.expiresAt)
        || record.anchor === null
        || typeof record.anchor !== "object"
        || Array.isArray(record.anchor)
    ) {
        cursorInvalid("contains invalid scalar fields");
    }
    return record as typeof record & {
        method: string;
        scopeKey: string;
        queryHash: string;
        rbacRevision: number;
        menuRevision: number;
        anchor: Readonly<Record<string, unknown>>;
        issuedAt: number;
        expiresAt: number;
    };
}

function exactCursorAnchor(method: string, value: Readonly<Record<string, unknown>>): RoleMenuCursorAnchor {
    const keys = Object.keys(value);
    if (method === "roles.menuPermissions.listDirect") {
        if (keys.length !== 2 || !keys.includes("effect") || !keys.includes("grantId")) {
            cursorInvalid("contains an invalid direct-grant anchor");
        }
        if (value.effect !== "allow" && value.effect !== "deny") cursorInvalid("contains an invalid grant effect");
        return deepFreeze({ effect: value.effect, grantId: exactCursorId(value.grantId, "cursor.grantId") });
    }
    if (method === "roles.menuPermissions.listStale") {
        if (keys.length !== 3 || !keys.includes("roleId") || !keys.includes("grantId") || !keys.includes("sourceId")) {
            cursorInvalid("contains an invalid stale-source anchor");
        }
        return deepFreeze({
            roleId: exactCursorId(value.roleId, "cursor.roleId"),
            grantId: exactCursorId(value.grantId, "cursor.grantId"),
            sourceId: exactCursorId(value.sourceId, "cursor.sourceId"),
        });
    }
    return cursorInvalid("contains an unsupported method");
}

function compareDirect(left: DirectCursorAnchor, right: DirectCursorAnchor) {
    return compareUtf8(left.effect, right.effect) || compareUtf8(left.grantId, right.grantId);
}

function compareStale(left: StaleCursorAnchor, right: StaleCursorAnchor) {
    return compareUtf8(left.roleId, right.roleId)
        || compareUtf8(left.grantId, right.grantId)
        || compareUtf8(left.sourceId, right.sourceId);
}

function limitExceeded(limitName: string, current: number, max: number): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", "The role-menu diagnostic exceeds its limit.", {
        details: {
            kind: "limit-exceeded",
            origin: "persisted-authorization-state",
            limitName,
            current,
            max,
            unit: "items",
        },
    });
}

function conflictGroups(rules: readonly EffectiveRuleState[]) {
    const groups = new Map<string, {
        action: PermissionRuleAction;
        resource: string;
        allows: string[];
        denies: string[];
    }>();
    for (const rule of rules) {
        const key = canonicalString({
            action: rule.document.action,
            resource: rule.document.resource,
            where: rule.document.where ?? null,
        });
        const group = groups.get(key) ?? {
            action: rule.document.action,
            resource: rule.document.resource,
            allows: [],
            denies: [],
        };
        (rule.document.effect === "allow" ? group.allows : group.denies).push(rule.document.semanticKey);
        groups.set(key, group);
    }
    return [...groups.values()]
        .filter((group) => group.allows.length > 0 && group.denies.length > 0)
        .sort((left, right) => compareUtf8(left.action, right.action) || compareUtf8(left.resource, right.resource));
}

function publicConflicts(groups: ReturnType<typeof conflictGroups>, budget: DetailBudgetAllocator) {
    const selected = budget.sample(groups, groups.length);
    const items: RuleConflict[] = selected.map((group) => deepFreeze({
        action: group.action,
        resource: group.resource,
        allowSemanticKeys: budget.bounded([...new Set(group.allows)].sort(compareUtf8)),
        denySemanticKeys: budget.bounded([...new Set(group.denies)].sort(compareUtf8)),
        resolution: "deny" as const,
    }));
    return deepFreeze({
        total: groups.length,
        items,
        truncated: selected.length < groups.length,
        digest: digestCanonical(groups),
    });
}

function completePublicConflicts(groups: ReturnType<typeof conflictGroups>) {
    return groups.map((group): RuleConflict => deepFreeze({
        action: group.action,
        resource: group.resource,
        allowSemanticKeys: completeDetails([...new Set(group.allows)].sort(compareUtf8)),
        denySemanticKeys: completeDetails([...new Set(group.denies)].sort(compareUtf8)),
        resolution: "deny" as const,
    }));
}

function combineSourceStatus(values: readonly ResolvedRoleMenuGrant[]) {
    if (values.length === 0) return null;
    const invalid = values.some((value) => value.sourceStatus.integrity === "invalid");
    const active = values.some((value) => value.sourceStatus.availability !== "inactive");
    const inactive = values.some((value) => value.sourceStatus.availability !== "active");
    return deepFreeze({
        integrity: invalid ? "invalid" as const : "valid" as const,
        availability: active && inactive
            ? "partially-active" as const
            : active ? "active" as const : "inactive" as const,
        drift: values.some((value) => value.sourceStatus.drift === "refresh-available")
            ? "refresh-available" as const
            : "current" as const,
    });
}

export class RoleMenuPermissionQueryService {
    private readonly rbacStore: RbacReadStore;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        authorizationResolver: RbacAuthorizationResolver,
    ) {
        this.rbacStore = new RbacReadStore(repository, schemes, authorizationResolver);
    }

    private readCursor(
        token: string | undefined,
        method: string,
        reader: RbacScopeReader,
        queryHash: string,
    ) {
        if (token === undefined) return undefined;
        const payload = exactCursorPayload(this.tokens.decode(token, CURSOR_PURPOSE, "INVALID_CURSOR", CURSOR_MAX_BYTES));
        if (payload.method !== method || payload.scopeKey !== reader.state.scopeKey || payload.queryHash !== queryHash) {
            cursorInvalid("does not match the current method, scope, or query");
        }
        if (payload.expiresAt - payload.issuedAt !== CURSOR_TTL_MS) cursorInvalid("contains an invalid validity interval");
        const now = Date.now();
        if (payload.issuedAt > now || payload.expiresAt <= now) cursorStale("manager-cursor-expiry", payload.expiresAt, now);
        if (payload.rbacRevision !== reader.state.rbacRevision) cursorStale("scope.rbac", payload.rbacRevision, reader.state.rbacRevision);
        if (payload.menuRevision !== reader.state.menuRevision) cursorStale("scope.menu", payload.menuRevision, reader.state.menuRevision);
        return exactCursorAnchor(method, payload.anchor);
    }

    private writeCursor(
        method: string,
        reader: RbacScopeReader,
        queryHash: string,
        anchor: Readonly<Record<string, string>>,
    ) {
        const issuedAt = Date.now();
        return this.tokens.encode(CURSOR_PURPOSE, {
            method,
            scopeKey: reader.state.scopeKey,
            queryHash,
            rbacRevision: reader.state.rbacRevision,
            menuRevision: reader.state.menuRevision,
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
        budget: DetailBudgetAllocator,
        completeDetails: unknown,
    ): PageResult<T> {
        const detailBudget = budget.finish(completeDetails);
        const result = deepFreeze({
            items: [...items],
            pageInfo: { hasNext, endCursor },
            revision: reader.state.rbacRevision,
            revisions: revisionVector(reader.state),
            etag: rbacEtag(reader.state.rbacRevision, digestCanonical({
                queryHash,
                menuRevision: reader.state.menuRevision,
            })),
            detailBudget,
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    private async open(scope: PermissionScope) {
        return this.rbacStore.open(scope);
    }

    private async loadManagement(
        reader: RbacScopeReader,
        roleIds: readonly string[],
    ) {
        const menuReader = new MenuScopeReader(
            this.repository,
            this.schemes,
            reader.state,
            reader.databaseSession(),
        );
        const [rolesById, rules, grants, complete] = await Promise.all([
            reader.readRoles(roleIds),
            reader.readRulesForRoles(roleIds),
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
                throw new PermissionCoreError("PERSISTED_STATE_INVALID", `Role ${roleId} disappeared during role-menu resolution.`, {
                    details: { kind: "persisted-state-invalid", stage: "load", reason: "role-menu-role-missing" },
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
        return { rolesById, rules, grants, complete, inventory, resolutions };
    }

    async getDirect(scope: PermissionScope, roleIdInput: string): Promise<VersionedResult<DirectMenuPermissionSnapshot>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const reader = await this.open(scope);
        const role = await reader.requireRole(roleId);
        const loaded = await this.loadManagement(reader, [roleId]);
        const resolution = loaded.resolutions.get(roleId)!;
        const budget = new DetailBudgetAllocator();
        const grants = resolution.grants.map((grant) => publicDirectMenuGrant(grant, budget));
        const completeGrants = resolution.grants.map(completeDirectMenuGrant);
        const data = deepFreeze({ roleId, grants });
        await reader.verifyAuthorizationUnchanged();
        const detailBudget = budget.finish({ grants: completeGrants });
        const result = deepFreeze({
            data,
            revision: role.revision,
            revisions: revisionVector(reader.state, [{ kind: "role", id: roleId, revision: role.revision }]),
            etag: rbacEtag(role.revision, digestCanonical({
                method: "roles.menuPermissions.getDirect",
                roleId,
                rbacRevision: reader.state.rbacRevision,
                menuRevision: reader.state.menuRevision,
            })),
            detailBudget,
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async listDirect(
        scope: PermissionScope,
        roleIdInput: string,
        queryInput?: CursorQuery & { effect?: "allow" | "deny" },
    ): Promise<PageResult<DirectMenuGrantSnapshot>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const query = normalizeDirectQuery(queryInput);
        const reader = await this.open(scope);
        await reader.requireRole(roleId);
        const queryHash = digestCanonical({
            method: "roles.menuPermissions.listDirect",
            roleId,
            effect: query.effect ?? null,
            sortVersion: 1,
        });
        const cursor = this.readCursor(query.after, "roles.menuPermissions.listDirect", reader, queryHash) as DirectCursorAnchor | undefined;
        const loaded = await this.loadManagement(reader, [roleId]);
        const complete = loaded.resolutions.get(roleId)!.grants
            .filter((grant) => query.effect === undefined || grant.document.effect === query.effect)
            .sort((left, right) => compareDirect(
                { effect: left.document.effect, grantId: left.document.grantId },
                { effect: right.document.effect, grantId: right.document.grantId },
            ));
        const filtered = cursor === undefined
            ? complete
            : complete.filter((grant) => compareDirect(
                { effect: grant.document.effect, grantId: grant.document.grantId },
                cursor,
            ) > 0);
        await reader.verifyAuthorizationUnchanged();
        return fitAuthorizationPage(Math.min(query.first, filtered.length), (itemCount) => {
            const selected = filtered.slice(0, itemCount);
            const budget = new DetailBudgetAllocator();
            const items = selected.map((grant) => publicDirectMenuGrant(grant, budget));
            const hasNext = filtered.length > itemCount;
            const last = selected[selected.length - 1];
            const endCursor = hasNext && last !== undefined
                ? this.writeCursor("roles.menuPermissions.listDirect", reader, queryHash, {
                    effect: last.document.effect,
                    grantId: last.document.grantId,
                })
                : null;
            const completeGrantDetails = selected.map(completeDirectMenuGrant);
            return this.pageResult(
                reader,
                items,
                hasNext,
                endCursor,
                queryHash,
                budget,
                completeGrantDetails,
            );
        });
    }

    private boundedEffectiveGrants(values: readonly EffectiveGrantState[], budget: DetailBudgetAllocator) {
        const selected = budget.sample(values, values.length);
        const items = selected.map((value) => deepFreeze({
            ...publicDirectMenuGrant(value.grant, budget),
            sourceRoleId: value.sourceRoleId,
            inherited: value.inherited,
            depth: value.depth,
        }));
        return deepFreeze({
            total: values.length,
            items,
            truncated: selected.length < values.length,
            digest: digestCanonical(values.map((value) => ({
                sourceRoleId: value.sourceRoleId,
                inherited: value.inherited,
                depth: value.depth,
                grantId: value.grant.document.grantId,
                revision: value.grant.document.grantRevision,
                sourceStatus: value.grant.sourceStatus,
            }))),
        });
    }

    private completeEffectiveGrants(values: readonly EffectiveGrantState[]) {
        return values.map((value) => deepFreeze({
            ...completeDirectMenuGrant(value.grant),
            sourceRoleId: value.sourceRoleId,
            inherited: value.inherited,
            depth: value.depth,
        }));
    }

    private effectiveGrantStates(
        resolutions: ReadonlyMap<string, RoleMenuRoleResolution>,
        roles: readonly { readonly document: Readonly<InternalRoleDocument>; readonly depth: number; readonly included: boolean }[],
    ) {
        return roles.filter((role) => role.included).flatMap((role) => (
            resolutions.get(role.document.roleId)?.grants.map((grant) => deepFreeze({
                grant,
                sourceRoleId: role.document.roleId,
                inherited: role.depth > 0,
                depth: role.depth,
            })) ?? []
        )).sort((left, right) => left.depth - right.depth
            || compareUtf8(left.sourceRoleId, right.sourceRoleId)
            || compareUtf8(left.grant.document.effect, right.grant.document.effect)
            || compareUtf8(left.grant.document.grantId, right.grant.document.grantId));
    }

    async getEffective(scope: PermissionScope, roleIdInput: string): Promise<VersionedResult<EffectiveMenuPermissionSnapshot>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const reader = await this.open(scope);
        const authorization = await loadRoleHierarchy(reader, roleId);
        const includedRoleIds = authorization.roles.filter((role) => role.included).map((role) => role.document.roleId);
        const loaded = await this.loadManagement(reader, includedRoleIds);
        const effectiveRules = collectEffectiveRuleStates(loaded.rules, authorization.roles);
        const grants = this.effectiveGrantStates(loaded.resolutions, authorization.roles);
        const budget = new DetailBudgetAllocator();
        const conflictEntries = conflictGroups(effectiveRules);
        const conflicts = publicConflicts(conflictEntries, budget);
        const data: EffectiveMenuPermissionSnapshot = deepFreeze({
            roleId,
            grants: this.boundedEffectiveGrants(grants, budget),
            conflicts,
        });
        await reader.verifyAuthorizationUnchanged();
        const detailBudget = budget.finish({
            grants: this.completeEffectiveGrants(grants),
            conflicts: completePublicConflicts(conflictEntries),
        });
        const result = deepFreeze({
            data,
            revision: authorization.requested.revision,
            revisions: revisionVector(reader.state, authorization.roles.map((role) => ({
                kind: "role" as const,
                id: role.document.roleId,
                revision: role.document.revision,
            }))),
            etag: rbacEtag(authorization.requested.revision, digestCanonical({
                method: "roles.menuPermissions.getEffective",
                roleId,
                rbacRevision: reader.state.rbacRevision,
                menuRevision: reader.state.menuRevision,
            })),
            detailBudget,
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    private bindingState(
        node: Readonly<InternalMenuNodeDocument>,
        binding: Readonly<InternalApiBindingDocument>,
        grants: readonly EffectiveGrantState[],
    ): AuthorizationTreeNode["apiBindingStates"]["items"][number] {
        const relevant = grants.filter((entry) => entry.grant.contributions.some((contribution) => (
            contribution.contribution === "api"
            && contribution.assetId === node.nodeId
            && contribution.apiBindingId === binding.bindingId
        )));
        const contributions = relevant.flatMap((entry) => entry.grant.contributions.filter((contribution) => (
            contribution.contribution === "api"
            && contribution.assetId === node.nodeId
            && contribution.apiBindingId === binding.bindingId
        )));
        const allow = contributions.some((contribution) => contribution.effect === "allow");
        const deny = contributions.some((contribution) => contribution.effect === "deny");
        const conditional = contributions.some((contribution) => contribution.where !== undefined);
        const coverage = allow && deny
            ? "conflict" as const
            : conditional ? "conditional" as const
                : deny ? "deny" as const
                    : allow ? "allow" as const : "none" as const;
        let reason: AuthorizationTreeNode["apiBindingStates"]["items"][number]["reason"];
        if (node.status !== "enabled" || binding.status !== "enabled") reason = "asset-inactive";
        else if (relevant.some((entry) => entry.grant.sourceStatus.integrity === "invalid")) reason = "integrity-invalid";
        else if (relevant.some((entry) => entry.grant.sourceStatus.drift === "refresh-available")) reason = "refresh-available";
        else if (conditional) reason = "requires-subject-context";
        else if (relevant.length === 0) reason = "no-role-rule";
        else if (relevant.some((entry) => entry.inherited) && relevant.some((entry) => !entry.inherited)) reason = "direct-and-inherited";
        else reason = relevant.some((entry) => !entry.inherited) ? "direct-rule" : "inherited-rule";
        return deepFreeze({ bindingId: binding.bindingId, coverage, reason });
    }

    async getAuthorizationTree(scope: PermissionScope, roleIdInput: string): Promise<VersionedResult<AuthorizationTreeNode[]>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const reader = await this.open(scope);
        const authorization = await loadRoleHierarchy(reader, roleId);
        const includedRoleIds = authorization.roles.filter((role) => role.included).map((role) => role.document.roleId);
        const loaded = await this.loadManagement(reader, includedRoleIds);
        if (loaded.complete.nodes.length > MAX_MENU_TREE_NODES) {
            limitExceeded("menu-tree-nodes", loaded.complete.nodes.length, MAX_MENU_TREE_NODES);
        }
        const graph = validateMenuGraph(loaded.complete.nodes);
        const grants = this.effectiveGrantStates(loaded.resolutions, authorization.roles);
        const grantsByNode = new Map<string, EffectiveGrantState[]>();
        for (const entry of grants) {
            const nodeIds = new Set([
                entry.grant.document.intent.anchorId,
                ...entry.grant.document.snapshot.contributingAssetIds,
            ]);
            for (const nodeId of nodeIds) {
                const group = grantsByNode.get(nodeId) ?? [];
                group.push(entry);
                grantsByNode.set(nodeId, group);
            }
        }
        const bindingsByOwner = new Map<string, Readonly<InternalApiBindingDocument>[]>();
        for (const binding of loaded.complete.bindings) {
            for (const owner of binding.owners) {
                const group = bindingsByOwner.get(owner.id) ?? [];
                group.push(binding);
                bindingsByOwner.set(owner.id, group);
            }
        }
        for (const bindings of bindingsByOwner.values()) {
            bindings.sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        }
        const buildComplete = (node: Readonly<InternalMenuNodeDocument>): AuthorizationTreeNode => {
            const related = grantsByNode.get(node.nodeId) ?? [];
            const allow = related.some((entry) => entry.grant.document.effect === "allow");
            const deny = related.some((entry) => entry.grant.document.effect === "deny");
            const state = allow && deny
                ? "conflict" as const
                : deny ? (related.some((entry) => !entry.inherited && entry.grant.document.effect === "deny")
                    ? "direct-deny" as const : "inherited-deny" as const)
                    : allow ? (related.some((entry) => !entry.inherited && entry.grant.document.effect === "allow")
                        ? "direct-allow" as const : "inherited-allow" as const)
                        : "none" as const;
            const childNodes = (graph.children.get(node.nodeId) ?? []).map(buildComplete);
            const ownSelected = related.length > 0;
            const selection = childNodes.length === 0
                ? (ownSelected ? "all" as const : "none" as const)
                : ownSelected && childNodes.every((child) => child.selection === "all")
                    ? "all" as const
                    : ownSelected || childNodes.some((child) => child.selection !== "none")
                        ? "partial" as const : "none" as const;
            const bindingStates = (bindingsByOwner.get(node.nodeId) ?? [])
                .map((binding) => this.bindingState(node, binding, grants));
            return deepFreeze({
                node: menuNodeView(node),
                state,
                sourceStatus: combineSourceStatus(related.map((entry) => entry.grant)),
                selection,
                grantIds: completeDetails([...new Set(related.map((entry) => entry.grant.document.grantId))].sort(compareUtf8)),
                apiBindingStates: completeDetails(bindingStates),
                children: childNodes,
            });
        };
        const completeData = deepFreeze((graph.children.get(null) ?? []).map(buildComplete));
        const budget = new DetailBudgetAllocator();
        const project = (node: AuthorizationTreeNode): AuthorizationTreeNode => deepFreeze({
            ...node,
            grantIds: budget.bounded(node.grantIds.items),
            apiBindingStates: budget.bounded(node.apiBindingStates.items),
            children: node.children.map(project),
        });
        const data = deepFreeze(completeData.map(project));
        await reader.verifyAuthorizationUnchanged();
        const detailBudget = budget.finish(completeData);
        const result = deepFreeze({
            data,
            revision: authorization.requested.revision,
            revisions: revisionVector(reader.state, authorization.roles.map((role) => ({
                kind: "role" as const,
                id: role.document.roleId,
                revision: role.document.revision,
            }))),
            etag: rbacEtag(authorization.requested.revision, digestCanonical({
                method: "roles.menuPermissions.getAuthorizationTree",
                roleId,
                rbacRevision: reader.state.rbacRevision,
                menuRevision: reader.state.menuRevision,
            })),
            detailBudget,
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async listStale(scope: PermissionScope, queryInput?: CursorQuery): Promise<PageResult<StaleMenuPermissionSource>> {
        const query = normalizeStaleQuery(queryInput);
        const reader = await this.open(scope);
        const queryHash = digestCanonical({ method: "roles.menuPermissions.listStale", sortVersion: 1 });
        const cursor = this.readCursor(query.after, "roles.menuPermissions.listStale", reader, queryHash) as StaleCursorAnchor | undefined;
        const menuReader = new MenuScopeReader(
            this.repository,
            this.schemes,
            reader.state,
            reader.databaseSession(),
        );
        const complete = await menuReader.readCompleteInventory();
        const inventory: RoleMenuInventoryView = {
            nodesById: new Map(complete.nodes.map((node) => [node.nodeId, node] as const)),
            bindingsById: new Map(complete.bindings.map((binding) => [binding.bindingId, binding] as const)),
            completeNodes: complete.nodes,
            completeBindings: complete.bindings,
        };
        const matches: StaleMenuPermissionSource[] = [];
        let afterRoleId: string | undefined;
        let firstPage = true;
        const pageSize = Math.min(STALE_ROLE_BATCH_SIZE, this.repository.findMaxLimit);
        while (matches.length < query.first + 1) {
            const roleFilter = firstPage && cursor !== undefined
                ? { scopeKey: reader.state.scopeKey, roleId: { $gte: cursor.roleId } }
                : afterRoleId === undefined
                    ? { scopeKey: reader.state.scopeKey }
                    : { scopeKey: reader.state.scopeKey, roleId: { $gt: afterRoleId } };
            firstPage = false;
            const rows = await this.repository.collections.roles.find(roleFilter, readOptions())
                .sort({ roleId: 1 })
                .limit(pageSize)
                .toArray();
            if (rows.length === 0) break;
            const roles = rows.map((row) => materializeRoleDocument(row, reader.state.scope, reader.state.scopeKey));
            const roleIds = roles.map((role) => role.roleId);
            afterRoleId = roleIds[roleIds.length - 1];
            const [rules, grants] = await Promise.all([
                reader.readRulesForRoles(roleIds),
                menuReader.readGrantsForRoles(roleIds),
            ]);
            const rulesByRole = new Map(roleIds.map((roleId) => [roleId, [] as Readonly<InternalRoleRuleDocument>[]]));
            for (const rule of rules) rulesByRole.get(rule.roleId)?.push(rule);
            const grantsByRole = new Map(roleIds.map((roleId) => [roleId, [] as Readonly<InternalRoleMenuGrantDocument>[]]));
            for (const grant of grants) grantsByRole.get(grant.roleId)?.push(grant);
            for (const role of roles) {
                const stale = resolveRoleMenuRole({
                    role,
                    rules: rulesByRole.get(role.roleId) ?? [],
                    grants: grantsByRole.get(role.roleId) ?? [],
                    inventory,
                    failOnInvalidReference: false,
                }).stale;
                for (const item of stale) {
                    if (cursor !== undefined && compareStale(item, cursor) <= 0) continue;
                    matches.push(item);
                    if (matches.length >= query.first + 1) break;
                }
                if (matches.length >= query.first + 1) break;
            }
            if (matches.length >= query.first + 1 || rows.length < pageSize) break;
        }
        await reader.verifyAuthorizationUnchanged();
        const hasNext = matches.length > query.first;
        const items = matches.slice(0, query.first);
        const last = items[items.length - 1];
        const endCursor = hasNext && last !== undefined
            ? this.writeCursor("roles.menuPermissions.listStale", reader, queryHash, {
                roleId: last.roleId,
                grantId: last.grantId,
                sourceId: last.sourceId,
            })
            : null;
        return this.pageResult(
            reader,
            items,
            hasNext,
            endCursor,
            queryHash,
            new DetailBudgetAllocator(),
            items,
        );
    }
}
