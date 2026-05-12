import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode, type PermissionRule, type RoleCreateOptions, type RoleData, type RoleUpdateOptions, type RowRuleOptions } from "../types";
import { deduplicateRules } from "../utils";
import { assertNonEmptyString, assertValidAction, assertValidResource, assertValidWhereCondition } from "../utils/validation";
import type { PermissionCache } from "../cache";
import type { StorageAdapter } from "../storage";

function normalizeActions(actions: string | string[]) {
    const values = Array.isArray(actions) ? actions : [actions];
    values.forEach((action) => {
        assertNonEmptyString(action, "action");
        assertValidAction(action);
    });
    return Array.from(new Set(values));
}

function now() {
    return Date.now();
}

function sameWhere(left: PermissionRule["where"], right: PermissionRule["where"]) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

// RoleManager 负责角色元数据和规则集合管理，所有写操作都会同步清缓存。
export class RoleManager {
    constructor(
        private readonly storage: StorageAdapter,
        private readonly cache: PermissionCache,
        private readonly ensureInitialized: () => void,
    ) { }

    async create(id: string, options: RoleCreateOptions): Promise<void> {
        this.ensureInitialized();
        assertNonEmptyString(id, "roleId");
        assertNonEmptyString(options.label, "label");

        if (await this.storage.getRole(id)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.ROLE_ALREADY_EXISTS,
                `Role '${id}' already exists`,
            );
        }

        const parent = options.parent ?? null;
        if (parent) {
            await this.ensureRoleExists(parent);
            await this.assertNoCircularParent(id, parent);
        }

        const timestamp = now();
        const roleData: RoleData = {
            id,
            label: options.label,
            parent,
            description: options.description ?? "",
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        await this.storage.setRole(id, roleData);
        await this.cache.invalidateAll();
    }

    async update(id: string, options: RoleUpdateOptions): Promise<void> {
        this.ensureInitialized();
        const currentRole = await this.get(id);
        const nextParent = options.parent === undefined ? currentRole.parent : options.parent;

        if (nextParent) {
            await this.ensureRoleExists(nextParent);
            await this.assertNoCircularParent(id, nextParent);
        }

        const updatedRole: RoleData = {
            ...currentRole,
            label: options.label ?? currentRole.label,
            parent: nextParent ?? null,
            description: options.description ?? currentRole.description,
            updatedAt: now(),
        };

        await this.storage.setRole(id, updatedRole);
        await this.cache.invalidateAll();
    }

    async delete(id: string): Promise<void> {
        this.ensureInitialized();
        await this.get(id);
        const roles = await this.storage.getRoles();
        // 有子角色时禁止删除，避免把继承链留在半断裂状态。
        const hasChildRole = Array.from(roles.values()).some((role) => role.parent === id);
        if (hasChildRole) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `Cannot delete role '${id}' while child roles still exist`,
            );
        }

        const boundUsers = await this.storage.getUsersByRole(id);
        for (const userId of boundUsers) {
            // 删除角色时一并清理直接绑定，避免用户继续持有无效角色 ID。
            const nextRoleIds = (await this.storage.getUserRoles(userId)).filter((roleId) => roleId !== id);
            await this.storage.setUserRoles(userId, nextRoleIds);
        }

        await this.storage.deleteRules(id);
        await this.storage.deleteRole(id);
        await this.cache.invalidateAll();
    }

    async get(id: string): Promise<RoleData> {
        this.ensureInitialized();
        assertNonEmptyString(id, "roleId");
        const role = await this.storage.getRole(id);
        if (!role) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.ROLE_NOT_FOUND,
                `Role '${id}' was not found`,
            );
        }

        return role;
    }

    async list(): Promise<RoleData[]> {
        this.ensureInitialized();
        const roles = await this.storage.getRoles();
        return Array.from(roles.values());
    }

    async allow(
        roleId: string,
        actions: string | string[],
        resource: string,
        options: RowRuleOptions = {},
    ): Promise<void> {
        this.ensureInitialized();
        await this.addRules("allow", roleId, actions, resource, options);
    }

    async deny(
        roleId: string,
        actions: string | string[],
        resource: string,
        options: RowRuleOptions = {},
    ): Promise<void> {
        this.ensureInitialized();
        await this.addRules("deny", roleId, actions, resource, options);
    }

    async revokeRule(
        roleId: string,
        actions: string | string[],
        resource: string,
        options: RowRuleOptions = {},
    ): Promise<void> {
        this.ensureInitialized();
        await this.get(roleId);
        assertValidResource(resource);
        const normalizedActions = normalizeActions(actions);
        const nextRules = (await this.storage.getRules(roleId)).filter((rule) => {
            const actionMatches = normalizedActions.includes(rule.action);
            const resourceMatches = rule.resource === resource;
            return !(actionMatches && resourceMatches && sameWhere(rule.where, options.where));
        });

        await this.storage.setRules(roleId, nextRules);
        await this.cache.invalidateAll();
    }

    async clearRules(roleId: string): Promise<void> {
        this.ensureInitialized();
        await this.get(roleId);
        await this.storage.deleteRules(roleId);
        await this.cache.invalidateAll();
    }

    async getRules(roleId: string): Promise<PermissionRule[]> {
        this.ensureInitialized();
        await this.get(roleId);
        return this.storage.getRules(roleId);
    }

    private async addRules(
        type: PermissionRule["type"],
        roleId: string,
        actions: string | string[],
        resource: string,
        options: RowRuleOptions,
    ) {
        await this.get(roleId);
        assertValidResource(resource);
        if (options.where) {
            if (!resource.startsWith("db:")) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.INVALID_ARGUMENT,
                    "where can only be used with db resources",
                );
            }
            assertValidWhereCondition(options.where);
        }

        // 规则写入前先做动作归一化，再通过 deduplicateRules 收口重复配置。
        const normalizedActions = normalizeActions(actions);
        const existingRules = await this.storage.getRules(roleId);
        const nextRules = deduplicateRules([
            ...existingRules,
            ...normalizedActions.map((action) => ({
                type,
                action,
                resource,
                where: options.where ? structuredClone(options.where) : undefined,
            })),
        ]);

        await this.storage.setRules(roleId, nextRules);
        await this.cache.invalidateAll();
    }

    private async ensureRoleExists(roleId: string) {
        if (!(await this.storage.getRole(roleId))) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.ROLE_NOT_FOUND,
                `Role '${roleId}' was not found`,
            );
        }
    }

    private async assertNoCircularParent(roleId: string, parentRoleId: string) {
        if (roleId === parentRoleId) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.CIRCULAR_INHERITANCE,
                `Role '${roleId}' cannot inherit from itself`,
            );
        }

        const visited = new Set<string>([roleId]);
        let currentRoleId: string | null = parentRoleId;

        // 顺着父链向上检查，只要再次撞回已访问节点就说明出现环。
        while (currentRoleId) {
            if (visited.has(currentRoleId)) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.CIRCULAR_INHERITANCE,
                    `Circular inheritance detected for role '${roleId}'`,
                );
            }

            visited.add(currentRoleId);
            const currentRole = await this.storage.getRole(currentRoleId);
            currentRoleId = currentRole?.parent ?? null;
        }
    }
}