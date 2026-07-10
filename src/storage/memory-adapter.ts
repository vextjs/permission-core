import type { PermissionRule, PermissionScope, RoleData } from "../types";
import { DEFAULT_PERMISSION_SCOPE, getPermissionScopeKey } from "../scope/scope";
import type { ScopedStorageAdapter } from "../scope/scoped-storage";

import { StorageAdapter } from "./adapter";

/**
 * 使用 `structuredClone` 复制值，避免引用逃逸。
 */
function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

/**
 * 纯内存存储适配器。
 *
 * 主要服务于单测、文档示例和最小本地验证，不提供持久化能力。
 */
export class MemoryAdapter extends StorageAdapter implements ScopedStorageAdapter {
    private readonly roles = new Map<string, RoleData>();
    private readonly userRoles = new Map<string, string[]>();
    private readonly rules = new Map<string, PermissionRule[]>();
    private readonly roleUsers = new Map<string, Set<string>>();

    /** 初始化内存适配器。 */
    async init(): Promise<void> { }

    /** 关闭内存适配器。 */
    async close(): Promise<void> { }

    /** 获取全部角色。 */
    async getRoles(): Promise<Map<string, RoleData>> {
        return this.getScopedRoles(DEFAULT_PERMISSION_SCOPE);
    }

    /** 获取 scope 内全部角色。 */
    async getScopedRoles(scope: PermissionScope): Promise<Map<string, RoleData>> {
        const prefix = this.getScopedKeyPrefix(scope);
        return new Map(
            Array.from(this.roles.entries())
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, role]) => [key.slice(prefix.length), cloneValue(role)]),
        );
    }

    /** 获取单个角色。 */
    async getRole(id: string): Promise<RoleData | null> {
        return this.getScopedRole(DEFAULT_PERMISSION_SCOPE, id);
    }

    /** 获取 scope 内单个角色。 */
    async getScopedRole(scope: PermissionScope, id: string): Promise<RoleData | null> {
        const role = this.roles.get(this.getScopedKey(scope, id));
        return role ? cloneValue(role) : null;
    }

    /** 写入角色。 */
    async setRole(id: string, roleData: RoleData): Promise<void> {
        await this.setScopedRole(DEFAULT_PERMISSION_SCOPE, id, roleData);
    }

    /** 写入 scope 内角色。 */
    async setScopedRole(scope: PermissionScope, id: string, roleData: RoleData): Promise<void> {
        this.roles.set(this.getScopedKey(scope, id), cloneValue(roleData));
    }

    /** 删除角色。 */
    async deleteRole(id: string): Promise<void> {
        await this.deleteScopedRole(DEFAULT_PERMISSION_SCOPE, id);
    }

    /** 删除 scope 内角色。 */
    async deleteScopedRole(scope: PermissionScope, id: string): Promise<void> {
        const key = this.getScopedKey(scope, id);
        this.roles.delete(key);
        this.rules.delete(key);
        this.roleUsers.delete(key);
    }

    /** 获取某个用户绑定的角色列表。 */
    async getUserRoles(userId: string): Promise<string[]> {
        return this.getScopedUserRoles(DEFAULT_PERMISSION_SCOPE, userId);
    }

    /** 获取 scope 内某个用户绑定的角色列表。 */
    async getScopedUserRoles(scope: PermissionScope, userId: string): Promise<string[]> {
        return cloneValue(this.userRoles.get(this.getScopedKey(scope, userId)) ?? []);
    }

    /** 覆盖写入某个用户的角色列表。 */
    async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
        await this.setScopedUserRoles(DEFAULT_PERMISSION_SCOPE, userId, roleIds);
    }

    /** 覆盖写入 scope 内某个用户的角色列表。 */
    async setScopedUserRoles(scope: PermissionScope, userId: string, roleIds: string[]): Promise<void> {
        const nextRoleIds = Array.from(new Set(roleIds));
        const userKey = this.getScopedKey(scope, userId);
        const previousRoleIds = this.userRoles.get(userKey) ?? [];

        // 同步维护 role -> users 反向索引，保证删除角色时能快速回收直接绑定。
        for (const roleId of previousRoleIds) {
            if (nextRoleIds.includes(roleId)) {
                continue;
            }

            const roleKey = this.getScopedKey(scope, roleId);
            const directUsers = this.roleUsers.get(roleKey);
            directUsers?.delete(userId);
            if (directUsers && directUsers.size === 0) {
                this.roleUsers.delete(roleKey);
            }
        }

        // 只补新增绑定，避免重复写入同一用户到同一角色集合。
        for (const roleId of nextRoleIds) {
            if (previousRoleIds.includes(roleId)) {
                continue;
            }

            const roleKey = this.getScopedKey(scope, roleId);
            const directUsers = this.roleUsers.get(roleKey) ?? new Set<string>();
            directUsers.add(userId);
            this.roleUsers.set(roleKey, directUsers);
        }

        this.userRoles.set(userKey, cloneValue(nextRoleIds));
    }

    /** 获取某个角色直接绑定的用户列表。 */
    async getUsersByRole(roleId: string): Promise<string[]> {
        return this.getScopedUsersByRole(DEFAULT_PERMISSION_SCOPE, roleId);
    }

    /** 获取 scope 内某个角色直接绑定的用户列表。 */
    async getScopedUsersByRole(scope: PermissionScope, roleId: string): Promise<string[]> {
        const directUsers = this.roleUsers.get(this.getScopedKey(scope, roleId));
        return directUsers ? Array.from(directUsers) : [];
    }

    /** 获取某个角色的规则集合。 */
    async getRules(roleId: string): Promise<PermissionRule[]> {
        return this.getScopedRules(DEFAULT_PERMISSION_SCOPE, roleId);
    }

    /** 获取 scope 内某个角色的规则集合。 */
    async getScopedRules(scope: PermissionScope, roleId: string): Promise<PermissionRule[]> {
        return cloneValue(this.rules.get(this.getScopedKey(scope, roleId)) ?? []);
    }

    /** 覆盖写入某个角色的规则集合。 */
    async setRules(roleId: string, rules: PermissionRule[]): Promise<void> {
        await this.setScopedRules(DEFAULT_PERMISSION_SCOPE, roleId, rules);
    }

    /** 覆盖写入 scope 内某个角色的规则集合。 */
    async setScopedRules(scope: PermissionScope, roleId: string, rules: PermissionRule[]): Promise<void> {
        this.rules.set(this.getScopedKey(scope, roleId), cloneValue(rules));
    }

    /** 删除某个角色的规则集合。 */
    async deleteRules(roleId: string): Promise<void> {
        await this.deleteScopedRules(DEFAULT_PERMISSION_SCOPE, roleId);
    }

    /** 删除 scope 内某个角色的规则集合。 */
    async deleteScopedRules(scope: PermissionScope, roleId: string): Promise<void> {
        this.rules.delete(this.getScopedKey(scope, roleId));
    }

    private getScopedKey(scope: PermissionScope, id: string) {
        return `${this.getScopedKeyPrefix(scope)}${id}`;
    }

    private getScopedKeyPrefix(scope: PermissionScope) {
        return `${getPermissionScopeKey(scope)}::`;
    }

}
