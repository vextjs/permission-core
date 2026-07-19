import type { MongoSession } from "monsqlize";
import type {
    AuthorizationCapacityAssessment,
    CountSample,
    EffectiveCapacityUsage,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { InternalRoleDocument, InternalRoleRuleDocument } from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import {
    loadEffectiveAuthorization,
    type EffectiveAuthorizationReader,
    type EffectiveAuthorizationOverlay,
    type EffectiveAuthorizationState,
} from "./effective";
import { materializeRoleDocument, materializeUserRoleSetDocument, type InternalUserRoleSetView } from "./materialize";
import {
    MAX_EFFECTIVE_ROLES,
    MAX_EFFECTIVE_RULES,
    MAX_EFFECTIVE_SNAPSHOT_BYTES,
    MAX_EFFECTIVE_SOURCES,
    type RbacScopeReader,
} from "./store";

const CAPACITY_EVALUATION_LIMIT = 1_000;
const PREVIEW_ROLE_SCAN_LIMIT = 10_000;

export interface AffectedUsers {
    readonly total: number;
    readonly evaluated: readonly InternalUserRoleSetView[];
    readonly sampleIds: readonly string[];
    readonly digest: string;
}

export interface CapacityAssessmentInput {
    readonly repository: PermissionRepository;
    readonly reader: RbacScopeReader;
    readonly affectedUsers: AffectedUsers;
    readonly overlay: EffectiveAuthorizationOverlay;
    readonly beforeReader?: EffectiveAuthorizationReader;
    readonly afterReader?: EffectiveAuthorizationReader;
    readonly structuralCapacityNonIncreasing: boolean;
    readonly knownCapacityRiskMayBeAcknowledged: boolean;
    readonly accessHint: AuthorizationCapacityAssessment["accessDirection"];
    readonly session?: MongoSession;
}

function readOptions(session?: MongoSession) {
    return { cache: 0, collation: SIMPLE_COLLATION, ...(session === undefined ? {} : { session }) };
}

function assertCount(value: number, owner: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new PermissionCoreError("PERSISTED_STATE_INVALID", "An authorization impact count is malformed.", {
            details: { kind: "persisted-state-invalid", stage: "load", reason: `${owner} count is invalid` },
        });
    }
    return value;
}

function previewRoleLimit(current: number): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", "The role impact scan exceeds its preview budget.", {
        details: {
            kind: "limit-exceeded",
            origin: "preview-budget",
            limitName: "preview-role-scan",
            current,
            max: PREVIEW_ROLE_SCAN_LIMIT,
            unit: "items",
        },
    });
}

async function loadRoleInventory(
    repository: PermissionRepository,
    reader: RbacScopeReader,
    session?: MongoSession,
) {
    const roles = new Map<string, Readonly<InternalRoleDocument>>();
    let after: string | undefined;
    const pageSize = Math.min(repository.findMaxLimit, 200);
    while (true) {
        const filter = after === undefined
            ? { scopeKey: reader.state.scopeKey }
            : { scopeKey: reader.state.scopeKey, roleId: { $gt: after } };
        const rows = await repository.collections.roles.find(filter, readOptions(session))
            .sort({ roleId: 1 })
            .limit(pageSize)
            .toArray();
        if (rows.length === 0) break;
        for (const row of rows) {
            const role = materializeRoleDocument(row, reader.state.scope, reader.state.scopeKey);
            if (after !== undefined && compareUtf8(role.roleId, after) <= 0) {
                throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The role impact scan did not advance.", {
                    details: { kind: "persisted-state-invalid", stage: "load", reason: "role impact order is non-monotonic" },
                });
            }
            after = role.roleId;
            roles.set(role.roleId, role);
            if (roles.size > PREVIEW_ROLE_SCAN_LIMIT) previewRoleLimit(roles.size);
        }
        if (rows.length < pageSize) break;
    }
    return roles;
}

export async function loadAffectedRoleIds(
    repository: PermissionRepository,
    reader: RbacScopeReader,
    rootRoleIds: readonly string[],
    session?: MongoSession,
) {
    const roots = [...new Set(rootRoleIds)].sort(compareUtf8);
    if (roots.length === 0) return deepFreeze([] as string[]);
    const roles = await loadRoleInventory(repository, reader, session);
    for (const roleId of roots) {
        if (!roles.has(roleId)) {
            throw new PermissionCoreError("ROLE_NOT_FOUND", `Role ${roleId} was not found.`);
        }
    }
    const children = new Map<string, string[]>();
    for (const role of roles.values()) {
        if (role.parentId === null) continue;
        if (!roles.has(role.parentId)) {
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The role hierarchy contains a missing parent.", {
                details: { kind: "persisted-state-invalid", stage: "load", reason: `role ${role.roleId} references missing parent ${role.parentId}` },
            });
        }
        const list = children.get(role.parentId) ?? [];
        list.push(role.roleId);
        children.set(role.parentId, list);
    }
    for (const list of children.values()) list.sort(compareUtf8);

    const visited = new Set<string>();
    const active = new Set<string>();
    const visit = (roleId: string) => {
        if (active.has(roleId)) {
            throw new PermissionCoreError("CIRCULAR_INHERITANCE", "The role hierarchy contains a cycle.");
        }
        if (visited.has(roleId)) return;
        active.add(roleId);
        const parentId = roles.get(roleId)?.parentId;
        if (parentId !== null && parentId !== undefined) visit(parentId);
        active.delete(roleId);
        visited.add(roleId);
    };
    for (const roleId of roles.keys()) visit(roleId);

    const affected: string[] = [];
    const seen = new Set(roots);
    const queue = [...roots];
    for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index]!;
        affected.push(current);
        for (const child of children.get(current) ?? []) {
            if (seen.has(child)) continue;
            seen.add(child);
            queue.push(child);
        }
    }
    affected.sort(compareUtf8);
    return deepFreeze(affected);
}

export async function loadRoleDescendantIds(
    repository: PermissionRepository,
    reader: RbacScopeReader,
    roleId: string,
    session?: MongoSession,
) {
    const affected = await loadAffectedRoleIds(repository, reader, [roleId], session);
    return deepFreeze(affected.filter((candidate) => candidate !== roleId));
}

async function loadUserSets(
    repository: PermissionRepository,
    reader: RbacScopeReader,
    roleIds: readonly string[],
    limit: number,
    session?: MongoSession,
) {
    const result: InternalUserRoleSetView[] = [];
    let after: string | undefined;
    const pageSize = Math.min(repository.findMaxLimit, 200, Math.max(1, limit));
    while (result.length < limit) {
        const base = { scopeKey: reader.state.scopeKey, roleIds: { $in: [...roleIds] } };
        const filter = after === undefined ? base : { $and: [base, { userId: { $gt: after } }] };
        const requested = Math.min(pageSize, limit - result.length);
        const rows = await repository.collections.userRoleSets.find(filter, readOptions(session))
            .sort({ userId: 1 })
            .limit(requested)
            .toArray();
        if (rows.length === 0) break;
        for (const row of rows) {
            const set = materializeUserRoleSetDocument(row, reader.state.scope, reader.state.scopeKey);
            if (after !== undefined && compareUtf8(set.userId, after) <= 0) {
                throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The affected-user scan did not advance.", {
                    details: { kind: "persisted-state-invalid", stage: "load", reason: "affected user order is non-monotonic" },
                });
            }
            after = set.userId;
            result.push(set);
        }
        if (rows.length < requested) break;
    }
    return result;
}

export async function loadAffectedUsers(
    repository: PermissionRepository,
    reader: RbacScopeReader,
    roleIds: readonly string[],
    digestOwner: string,
    session?: MongoSession,
): Promise<AffectedUsers> {
    const normalizedRoleIds = [...new Set(roleIds)].sort(compareUtf8);
    const filter = { scopeKey: reader.state.scopeKey, roleIds: { $in: normalizedRoleIds } };
    const total = assertCount(
        await repository.collections.userRoleSets.count(filter, readOptions(session)),
        "affected-users",
    );
    const evaluated = await loadUserSets(
        repository,
        reader,
        normalizedRoleIds,
        Math.min(total, CAPACITY_EVALUATION_LIMIT),
        session,
    );
    if (total <= CAPACITY_EVALUATION_LIMIT && evaluated.length !== total) {
        throw new PermissionCoreError("READ_CONFLICT", "The affected-user count changed during preview.", {
            details: {
                kind: "read-conflict",
                owner: "scope.rbac",
                expected: total,
                current: evaluated.length,
            },
        });
    }
    const sampleIds = evaluated.slice(0, 100).map((entry) => entry.userId);
    return deepFreeze({
        total,
        evaluated,
        sampleIds,
        digest: digestCanonical({
            owner: digestOwner,
            scopeKey: reader.state.scopeKey,
            rbacRevision: reader.state.rbacRevision,
            roleIdsDigest: digestCanonical(normalizedRoleIds),
            total,
        }),
    });
}

export async function loadDirectlyBoundUserSample(
    repository: PermissionRepository,
    reader: RbacScopeReader,
    roleId: string,
    session?: MongoSession,
) {
    const filter = { scopeKey: reader.state.scopeKey, roleIds: roleId };
    const total = assertCount(await repository.collections.userRoleSets.count(filter, readOptions(session)), "direct-users");
    const sets = await loadUserSets(repository, reader, [roleId], Math.min(total, 100), session);
    return deepFreeze({
        total,
        sampleIds: sets.map((entry) => entry.userId),
        digest: digestCanonical({ owner: "direct-users", roleId, rbacRevision: reader.state.rbacRevision, total }),
    });
}

function ruleKey(state: EffectiveAuthorizationState, effect: "allow" | "deny") {
    return new Set(state.rules
        .filter((rule) => rule.document.effect === effect)
        .map((rule) => canonicalString({
            effect,
            action: rule.document.action,
            resource: rule.document.resource,
            where: rule.document.where ?? null,
        })));
}

function hasDifference(left: ReadonlySet<string>, right: ReadonlySet<string>) {
    for (const value of left) if (!right.has(value)) return true;
    return false;
}

function accessDelta(before: EffectiveAuthorizationState, after: EffectiveAuthorizationState) {
    const beforeAllow = ruleKey(before, "allow");
    const afterAllow = ruleKey(after, "allow");
    const beforeDeny = ruleKey(before, "deny");
    const afterDeny = ruleKey(after, "deny");
    return {
        expands: hasDifference(afterAllow, beforeAllow) || hasDifference(beforeDeny, afterDeny),
        restricts: hasDifference(beforeAllow, afterAllow) || hasDifference(afterDeny, beforeDeny),
    };
}

function compareUsage(before: EffectiveCapacityUsage, after: EffectiveCapacityUsage) {
    const keys = ["effectiveRoles", "semanticRules", "sourceRefs", "snapshotBytes"] as const;
    return {
        increases: keys.some((key) => after[key] > before[key]),
        decreases: keys.some((key) => after[key] < before[key]),
    };
}

function maxUsage(left: EffectiveCapacityUsage, right: EffectiveCapacityUsage): EffectiveCapacityUsage {
    return {
        effectiveRoles: Math.max(left.effectiveRoles, right.effectiveRoles),
        semanticRules: Math.max(left.semanticRules, right.semanticRules),
        sourceRefs: Math.max(left.sourceRefs, right.sourceRefs),
        snapshotBytes: Math.max(left.snapshotBytes, right.snapshotBytes),
    };
}

function exceedsLimits(usage: EffectiveCapacityUsage) {
    return usage.effectiveRoles > MAX_EFFECTIVE_ROLES
        || usage.semanticRules > MAX_EFFECTIVE_RULES
        || usage.sourceRefs > MAX_EFFECTIVE_SOURCES
        || usage.snapshotBytes > MAX_EFFECTIVE_SNAPSHOT_BYTES;
}

function accessFlags(hint: AuthorizationCapacityAssessment["accessDirection"]) {
    return {
        expands: hint === "expand" || hint === "mixed",
        restricts: hint === "restrict" || hint === "mixed",
    };
}

function countSample(total: number, sampleIds: readonly string[], digest: string): CountSample {
    return deepFreeze({ total, sampleIds: [...sampleIds], truncated: total > sampleIds.length, digest });
}

function createAssessmentReader(reader: RbacScopeReader): EffectiveAuthorizationReader {
    const roles = new Map<string, Readonly<InternalRoleDocument> | null>();
    const rulesByRoleId = new Map<string, readonly Readonly<InternalRoleRuleDocument>[]>();
    return {
        async readRoles(roleIds) {
            const normalized = [...new Set(roleIds)].sort(compareUtf8);
            const missing = normalized.filter((roleId) => !roles.has(roleId));
            if (missing.length > 0) {
                const loaded = await reader.readRoles(missing);
                for (const roleId of missing) {
                    roles.set(roleId, loaded.get(roleId) ?? null);
                }
            }
            return new Map(normalized.flatMap((roleId) => {
                const role = roles.get(roleId);
                return role === null || role === undefined ? [] : [[roleId, role] as const];
            }));
        },
        async readRulesForRoles(roleIds) {
            const normalized = [...new Set(roleIds)].sort(compareUtf8);
            const missing = normalized.filter((roleId) => !rulesByRoleId.has(roleId));
            if (missing.length > 0) {
                const loaded = await reader.readRulesForRoles(missing);
                const grouped = new Map(missing.map((roleId) => [roleId, [] as Readonly<InternalRoleRuleDocument>[]]));
                for (const rule of loaded) {
                    grouped.get(rule.roleId)?.push(rule);
                }
                for (const roleId of missing) {
                    rulesByRoleId.set(roleId, Object.freeze(grouped.get(roleId) ?? []));
                }
            }
            return Object.freeze(normalized.flatMap((roleId) => rulesByRoleId.get(roleId) ?? []));
        },
    };
}

export async function assessAuthorizationCapacity(
    input: CapacityAssessmentInput,
): Promise<AuthorizationCapacityAssessment> {
    const limits: EffectiveCapacityUsage = deepFreeze({
        effectiveRoles: MAX_EFFECTIVE_ROLES,
        semanticRules: MAX_EFFECTIVE_RULES,
        sourceRefs: MAX_EFFECTIVE_SOURCES,
        snapshotBytes: MAX_EFFECTIVE_SNAPSHOT_BYTES,
    });
    let maximum: EffectiveCapacityUsage = { effectiveRoles: 0, semanticRules: 0, sourceRefs: 0, snapshotBytes: 0 };
    let expands = false;
    let restricts = false;
    let increases = false;
    let decreases = false;
    const violatingUserIds: string[] = [];
    const persistedReader = createAssessmentReader(input.reader);
    const beforeReader = input.beforeReader ?? persistedReader;
    const afterReader = input.afterReader ?? persistedReader;
    for (const user of input.affectedUsers.evaluated) {
        const before = await loadEffectiveAuthorization(beforeReader, user, { enforceLimits: false });
        const after = await loadEffectiveAuthorization(afterReader, user, {
            overlay: input.overlay,
            enforceLimits: false,
        });
        const access = accessDelta(before, after);
        expands ||= access.expands;
        restricts ||= access.restricts;
        const usage = compareUsage(before.usage, after.usage);
        increases ||= usage.increases;
        decreases ||= usage.decreases;
        maximum = maxUsage(maximum, after.usage);
        if (exceedsLimits(after.usage)) violatingUserIds.push(user.userId);
    }
    const evaluatedUsers = input.affectedUsers.evaluated.length;
    const unverifiedUsers = input.affectedUsers.total - evaluatedUsers;
    if (unverifiedUsers > 0) {
        const hinted = accessFlags(input.accessHint);
        expands ||= hinted.expands;
        restricts ||= hinted.restricts;
    }
    const proof: AuthorizationCapacityAssessment["proof"] = unverifiedUsers === 0
        ? "exact"
        : input.structuralCapacityNonIncreasing && !increases
            ? "conservative"
            : "partial";
    const disposition: AuthorizationCapacityAssessment["disposition"] = violatingUserIds.length > 0
        ? input.knownCapacityRiskMayBeAcknowledged ? "ack-required" : "blocked"
        : proof === "partial" ? "ack-required" : "safe";
    const accessDirection: AuthorizationCapacityAssessment["accessDirection"] = expands && restricts
        ? "mixed"
        : expands ? "expand" : restricts ? "restrict" : "none";
    const capacityDirection: AuthorizationCapacityAssessment["capacityDirection"] = increases && decreases
        ? "mixed"
        : increases ? "expanding" : "non-increasing";
    const base = {
        accessDirection,
        capacityDirection,
        proof,
        affectedUsers: countSample(
            input.affectedUsers.total,
            input.affectedUsers.sampleIds,
            input.affectedUsers.digest,
        ),
        evaluatedUsers,
        unverifiedUsers,
        violatingUsers: countSample(
            violatingUserIds.length,
            violatingUserIds.slice(0, 100),
            digestCanonical(violatingUserIds),
        ),
        maxEvaluated: deepFreeze(maximum),
        limits,
        disposition,
    };
    return deepFreeze({ ...base, digest: digestCanonical(base) });
}
