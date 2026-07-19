import type {
    EffectiveCapacityUsage,
    EffectivePermissionSnapshot,
    EffectiveRoleRules,
    EffectiveRuleEntry,
    EffectiveUserRoleEntry,
    PermissionScope,
    RoleAuthorizationSnapshot,
    RoleChainEntry,
    RuleConflict,
    RuleSourceView,
    SubjectEffectiveRoleEntry,
    SubjectEffectiveRuleEntry,
    SubjectRuleConflict,
    UserEffectiveRoles,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import {
    canonicalByteLength,
    canonicalString,
    compareUtf8,
} from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { InternalRoleDocument, InternalRoleRuleDocument } from "../persistence/documents";
import type { InternalUserRoleSetView } from "./materialize";
import {
    completeDetails,
    completePermissionRuleView,
    permissionRuleView,
    userRoleBindingView,
} from "./views";
import {
    MAX_EFFECTIVE_ROLES,
    MAX_EFFECTIVE_RULES,
    MAX_EFFECTIVE_SNAPSHOT_BYTES,
    MAX_EFFECTIVE_SOURCES,
    MAX_ROLE_CHAIN_DEPTH,
    type RbacScopeReader,
} from "./store";
import { DetailBudgetAllocator, assertAuthorizationResponseBudget } from "./result";

export interface EffectiveRoleState {
    readonly document: Readonly<InternalRoleDocument>;
    readonly direct: boolean;
    readonly viaRoleIds: readonly string[];
    readonly depth: number;
    readonly included: boolean;
    readonly excludedReason?: "disabled" | "deprecated";
}

export interface EffectiveRuleState {
    readonly document: Readonly<InternalRoleRuleDocument>;
    readonly sourceRoleId: string;
    readonly inherited: boolean;
    readonly depth: number;
}

export interface EffectiveAuthorizationState {
    readonly direct: InternalUserRoleSetView;
    readonly roles: readonly EffectiveRoleState[];
    readonly rules: readonly EffectiveRuleState[];
    readonly sourceViews: ReadonlyMap<string, RuleSourceView>;
    readonly usage: EffectiveCapacityUsage;
}

export interface EffectiveAuthorizationOverlay {
    readonly roles?: ReadonlyMap<string, Readonly<InternalRoleDocument>>;
    readonly rulesByRoleId?: ReadonlyMap<string, readonly Readonly<InternalRoleRuleDocument>[]>;
}

export interface EffectiveAuthorizationLoadOptions {
    readonly overlay?: EffectiveAuthorizationOverlay;
    readonly enforceLimits?: boolean;
}

export interface EffectiveAuthorizationReader {
    readRoles(roleIds: readonly string[]): Promise<ReadonlyMap<string, Readonly<InternalRoleDocument>>>;
    readRulesForRoles(roleIds: readonly string[]): Promise<readonly Readonly<InternalRoleRuleDocument>[]>;
    resolveRulesForAuthorization?(roleIds: readonly string[]): Promise<{
        readonly rules: readonly Readonly<InternalRoleRuleDocument>[];
        readonly sourceViews: ReadonlyMap<string, RuleSourceView>;
    }>;
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted role inheritance is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function roleLimit(current: number): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", "The effective role expansion exceeds its limit.", {
        details: {
            kind: "limit-exceeded",
            origin: "persisted-authorization-state",
            limitName: "effective-roles",
            current,
            max: MAX_EFFECTIVE_ROLES,
            unit: "items",
        },
    });
}

function depthLimit(current: number): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", "The role parent chain exceeds its depth limit.", {
        details: {
            kind: "limit-exceeded",
            origin: "persisted-authorization-state",
            limitName: "role-chain-depth",
            current,
            max: MAX_ROLE_CHAIN_DEPTH,
            unit: "depth",
        },
    });
}

function roleSnapshot(document: Readonly<InternalRoleDocument>): RoleAuthorizationSnapshot {
    return deepFreeze({
        id: document.roleId,
        status: document.status,
        parentId: document.parentId,
        revision: document.revision,
    });
}

function subjectRoleSnapshot(document: Readonly<InternalRoleDocument>) {
    return deepFreeze({
        id: document.roleId,
        status: document.status,
        parentId: document.parentId,
    });
}

async function loadReachableRoles(
    reader: EffectiveAuthorizationReader,
    directRoleIds: readonly string[],
    overlay?: EffectiveAuthorizationOverlay,
) {
    const roles = new Map<string, Readonly<InternalRoleDocument>>();
    let frontier = [...new Set(directRoleIds)].sort(compareUtf8);
    for (let depth = 0; frontier.length > 0; depth += 1) {
        if (depth >= MAX_ROLE_CHAIN_DEPTH) {
            depthLimit(depth + 1);
        }
        const missing = frontier.filter((roleId) => !roles.has(roleId));
        if (missing.length === 0) {
            break;
        }
        const loaded = await reader.readRoles(missing);
        for (const roleId of missing) {
            const role = overlay?.roles?.get(roleId) ?? loaded.get(roleId);
            if (!role) {
                persistedInvalid("user-role-binding-references-missing-role");
            }
            roles.set(roleId, role);
            if (roles.size > MAX_EFFECTIVE_ROLES) {
                roleLimit(roles.size);
            }
        }
        frontier = [...new Set(missing.flatMap((roleId) => {
            const role = roles.get(roleId)!;
            return role.status === "enabled" && role.parentId !== null && !roles.has(role.parentId)
                ? [role.parentId]
                : [];
        }))].sort(compareUtf8);
    }
    return roles;
}

function collectRoleStates(
    roles: ReadonlyMap<string, Readonly<InternalRoleDocument>>,
    directRoleIds: readonly string[],
) {
    const combined = new Map<string, {
        document: Readonly<InternalRoleDocument>;
        direct: boolean;
        viaRoleIds: Set<string>;
        depth: number;
        included: boolean;
        excludedReason?: "disabled" | "deprecated";
    }>();

    for (const directRoleId of directRoleIds) {
        const seen = new Set<string>();
        let currentId: string | null = directRoleId;
        for (let depth = 0; currentId !== null; depth += 1) {
            if (depth >= MAX_ROLE_CHAIN_DEPTH) {
                depthLimit(depth + 1);
            }
            if (seen.has(currentId)) {
                throw new PermissionCoreError("CIRCULAR_INHERITANCE", "The role parent chain contains a cycle.");
            }
            seen.add(currentId);
            const document = roles.get(currentId);
            if (!document) {
                persistedInvalid("role-parent-missing");
            }
            const included = document.status === "enabled";
            const existing = combined.get(currentId);
            if (existing) {
                existing.direct ||= depth === 0;
                existing.viaRoleIds.add(directRoleId);
                existing.depth = Math.min(existing.depth, depth);
            } else {
                combined.set(currentId, {
                    document,
                    direct: depth === 0,
                    viaRoleIds: new Set([directRoleId]),
                    depth,
                    included,
                    ...(included ? {} : { excludedReason: document.status as "disabled" | "deprecated" }),
                });
            }
            if (!included) {
                break;
            }
            currentId = document.parentId;
        }
    }

    return [...combined.values()]
        .sort((left, right) => compareUtf8(left.document.roleId, right.document.roleId))
        .map((value): EffectiveRoleState => deepFreeze({
            document: value.document,
            direct: value.direct,
            viaRoleIds: [...value.viaRoleIds].sort(compareUtf8),
            depth: value.depth,
            included: value.included,
            ...(value.excludedReason === undefined ? {} : { excludedReason: value.excludedReason }),
        }));
}

export function collectEffectiveRuleStates(
    documents: readonly Readonly<InternalRoleRuleDocument>[],
    roles: readonly EffectiveRoleState[],
) {
    const roleState = new Map(roles.map((role) => [role.document.roleId, role]));
    return documents.map((document): EffectiveRuleState => {
        const role = roleState.get(document.roleId);
        if (!role?.included) {
            persistedInvalid("rule-returned-for-excluded-role");
        }
        return deepFreeze({
            document,
            sourceRoleId: document.roleId,
            inherited: !role.direct,
            depth: role.depth,
        });
    }).sort((left, right) => (
        compareUtf8(left.document.effect, right.document.effect)
        || compareUtf8(left.document.semanticKey, right.document.semanticKey)
        || compareUtf8(left.sourceRoleId, right.sourceRoleId)
    ));
}

export async function loadEffectiveRoleHierarchy(
    reader: EffectiveAuthorizationReader,
    userRoleSet: InternalUserRoleSetView,
    overlay?: EffectiveAuthorizationOverlay,
) {
    const rolesById = await loadReachableRoles(reader, userRoleSet.roleIds, overlay);
    const roles = collectRoleStates(rolesById, userRoleSet.roleIds);
    return deepFreeze({ direct: userRoleSet, roles });
}

export async function loadRoleHierarchy(reader: RbacScopeReader, roleId: string) {
    const requested = await reader.requireRole(roleId);
    const rolesById = await loadReachableRoles(reader, [requested.roleId]);
    const roles = collectRoleStates(rolesById, [requested.roleId]);
    return deepFreeze({ requested, roles });
}

function measureUsage(
    roles: readonly EffectiveRoleState[],
    rules: readonly EffectiveRuleState[],
    enforceLimits: boolean,
): EffectiveCapacityUsage {
    const includedRoles = roles.filter((role) => role.included);
    const sourceRefs = rules.reduce((total, rule) => total + rule.document.sources.length, 0);
    const completeSnapshot = {
        roles: includedRoles.map((role) => ({
            id: role.document.roleId,
            status: role.document.status,
            parentId: role.document.parentId,
            direct: role.direct,
            viaRoleIds: role.viaRoleIds,
            depth: role.depth,
        })),
        rules: rules.map((rule) => ({
            effect: rule.document.effect,
            action: rule.document.action,
            resource: rule.document.resource,
            ...(rule.document.where === undefined ? {} : { where: rule.document.where }),
            sourceRoleId: rule.sourceRoleId,
            inherited: rule.inherited,
            depth: rule.depth,
            sourceCount: rule.document.sources.length,
        })),
    };
    const snapshotBytes = canonicalByteLength(completeSnapshot);
    if (enforceLimits && includedRoles.length > MAX_EFFECTIVE_ROLES) {
        roleLimit(includedRoles.length);
    }
    if (enforceLimits && rules.length > MAX_EFFECTIVE_RULES) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The effective rule expansion exceeds its limit.", {
            details: { kind: "limit-exceeded", origin: "persisted-authorization-state", limitName: "effective-rules", current: rules.length, max: MAX_EFFECTIVE_RULES, unit: "items" },
        });
    }
    if (enforceLimits && sourceRefs > MAX_EFFECTIVE_SOURCES) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The effective source expansion exceeds its limit.", {
            details: { kind: "limit-exceeded", origin: "persisted-authorization-state", limitName: "effective-sources", current: sourceRefs, max: MAX_EFFECTIVE_SOURCES, unit: "items" },
        });
    }
    if (enforceLimits && snapshotBytes > MAX_EFFECTIVE_SNAPSHOT_BYTES) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The effective authorization snapshot exceeds its byte limit.", {
            details: { kind: "limit-exceeded", origin: "persisted-authorization-state", limitName: "effective-snapshot-bytes", current: snapshotBytes, max: MAX_EFFECTIVE_SNAPSHOT_BYTES, unit: "bytes" },
        });
    }
    return deepFreeze({
        effectiveRoles: includedRoles.length,
        semanticRules: rules.length,
        sourceRefs,
        snapshotBytes,
    });
}

export async function loadEffectiveAuthorization(
    reader: EffectiveAuthorizationReader,
    userRoleSet: InternalUserRoleSetView,
    options: EffectiveAuthorizationLoadOptions = {},
): Promise<EffectiveAuthorizationState> {
    const hierarchy = await loadEffectiveRoleHierarchy(reader, userRoleSet, options.overlay);
    const roles = hierarchy.roles;
    const includedRoleIds = roles.filter((role) => role.included).map((role) => role.document.roleId);
    const resolved = reader.resolveRulesForAuthorization === undefined
        ? { rules: await reader.readRulesForRoles(includedRoleIds), sourceViews: new Map<string, RuleSourceView>() }
        : await reader.resolveRulesForAuthorization(includedRoleIds);
    const persistedRules = resolved.rules;
    const replacedRoleIds = new Set(options.overlay?.rulesByRoleId?.keys() ?? []);
    const ruleDocuments = [
        ...persistedRules.filter((rule) => !replacedRoleIds.has(rule.roleId)),
        ...includedRoleIds.flatMap((roleId) => options.overlay?.rulesByRoleId?.get(roleId) ?? []),
    ];
    const rules = collectEffectiveRuleStates(ruleDocuments, roles);
    return deepFreeze({
        direct: userRoleSet,
        roles,
        rules,
        sourceViews: resolved.sourceViews,
        usage: measureUsage(roles, rules, options.enforceLimits !== false),
    });
}

export async function loadRoleAuthorization(reader: RbacScopeReader, roleId: string) {
    const hierarchy = await loadRoleHierarchy(reader, roleId);
    const { requested, roles } = hierarchy;
    const includedRoleIds = roles.filter((role) => role.included).map((role) => role.document.roleId);
    const resolved = await reader.resolveRulesForAuthorization(includedRoleIds);
    const rules = collectEffectiveRuleStates(resolved.rules, roles);
    measureUsage(roles, rules, true);
    return deepFreeze({ requested, roles, rules, sourceViews: resolved.sourceViews });
}

export async function loadRoleManagementAuthorization(reader: RbacScopeReader, roleId: string) {
    const hierarchy = await loadRoleHierarchy(reader, roleId);
    const includedRoleIds = hierarchy.roles
        .filter((role) => role.included)
        .map((role) => role.document.roleId);
    const persistedRules = await reader.readRulesForRoles(includedRoleIds);
    const resolved = await reader.resolveRulesForManagement(includedRoleIds, persistedRules);
    const rules = collectEffectiveRuleStates(persistedRules, hierarchy.roles);
    measureUsage(hierarchy.roles, rules, true);
    return deepFreeze({ ...hierarchy, rules, sourceViews: resolved.sourceViews });
}

function managementConflictEntries(rules: readonly EffectiveRuleState[]) {
    const groups = new Map<string, {
        action: string;
        resource: string;
        conditional: boolean;
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
            conditional: rule.document.where !== undefined,
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

export function roleChainView(roles: readonly EffectiveRoleState[]): readonly RoleChainEntry[] {
    return deepFreeze([...roles]
        .sort((left, right) => left.depth - right.depth)
        .map((entry) => ({
            role: roleSnapshot(entry.document),
            depth: entry.depth,
            included: entry.included,
            ...(entry.excludedReason === undefined ? {} : { excludedReason: entry.excludedReason }),
        })));
}

export function effectiveRoleRulesView(
    requested: Readonly<InternalRoleDocument>,
    roles: readonly EffectiveRoleState[],
    rules: readonly EffectiveRuleState[],
    sourceViews: ReadonlyMap<string, RuleSourceView> = new Map(),
) {
    const budget = new DetailBudgetAllocator();
    const completeRuleEntries: EffectiveRuleEntry[] = rules.map((rule) => deepFreeze({
        ...completePermissionRuleView(rule.document, sourceViews),
        sourceRoleId: rule.sourceRoleId,
        inherited: rule.inherited,
        depth: rule.depth,
    }));
    const ruleEntries: EffectiveRuleEntry[] = rules.map((rule) => deepFreeze({
        ...permissionRuleView(rule.document, sourceViews, budget),
        sourceRoleId: rule.sourceRoleId,
        inherited: rule.inherited,
        depth: rule.depth,
    }));
    const conflictEntries = managementConflictEntries(rules);
    const completeConflicts: RuleConflict[] = conflictEntries.map((conflict) => deepFreeze({
        action: conflict.action,
        resource: conflict.resource,
        allowSemanticKeys: completeDetails([...new Set(conflict.allows)].sort(compareUtf8)),
        denySemanticKeys: completeDetails([...new Set(conflict.denies)].sort(compareUtf8)),
        resolution: "deny" as const,
    }));
    const publicConflicts: RuleConflict[] = conflictEntries.map((conflict) => deepFreeze({
        action: conflict.action,
        resource: conflict.resource,
        allowSemanticKeys: budget.bounded([...new Set(conflict.allows)].sort(compareUtf8)),
        denySemanticKeys: budget.bounded([...new Set(conflict.denies)].sort(compareUtf8)),
        resolution: "deny" as const,
    }));
    const result: EffectiveRoleRules = deepFreeze({
        role: roleSnapshot(requested),
        chain: roleChainView(roles),
        rules: budget.bounded(ruleEntries),
        conflicts: budget.bounded(publicConflicts),
    });
    const detailBudget = budget.finish({ rules: completeRuleEntries, conflicts: completeConflicts });
    assertAuthorizationResponseBudget({ result, detailBudget });
    return { result, detailBudget };
}

export function userEffectiveRolesView(state: Pick<EffectiveAuthorizationState, "direct" | "roles">) {
    const budget = new DetailBudgetAllocator();
    const entries: EffectiveUserRoleEntry[] = state.roles.map((entry) => deepFreeze({
        role: roleSnapshot(entry.document),
        direct: entry.direct,
        viaRoleIds: [...entry.viaRoleIds],
        depth: entry.depth,
        included: entry.included,
        ...(entry.excludedReason === undefined ? {} : { excludedReason: entry.excludedReason }),
    }));
    const result: UserEffectiveRoles = deepFreeze({
        userId: state.direct.userId,
        direct: userRoleBindingView(state.direct),
        effective: budget.bounded(entries),
    });
    const detailBudget = budget.finish({ effective: entries });
    assertAuthorizationResponseBudget({ result, detailBudget });
    return { result, detailBudget };
}

export function subjectPermissionSnapshot(
    scope: Readonly<PermissionScope>,
    state: EffectiveAuthorizationState,
) {
    const budget = new DetailBudgetAllocator();
    const roles: SubjectEffectiveRoleEntry[] = state.roles.map((entry) => deepFreeze({
        role: subjectRoleSnapshot(entry.document),
        direct: entry.direct,
        viaRoleIds: [...entry.viaRoleIds],
        depth: entry.depth,
        included: entry.included,
        ...(entry.excludedReason === undefined ? {} : { excludedReason: entry.excludedReason }),
    }));
    const rules: SubjectEffectiveRuleEntry[] = state.rules.map((entry) => deepFreeze({
        effect: entry.document.effect,
        action: entry.document.action,
        resource: entry.document.resource,
        ...(entry.document.where === undefined ? {} : { where: entry.document.where }),
        sourceRoleId: entry.sourceRoleId,
        inherited: entry.inherited,
        depth: entry.depth,
    }));
    const conflictGroups = managementConflictEntries(state.rules);
    const conflicts: SubjectRuleConflict[] = conflictGroups.map((entry) => deepFreeze({
        action: entry.action,
        resource: entry.resource,
        allowCount: entry.allows.length,
        denyCount: entry.denies.length,
        conditional: entry.conditional,
        resolution: "deny" as const,
    }));
    const snapshot: EffectivePermissionSnapshot = deepFreeze({
        subject: { userId: state.direct.userId, scope: { ...scope } },
        directRoleIds: [...state.direct.roleIds],
        roles: budget.bounded(roles),
        rules: budget.bounded(rules),
        conflicts: budget.bounded(conflicts),
    });
    const detailBudget = budget.finish({ roles, rules, conflicts });
    assertAuthorizationResponseBudget({ snapshot, detailBudget });
    return { snapshot, detailBudget };
}
