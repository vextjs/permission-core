import type {
    MutationOptions,
    MutationResult,
    PermissionScope,
    PolicyValue,
    RequiredRevisionOptions,
    Role,
    RoleAccessUpdateInput,
    RoleCreateInput,
    RoleUpdateInput,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalString, digestCanonical } from "../internal/canonical";
import { assertInternalDocumentBudget, type InternalRoleDocument } from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import {
    normalizeRoleCreateInput,
    normalizeRoleAccessUpdateInput,
    normalizeRoleUpdateInput,
} from "./inputs";
import {
    normalizeMutationOptions,
    normalizeRequiredRevisionOptions,
    RbacMutationExecutor,
    type CacheInvalidator,
    type MutationWorkContext,
    type NormalizedMutationOptions,
} from "./mutation-executor";
import { MAX_ROLE_CHAIN_DEPTH } from "./store";
import { decodeRemovedRoleReplay, decodeRoleReplay, roleView } from "./views";
import { normalizeRbacId } from "./validation";

function insertOptions(session: unknown) {
    return { session, cache: { invalidate: false as const } };
}

function writeOptions(session: unknown) {
    return { session, collation: SIMPLE_COLLATION, cache: { invalidate: false as const } };
}

function readOptions(session: unknown) {
    return { session, cache: 0, collation: SIMPLE_COLLATION, projection: { _id: 1 } };
}

function revisionConflict(owner: string, expected: number, current?: number): never {
    throw new PermissionCoreError("REVISION_CONFLICT", `${owner} revision changed.`, {
        details: { kind: "revision-conflict", owner, expected, ...(current === undefined ? {} : { current }) },
    });
}

function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The RBAC write result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function isRoleIdentityDuplicate(error: unknown) {
    let current = error;
    for (let depth = 0; depth < 6; depth += 1) {
        if (current !== null && typeof current === "object") {
            const record = current as Record<string, unknown>;
            if (
                record.code === 11000
                && /pc_roles_scope_role_uq|_roles/iu.test(String(record.message ?? ""))
            ) {
                return true;
            }
            current = record.cause;
        } else {
            break;
        }
    }
    return false;
}

async function assertParentChain(
    reader: Parameters<Parameters<RbacMutationExecutor["execute"]>[0]["work"]>[0]["reader"],
    roleId: string,
    parentId: string | null,
) {
    if (parentId === null) {
        return;
    }
    const seen = new Set([roleId]);
    let currentId: string | null = parentId;
    let totalRoles = 1;
    let first = true;
    while (currentId !== null) {
        if (seen.has(currentId)) {
            throw new PermissionCoreError("CIRCULAR_INHERITANCE", "The role parent chain contains a cycle.");
        }
        seen.add(currentId);
        totalRoles += 1;
        if (totalRoles > MAX_ROLE_CHAIN_DEPTH) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "The role parent chain exceeds its depth limit.", {
                details: {
                    kind: "limit-exceeded",
                    origin: "caller-input",
                    limitName: "role-chain-depth",
                    current: totalRoles,
                    max: MAX_ROLE_CHAIN_DEPTH,
                    unit: "depth",
                },
            });
        }
        const role = await reader.readRole(currentId);
        if (role === null) {
            if (first) {
                throw new PermissionCoreError("ROLE_NOT_FOUND", `Parent role ${currentId} was not found.`);
            }
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", "A role parent reference is missing.", {
                details: { kind: "persisted-state-invalid", stage: "load", reason: "role-parent-missing" },
            });
        }
        currentId = role.parentId;
        first = false;
    }
}

export class RoleMutationService {
    private readonly executor: RbacMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        resourceSchemes: ResourceSchemeRegistry,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new RbacMutationExecutor(repository, resourceSchemes, invalidateCache);
    }

    async create(
        scope: PermissionScope,
        input: RoleCreateInput,
        options?: MutationOptions,
    ): Promise<MutationResult<Role>> {
        const role = normalizeRoleCreateInput(input);
        const normalizedOptions = normalizeMutationOptions(options);
        try {
            return await this.executor.execute({
                scope,
                operation: "roles.create",
                action: "create",
                resource: `role:${role.id}`,
                request: { role },
                options: normalizedOptions,
                decodeReplay: decodeRoleReplay,
                work: async ({ transaction, reader, now }) => {
                    if (await reader.readRole(role.id)) {
                        throw new PermissionCoreError("ROLE_ALREADY_EXISTS", `Role ${role.id} already exists.`);
                    }
                    await assertParentChain(reader, role.id, role.parentId);
                    const document: InternalRoleDocument = {
                        scopeKey: reader.state.scopeKey,
                        scope: reader.state.scope,
                        roleId: role.id,
                        label: role.label,
                        ...(role.description === undefined ? {} : { description: role.description }),
                        status: role.status,
                        parentId: role.parentId,
                        revision: 1,
                        menuGrantCount: 0,
                        menuGrantDigest: digestCanonical([]),
                        menuSourceCount: 0,
                        menuSourceDigest: digestCanonical([]),
                        createdAt: now,
                        updatedAt: now,
                    };
                    assertInternalDocumentBudget(document);
                    const result = await this.repository.collections.roles.insertOne(
                        { ...document },
                        insertOptions(transaction.session),
                    );
                    if (result.acknowledged !== true) {
                        databaseWriteFailure("role insert was not acknowledged");
                    }
                    const postImage = await reader.requireRole(role.id);
                    if (canonicalString(postImage) !== canonicalString(document)) {
                        databaseWriteFailure("role insert post-image differs from the validated document");
                    }
                    const data = roleView(postImage);
                    return {
                        changed: true,
                        data,
                        primaryRevision: 1,
                        entity: { kind: "role", id: role.id, before: 0, after: 1 },
                        change: { kind: "role", before: null, after: data },
                        cacheTargets: [`scope:${reader.state.scopeKey}:rbac`],
                    };
                },
            });
        } catch (error) {
            if (isRoleIdentityDuplicate(error)) {
                throw new PermissionCoreError("ROLE_ALREADY_EXISTS", `Role ${role.id} already exists.`, { cause: error });
            }
            throw error;
        }
    }

    async update(
        scope: PermissionScope,
        roleIdInput: string,
        patchInput: RoleUpdateInput,
        optionsInput: RequiredRevisionOptions,
    ): Promise<MutationResult<Role>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const patch = normalizeRoleUpdateInput(patchInput);
        const options = normalizeRequiredRevisionOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: "roles.update",
            action: "update",
            resource: `role:${roleId}`,
            request: { roleId, patch, expectedRevision: options.expectedRevision },
            options,
            decodeReplay: decodeRoleReplay,
            work: async ({ transaction, reader, now }) => {
                const current = await reader.requireRole(roleId);
                if (current.revision !== options.expectedRevision) {
                    revisionConflict(`role:${roleId}`, options.expectedRevision, current.revision);
                }
                if (current.status === "deprecated") {
                    throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated roles cannot be edited.", {
                        details: { kind: "validation", field: "roleId", reason: "role is deprecated" },
                    });
                }
                const nextDescription = Object.hasOwn(patch, "description")
                    ? (patch.description === null ? undefined : patch.description)
                    : current.description;
                const nextLabel = patch.label ?? current.label;
                const changed = nextLabel !== current.label || nextDescription !== current.description;
                if (!changed) {
                    const data = roleView(current);
                    return {
                        changed: false,
                        data,
                        primaryRevision: current.revision,
                        entity: { kind: "role", id: roleId, before: current.revision, after: current.revision },
                        change: { kind: "role-metadata", before: data, after: data },
                        cacheTargets: [],
                    };
                }
                const next: InternalRoleDocument = {
                    ...current,
                    label: nextLabel,
                    ...(nextDescription === undefined ? {} : { description: nextDescription }),
                    revision: current.revision + 1,
                    updatedAt: now,
                };
                if (nextDescription === undefined) {
                    delete (next as { description?: string }).description;
                }
                assertInternalDocumentBudget(next);
                const update = {
                    $set: {
                        label: nextLabel,
                        revision: next.revision,
                        updatedAt: now,
                        ...(nextDescription === undefined ? {} : { description: nextDescription }),
                    },
                    ...(nextDescription === undefined && current.description !== undefined
                        ? { $unset: { description: "" } }
                        : {}),
                };
                const result = await this.repository.collections.roles.updateOne(
                    { scopeKey: reader.state.scopeKey, roleId, revision: current.revision },
                    update,
                    writeOptions(transaction.session),
                );
                if (result.matchedCount !== 1) {
                    revisionConflict(`role:${roleId}`, current.revision);
                }
                if (result.modifiedCount !== 1) {
                    databaseWriteFailure("changed role update did not modify exactly one document");
                }
                const postImage = await reader.requireRole(roleId);
                if (canonicalString(postImage) !== canonicalString(next)) {
                    databaseWriteFailure("role update post-image differs from the validated document");
                }
                const before = roleView(current);
                const data = roleView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: { kind: "role", id: roleId, before: current.revision, after: data.revision },
                    change: { kind: "role-metadata", before, after: data },
                    cacheTargets: [`scope:${reader.state.scopeKey}:rbac`],
                };
            },
        });
    }

    async executeAccessUpdate(
        scope: PermissionScope,
        roleIdInput: string,
        patchInput: RoleAccessUpdateInput,
        options: NormalizedMutationOptions,
        request: PolicyValue,
        validate: (
            context: MutationWorkContext,
            current: Readonly<InternalRoleDocument>,
            patch: Readonly<RoleAccessUpdateInput>,
        ) => Promise<{ validatedPlanHash: string; capacity: PolicyValue }>,
    ): Promise<MutationResult<Role>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const patch = normalizeRoleAccessUpdateInput(patchInput);
        return this.executor.execute({
            scope,
            operation: "roles.executeAccessUpdate",
            action: "update",
            resource: `role:${roleId}`,
            request,
            options,
            decodeReplay: decodeRoleReplay,
            work: async (context) => {
                const { transaction, reader, now } = context;
                const current = await reader.requireRole(roleId);
                if (
                    current.status === "deprecated"
                    && (
                        Object.hasOwn(patch, "parentId")
                        || !Object.hasOwn(patch, "status")
                        || patch.status === "deprecated"
                    )
                ) {
                    throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated roles can only be restored by status.", {
                        details: { kind: "validation", field: "patch", reason: "deprecated role requires an explicit recovery status" },
                    });
                }
                const nextStatus = patch.status ?? current.status;
                const nextParentId = Object.hasOwn(patch, "parentId") ? patch.parentId! : current.parentId;
                await assertParentChain(reader, roleId, nextParentId);
                const validation = await validate(context, current, patch);
                const changed = nextStatus !== current.status || nextParentId !== current.parentId;
                if (!changed) {
                    const data = roleView(current);
                    return {
                        changed: false,
                        data,
                        primaryRevision: current.revision,
                        entity: { kind: "role", id: roleId, before: current.revision, after: current.revision },
                        change: { kind: "role-access", before: data, after: data },
                        cacheTargets: [],
                        validatedPlanHash: validation.validatedPlanHash,
                        capacity: validation.capacity,
                    };
                }
                const next: InternalRoleDocument = {
                    ...current,
                    status: nextStatus,
                    parentId: nextParentId,
                    revision: current.revision + 1,
                    updatedAt: now,
                };
                assertInternalDocumentBudget(next);
                const result = await this.repository.collections.roles.updateOne(
                    { scopeKey: reader.state.scopeKey, roleId, revision: current.revision },
                    { $set: { status: nextStatus, parentId: nextParentId, revision: next.revision, updatedAt: now } },
                    writeOptions(transaction.session),
                );
                if (result.matchedCount !== 1) {
                    revisionConflict(`role:${roleId}`, current.revision);
                }
                if (result.modifiedCount !== 1) {
                    databaseWriteFailure("changed role access update did not modify exactly one document");
                }
                const postImage = await reader.requireRole(roleId);
                if (canonicalString(postImage) !== canonicalString(next)) {
                    databaseWriteFailure("role access update post-image differs from the validated document");
                }
                const before = roleView(current);
                const data = roleView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: { kind: "role", id: roleId, before: current.revision, after: data.revision },
                    change: { kind: "role-access", before, after: data },
                    cacheTargets: [`scope:${reader.state.scopeKey}:rbac`],
                    validatedPlanHash: validation.validatedPlanHash,
                    capacity: validation.capacity,
                };
            },
        });
    }

    async remove(
        scope: PermissionScope,
        roleIdInput: string,
        optionsInput: RequiredRevisionOptions,
    ) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const options = normalizeRequiredRevisionOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: "roles.remove",
            action: "remove",
            resource: `role:${roleId}`,
            request: { roleId, expectedRevision: options.expectedRevision },
            options,
            decodeReplay: decodeRemovedRoleReplay,
            work: async ({ transaction, reader }) => {
                const current = await reader.requireRole(roleId);
                if (current.revision !== options.expectedRevision) {
                    revisionConflict(`role:${roleId}`, options.expectedRevision, current.revision);
                }
                if (current.menuGrantCount > 0 || current.menuSourceCount > 0) {
                    throw new PermissionCoreError("ROLE_IN_USE", `Role ${roleId} still has declared menu dependencies.`);
                }
                const session = transaction.session;
                const dependencies = [
                    await this.repository.collections.roles.findOne(
                        { scopeKey: reader.state.scopeKey, parentId: roleId },
                        readOptions(session),
                    ),
                    await this.repository.collections.userRoleSets.findOne(
                        { scopeKey: reader.state.scopeKey, roleIds: roleId },
                        readOptions(session),
                    ),
                    await this.repository.collections.roleRules.findOne(
                        { scopeKey: reader.state.scopeKey, roleId },
                        readOptions(session),
                    ),
                    await this.repository.collections.roleMenuGrants.findOne(
                        { scopeKey: reader.state.scopeKey, roleId },
                        readOptions(session),
                    ),
                ];
                if (dependencies.some((dependency) => dependency !== null)) {
                    throw new PermissionCoreError("ROLE_IN_USE", `Role ${roleId} still has dependent state.`);
                }
                const result = await this.repository.collections.roles.deleteOne(
                    { scopeKey: reader.state.scopeKey, roleId, revision: current.revision },
                    writeOptions(session),
                );
                if (result.deletedCount !== 1) {
                    revisionConflict(`role:${roleId}`, current.revision);
                }
                if (await reader.readRole(roleId)) {
                    databaseWriteFailure("removed role is still visible in the transaction");
                }
                const data = { removedRoleId: roleId };
                return {
                    changed: true,
                    data,
                    primaryRevision: current.revision + 1,
                    entity: {
                        kind: "role",
                        id: roleId,
                        before: current.revision,
                        after: current.revision + 1,
                    },
                    change: { kind: "role", before: roleView(current), after: null },
                    cacheTargets: [`scope:${reader.state.scopeKey}:rbac`],
                };
            },
        });
    }
}
