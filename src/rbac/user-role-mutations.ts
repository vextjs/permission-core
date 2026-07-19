import type {
    MutationOptions,
    MutationResult,
    PermissionScope,
    RequiredRevisionOptions,
    UserRoleBindingSet,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalString, digestCanonical } from "../internal/canonical";
import { assertInternalDocumentBudget, type InternalUserRoleSetDocument } from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import { normalizeRoleIdList } from "./inputs";
import type { InternalUserRoleSetView } from "./materialize";
import {
    normalizeMutationOptions,
    normalizeRequiredRevisionOptions,
    RbacMutationExecutor,
    type CacheInvalidator,
} from "./mutation-executor";
import type { RbacScopeReader } from "./store";
import { decodeUserRoleBindingReplay, userRoleBindingView } from "./views";
import { normalizeRbacId } from "./validation";

function insertOptions(session: unknown) {
    return { session, cache: { invalidate: false as const } };
}

function writeOptions(session: unknown) {
    return { session, collation: SIMPLE_COLLATION, cache: { invalidate: false as const } };
}

function revisionConflict(userId: string, expected: number, current?: number): never {
    throw new PermissionCoreError("REVISION_CONFLICT", `User role set ${userId} changed.`, {
        details: {
            kind: "revision-conflict",
            owner: `user-role-set:${userId}`,
            expected,
            ...(current === undefined ? {} : { current }),
        },
    });
}

function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The user role write result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function sameRoleIds(left: readonly string[], right: readonly string[]) {
    return canonicalString(left) === canonicalString(right);
}

function userCacheTarget(scopeKey: string, userId: string) {
    return `scope:${scopeKey}:user:${digestCanonical({ userId })}`;
}

async function assertAssignableRoles(reader: RbacScopeReader, roleIds: readonly string[]) {
    const roles = await reader.readRoles(roleIds);
    for (const roleId of roleIds) {
        const role = roles.get(roleId);
        if (role === undefined) {
            throw new PermissionCoreError("ROLE_NOT_FOUND", `Role ${roleId} was not found.`);
        }
        if (role.status !== "enabled") {
            throw new PermissionCoreError("INVALID_ARGUMENT", `Role ${roleId} cannot be assigned.`, {
                details: {
                    kind: "validation",
                    field: "roleIds",
                    reason: `role ${roleId} is ${role.status}`,
                },
            });
        }
    }
}

async function persistUserRoleSet(
    repository: PermissionRepository,
    reader: RbacScopeReader,
    current: InternalUserRoleSetView,
    roleIds: readonly string[],
    now: number,
    session: unknown,
) {
    const next: InternalUserRoleSetDocument = {
        scopeKey: reader.state.scopeKey,
        scope: reader.state.scope,
        userId: current.userId,
        roleIds: Object.freeze([...roleIds]),
        revision: current.revision + 1,
        createdAt: current.persisted ? current.createdAt! : now,
        updatedAt: now,
    };
    assertInternalDocumentBudget(next);
    if (!current.persisted) {
        const result = await repository.collections.userRoleSets.insertOne(
            { ...next, roleIds: [...next.roleIds] },
            insertOptions(session),
        );
        if (result.acknowledged !== true) {
            databaseWriteFailure("user role set insert was not acknowledged");
        }
    } else {
        const result = await repository.collections.userRoleSets.updateOne(
            {
                scopeKey: reader.state.scopeKey,
                userId: current.userId,
                revision: current.revision,
            },
            {
                $set: {
                    roleIds: [...next.roleIds],
                    revision: next.revision,
                    updatedAt: now,
                },
            },
            writeOptions(session),
        );
        if (result.matchedCount !== 1) {
            revisionConflict(current.userId, current.revision);
        }
        if (result.modifiedCount !== 1) {
            databaseWriteFailure("changed user role set did not modify exactly one document");
        }
    }
    const postImage = await reader.readUserRoleSet(current.userId);
    if (canonicalString(postImage) !== canonicalString({ ...next, persisted: true })) {
        databaseWriteFailure("user role set post-image differs from the validated document");
    }
    return postImage;
}

export class UserRoleMutationService {
    private readonly executor: RbacMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        resourceSchemes: ResourceSchemeRegistry,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new RbacMutationExecutor(repository, resourceSchemes, invalidateCache);
    }

    async assign(
        scope: PermissionScope,
        userIdInput: string,
        roleIdInput: string,
        optionsInput?: MutationOptions,
    ): Promise<MutationResult<UserRoleBindingSet>> {
        const userId = normalizeRbacId(userIdInput, "userId");
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const options = normalizeMutationOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: "userRoles.assign",
            action: "assign",
            resource: `user:${userId}:roles`,
            request: { userId, roleId },
            options,
            decodeReplay: decodeUserRoleBindingReplay,
            work: async ({ transaction, reader, now }) => {
                const current = await reader.readUserRoleSet(userId);
                await assertAssignableRoles(reader, [roleId]);
                const before = userRoleBindingView(current);
                if (current.roleIds.includes(roleId)) {
                    return {
                        changed: false,
                        data: before,
                        primaryRevision: current.revision,
                        entity: {
                            kind: "user-role-set",
                            id: userId,
                            before: current.revision,
                            after: current.revision,
                        },
                        change: { kind: "user-role-set", operation: "assign", roleId, before, after: before },
                        cacheTargets: [],
                    };
                }
                const roleIds = normalizeRoleIdList([...current.roleIds, roleId]);
                const postImage = await persistUserRoleSet(
                    this.repository,
                    reader,
                    current,
                    roleIds,
                    now,
                    transaction.session,
                );
                const data = userRoleBindingView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: {
                        kind: "user-role-set",
                        id: userId,
                        before: current.revision,
                        after: data.revision,
                    },
                    change: { kind: "user-role-set", operation: "assign", roleId, before, after: data },
                    cacheTargets: [userCacheTarget(reader.state.scopeKey, userId)],
                };
            },
        });
    }

    async revoke(
        scope: PermissionScope,
        userIdInput: string,
        roleIdInput: string,
        optionsInput?: MutationOptions,
    ): Promise<MutationResult<UserRoleBindingSet>> {
        const userId = normalizeRbacId(userIdInput, "userId");
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const options = normalizeMutationOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: "userRoles.revoke",
            action: "revoke",
            resource: `user:${userId}:roles`,
            request: { userId, roleId },
            options,
            decodeReplay: decodeUserRoleBindingReplay,
            work: async ({ transaction, reader, now }) => {
                const current = await reader.readUserRoleSet(userId);
                const before = userRoleBindingView(current);
                if (!current.roleIds.includes(roleId)) {
                    return {
                        changed: false,
                        data: before,
                        primaryRevision: current.revision,
                        entity: {
                            kind: "user-role-set",
                            id: userId,
                            before: current.revision,
                            after: current.revision,
                        },
                        change: { kind: "user-role-set", operation: "revoke", roleId, before, after: before },
                        cacheTargets: [],
                    };
                }
                const roleIds = Object.freeze(current.roleIds.filter((candidate) => candidate !== roleId));
                const postImage = await persistUserRoleSet(
                    this.repository,
                    reader,
                    current,
                    roleIds,
                    now,
                    transaction.session,
                );
                const data = userRoleBindingView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: {
                        kind: "user-role-set",
                        id: userId,
                        before: current.revision,
                        after: data.revision,
                    },
                    change: { kind: "user-role-set", operation: "revoke", roleId, before, after: data },
                    cacheTargets: [userCacheTarget(reader.state.scopeKey, userId)],
                };
            },
        });
    }

    async set(
        scope: PermissionScope,
        userIdInput: string,
        roleIdsInput: readonly string[],
        optionsInput: RequiredRevisionOptions,
    ): Promise<MutationResult<UserRoleBindingSet>> {
        const userId = normalizeRbacId(userIdInput, "userId");
        const roleIds = normalizeRoleIdList(roleIdsInput);
        const options = normalizeRequiredRevisionOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: "userRoles.set",
            action: "set",
            resource: `user:${userId}:roles`,
            request: { userId, roleIds, expectedRevision: options.expectedRevision },
            options,
            decodeReplay: decodeUserRoleBindingReplay,
            work: async ({ transaction, reader, now }) => {
                const current = await reader.readUserRoleSet(userId);
                if (current.revision !== options.expectedRevision) {
                    revisionConflict(userId, options.expectedRevision, current.revision);
                }
                await assertAssignableRoles(reader, roleIds);
                const before = userRoleBindingView(current);
                if (sameRoleIds(current.roleIds, roleIds)) {
                    return {
                        changed: false,
                        data: before,
                        primaryRevision: current.revision,
                        entity: {
                            kind: "user-role-set",
                            id: userId,
                            before: current.revision,
                            after: current.revision,
                        },
                        change: { kind: "user-role-set", operation: "set", before, after: before },
                        cacheTargets: [],
                    };
                }
                const postImage = await persistUserRoleSet(
                    this.repository,
                    reader,
                    current,
                    roleIds,
                    now,
                    transaction.session,
                );
                const data = userRoleBindingView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: {
                        kind: "user-role-set",
                        id: userId,
                        before: current.revision,
                        after: data.revision,
                    },
                    change: { kind: "user-role-set", operation: "set", before, after: data },
                    cacheTargets: [userCacheTarget(reader.state.scopeKey, userId)],
                };
            },
        });
    }

    async clear(
        scope: PermissionScope,
        userIdInput: string,
        optionsInput: RequiredRevisionOptions,
    ): Promise<MutationResult<UserRoleBindingSet>> {
        const userId = normalizeRbacId(userIdInput, "userId");
        const options = normalizeRequiredRevisionOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: "userRoles.clear",
            action: "clear",
            resource: `user:${userId}:roles`,
            request: { userId, expectedRevision: options.expectedRevision },
            options,
            decodeReplay: decodeUserRoleBindingReplay,
            work: async ({ transaction, reader, now }) => {
                const current = await reader.readUserRoleSet(userId);
                if (current.revision !== options.expectedRevision) {
                    revisionConflict(userId, options.expectedRevision, current.revision);
                }
                const before = userRoleBindingView(current);
                if (current.roleIds.length === 0) {
                    return {
                        changed: false,
                        data: before,
                        primaryRevision: current.revision,
                        entity: {
                            kind: "user-role-set",
                            id: userId,
                            before: current.revision,
                            after: current.revision,
                        },
                        change: { kind: "user-role-set", operation: "clear", before, after: before },
                        cacheTargets: [],
                    };
                }
                const postImage = await persistUserRoleSet(
                    this.repository,
                    reader,
                    current,
                    Object.freeze([]),
                    now,
                    transaction.session,
                );
                const data = userRoleBindingView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: {
                        kind: "user-role-set",
                        id: userId,
                        before: current.revision,
                        after: data.revision,
                    },
                    change: { kind: "user-role-set", operation: "clear", before, after: data },
                    cacheTargets: [userCacheTarget(reader.state.scopeKey, userId)],
                };
            },
        });
    }
}
