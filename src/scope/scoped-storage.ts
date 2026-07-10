import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode, type PermissionRule, type PermissionScope, type RoleData } from "../types";
import { StorageAdapter } from "../storage/adapter";

import {
    DEFAULT_PERMISSION_SCOPE,
    getPermissionScopeKey,
    isSamePermissionScope,
    normalizePermissionScope,
} from "./scope";

/**
 * scoped 存储扩展契约。
 *
 * 不直接修改 `StorageAdapter` 的 abstract 方法，避免破坏第三方旧适配器。
 */
export interface ScopedStorageAdapter {
    init(): Promise<void>;
    close(): Promise<void>;

    getScopedRoles(scope: PermissionScope): Promise<Map<string, RoleData>>;
    getScopedRole(scope: PermissionScope, id: string): Promise<RoleData | null>;
    setScopedRole(scope: PermissionScope, id: string, roleData: RoleData): Promise<void>;
    deleteScopedRole(scope: PermissionScope, id: string): Promise<void>;

    getScopedUserRoles(scope: PermissionScope, userId: string): Promise<string[]>;
    setScopedUserRoles(scope: PermissionScope, userId: string, roleIds: string[]): Promise<void>;
    getScopedUsersByRole(scope: PermissionScope, roleId: string): Promise<string[]>;

    getScopedRules(scope: PermissionScope, roleId: string): Promise<PermissionRule[]>;
    setScopedRules(scope: PermissionScope, roleId: string, rules: PermissionRule[]): Promise<void>;
    deleteScopedRules(scope: PermissionScope, roleId: string): Promise<void>;
}

type MaybeScopedStorage = StorageAdapter & Partial<ScopedStorageAdapter>;

/**
 * 判断存储适配器是否原生支持 scoped 方法。
 */
export function isScopedStorageAdapter(storage: StorageAdapter): storage is StorageAdapter & ScopedStorageAdapter {
    const candidate = storage as MaybeScopedStorage;
    return typeof candidate.getScopedRoles === "function"
        && typeof candidate.getScopedRole === "function"
        && typeof candidate.setScopedRole === "function"
        && typeof candidate.deleteScopedRole === "function"
        && typeof candidate.getScopedUserRoles === "function"
        && typeof candidate.setScopedUserRoles === "function"
        && typeof candidate.getScopedUsersByRole === "function"
        && typeof candidate.getScopedRules === "function"
        && typeof candidate.setScopedRules === "function"
        && typeof candidate.deleteScopedRules === "function";
}

/**
 * 把旧 StorageAdapter 包装成只支持 default scope 的 scoped adapter。
 */
export class LegacyScopedStorageAdapter implements ScopedStorageAdapter {
    private readonly defaultScope: PermissionScope;

    constructor(
        private readonly storage: StorageAdapter,
        defaultScope: PermissionScope = DEFAULT_PERMISSION_SCOPE,
    ) {
        this.defaultScope = normalizePermissionScope(defaultScope);
    }

    init(): Promise<void> {
        return this.storage.init();
    }

    close(): Promise<void> {
        return this.storage.close();
    }

    getScopedRoles(scope: PermissionScope): Promise<Map<string, RoleData>> {
        this.assertDefaultScope(scope);
        return this.storage.getRoles();
    }

    getScopedRole(scope: PermissionScope, id: string): Promise<RoleData | null> {
        this.assertDefaultScope(scope);
        return this.storage.getRole(id);
    }

    setScopedRole(scope: PermissionScope, id: string, roleData: RoleData): Promise<void> {
        this.assertDefaultScope(scope);
        return this.storage.setRole(id, roleData);
    }

    deleteScopedRole(scope: PermissionScope, id: string): Promise<void> {
        this.assertDefaultScope(scope);
        return this.storage.deleteRole(id);
    }

    getScopedUserRoles(scope: PermissionScope, userId: string): Promise<string[]> {
        this.assertDefaultScope(scope);
        return this.storage.getUserRoles(userId);
    }

    setScopedUserRoles(scope: PermissionScope, userId: string, roleIds: string[]): Promise<void> {
        this.assertDefaultScope(scope);
        return this.storage.setUserRoles(userId, roleIds);
    }

    getScopedUsersByRole(scope: PermissionScope, roleId: string): Promise<string[]> {
        this.assertDefaultScope(scope);
        return this.storage.getUsersByRole(roleId);
    }

    getScopedRules(scope: PermissionScope, roleId: string): Promise<PermissionRule[]> {
        this.assertDefaultScope(scope);
        return this.storage.getRules(roleId);
    }

    setScopedRules(scope: PermissionScope, roleId: string, rules: PermissionRule[]): Promise<void> {
        this.assertDefaultScope(scope);
        return this.storage.setRules(roleId, rules);
    }

    deleteScopedRules(scope: PermissionScope, roleId: string): Promise<void> {
        this.assertDefaultScope(scope);
        return this.storage.deleteRules(roleId);
    }

    private assertDefaultScope(scope: PermissionScope) {
        const normalizedScope = normalizePermissionScope(scope);
        if (!isSamePermissionScope(normalizedScope, this.defaultScope)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `Storage adapter does not support scope '${getPermissionScopeKey(normalizedScope)}'`,
            );
        }
    }
}

/**
 * 为某个固定 scope 暴露旧 StorageAdapter 形态，让 Checker / RBAC manager 继续复用原接口。
 */
export class ScopedStorageProxy extends StorageAdapter {
    private readonly scope: PermissionScope;

    constructor(
        private readonly storage: ScopedStorageAdapter,
        scope: PermissionScope = DEFAULT_PERMISSION_SCOPE,
    ) {
        super();
        this.scope = normalizePermissionScope(scope);
    }

    init(): Promise<void> {
        return this.storage.init();
    }

    close(): Promise<void> {
        return this.storage.close();
    }

    getRoles(): Promise<Map<string, RoleData>> {
        return this.storage.getScopedRoles(this.scope);
    }

    getRole(id: string): Promise<RoleData | null> {
        return this.storage.getScopedRole(this.scope, id);
    }

    setRole(id: string, roleData: RoleData): Promise<void> {
        return this.storage.setScopedRole(this.scope, id, roleData);
    }

    deleteRole(id: string): Promise<void> {
        return this.storage.deleteScopedRole(this.scope, id);
    }

    getUserRoles(userId: string): Promise<string[]> {
        return this.storage.getScopedUserRoles(this.scope, userId);
    }

    setUserRoles(userId: string, roleIds: string[]): Promise<void> {
        return this.storage.setScopedUserRoles(this.scope, userId, roleIds);
    }

    getUsersByRole(roleId: string): Promise<string[]> {
        return this.storage.getScopedUsersByRole(this.scope, roleId);
    }

    getRules(roleId: string): Promise<PermissionRule[]> {
        return this.storage.getScopedRules(this.scope, roleId);
    }

    setRules(roleId: string, rules: PermissionRule[]): Promise<void> {
        return this.storage.setScopedRules(this.scope, roleId, rules);
    }

    deleteRules(roleId: string): Promise<void> {
        return this.storage.deleteScopedRules(this.scope, roleId);
    }
}

/**
 * 统一把 StorageAdapter 归一成 scoped adapter。
 */
export function toScopedStorageAdapter(
    storage: StorageAdapter,
    defaultScope: PermissionScope = DEFAULT_PERMISSION_SCOPE,
): ScopedStorageAdapter {
    return isScopedStorageAdapter(storage)
        ? storage
        : new LegacyScopedStorageAdapter(storage, defaultScope);
}
