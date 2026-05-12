import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode } from "../types";
import { assertNonEmptyString } from "../utils/validation";
import type { PermissionCache } from "../cache";
import type { StorageAdapter } from "../storage";

// UserRoleManager 只处理用户与角色绑定，缓存失效尽量收窄到单个用户。
export class UserRoleManager {
    constructor(
        private readonly storage: StorageAdapter,
        private readonly cache: PermissionCache,
        private readonly ensureInitialized: () => void,
    ) { }

    async assign(userId: string, roleId: string): Promise<void> {
        this.ensureInitialized();
        assertNonEmptyString(userId, "userId");
        assertNonEmptyString(roleId, "roleId");
        await this.ensureRoleExists(roleId);

        const currentRoleIds = await this.storage.getUserRoles(userId);
        if (!currentRoleIds.includes(roleId)) {
            await this.storage.setUserRoles(userId, [...currentRoleIds, roleId]);
        }

        // 绑定变化只影响当前用户，无需全量清缓存。
        await this.cache.invalidate(userId);
    }

    async revoke(userId: string, roleId: string): Promise<void> {
        this.ensureInitialized();
        assertNonEmptyString(userId, "userId");
        assertNonEmptyString(roleId, "roleId");
        const nextRoleIds = (await this.storage.getUserRoles(userId)).filter(
            (currentRoleId) => currentRoleId !== roleId,
        );
        await this.storage.setUserRoles(userId, nextRoleIds);
        await this.cache.invalidate(userId);
    }

    async getUserRoles(userId: string): Promise<string[]> {
        this.ensureInitialized();
        assertNonEmptyString(userId, "userId");
        return this.storage.getUserRoles(userId);
    }

    async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
        this.ensureInitialized();
        assertNonEmptyString(userId, "userId");
        const uniqueRoleIds = Array.from(new Set(roleIds));

        // 覆盖式写入前逐个校验角色存在性，避免用户绑定进入脏状态。
        for (const roleId of uniqueRoleIds) {
            await this.ensureRoleExists(roleId);
        }

        await this.storage.setUserRoles(userId, uniqueRoleIds);
        await this.cache.invalidate(userId);
    }

    async clearUserRoles(userId: string): Promise<void> {
        this.ensureInitialized();
        assertNonEmptyString(userId, "userId");
        await this.storage.setUserRoles(userId, []);
        await this.cache.invalidate(userId);
    }

    private async ensureRoleExists(roleId: string) {
        if (!(await this.storage.getRole(roleId))) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.ROLE_NOT_FOUND,
                `Role '${roleId}' was not found`,
            );
        }
    }
}