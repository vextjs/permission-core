import type { PermissionRule, RoleData } from "../types";

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
export class MemoryAdapter extends StorageAdapter {
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
        return new Map(
            Array.from(this.roles.entries(), ([id, role]) => [id, cloneValue(role)]),
        );
    }

    /** 获取单个角色。 */
    async getRole(id: string): Promise<RoleData | null> {
        const role = this.roles.get(id);
        return role ? cloneValue(role) : null;
    }

    /** 写入角色。 */
    async setRole(id: string, roleData: RoleData): Promise<void> {
        this.roles.set(id, cloneValue(roleData));
    }

    /** 删除角色。 */
    async deleteRole(id: string): Promise<void> {
        this.roles.delete(id);
    }

    /** 获取某个用户绑定的角色列表。 */
    async getUserRoles(userId: string): Promise<string[]> {
        return cloneValue(this.userRoles.get(userId) ?? []);
    }

    /** 覆盖写入某个用户的角色列表。 */
    async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
        const nextRoleIds = Array.from(new Set(roleIds));
        const previousRoleIds = this.userRoles.get(userId) ?? [];

        // 同步维护 role -> users 反向索引，保证删除角色时能快速回收直接绑定。
        for (const roleId of previousRoleIds) {
            if (nextRoleIds.includes(roleId)) {
                continue;
            }

            const directUsers = this.roleUsers.get(roleId);
            directUsers?.delete(userId);
            if (directUsers && directUsers.size === 0) {
                this.roleUsers.delete(roleId);
            }
        }

        // 只补新增绑定，避免重复写入同一用户到同一角色集合。
        for (const roleId of nextRoleIds) {
            if (previousRoleIds.includes(roleId)) {
                continue;
            }

            const directUsers = this.roleUsers.get(roleId) ?? new Set<string>();
            directUsers.add(userId);
            this.roleUsers.set(roleId, directUsers);
        }

        this.userRoles.set(userId, cloneValue(nextRoleIds));
    }

    /** 获取某个角色直接绑定的用户列表。 */
    async getUsersByRole(roleId: string): Promise<string[]> {
        const directUsers = this.roleUsers.get(roleId);
        return directUsers ? Array.from(directUsers) : [];
    }

    /** 获取某个角色的规则集合。 */
    async getRules(roleId: string): Promise<PermissionRule[]> {
        return cloneValue(this.rules.get(roleId) ?? []);
    }

    /** 覆盖写入某个角色的规则集合。 */
    async setRules(roleId: string, rules: PermissionRule[]): Promise<void> {
        this.rules.set(roleId, cloneValue(rules));
    }

    /** 删除某个角色的规则集合。 */
    async deleteRules(roleId: string): Promise<void> {
        this.rules.delete(roleId);
    }
}