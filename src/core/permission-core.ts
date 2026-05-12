import type { CacheLike } from "cache-hub";

import { Checker } from "../check/checker";
import { PermissionCache } from "../cache";
import type { CacheOptions } from "../types";
import { PermissionCoreError, PermissionCoreErrorCode } from "./errors";
import { RoleManager, UserRoleManager } from "../rbac";
import { MemoryAdapter, type StorageAdapter } from "../storage";
import { isCacheLike } from "../utils/validation";

import { PermissionCoreContext } from "./context";

export interface PermissionCoreOptions {
    storage?: StorageAdapter;
    cache?: CacheLike | CacheOptions;
    strict?: boolean;
}

// PermissionCore 负责把存储、缓存、规则管理和鉴权能力组合成稳定的对外入口。
export class PermissionCore {
    private readonly storage: StorageAdapter;
    private readonly cache: PermissionCache;
    private readonly checker: Checker;
    private initialized = false;

    readonly roles: RoleManager;
    readonly users: UserRoleManager;

    constructor(options: PermissionCoreOptions = {}) {
        // 默认走 MemoryAdapter，方便文档示例、单测和最小接入直接启动。
        this.storage = options.storage ?? new MemoryAdapter();
        this.cache = new PermissionCache(this.normalizeCacheOptions(options.cache));
        this.checker = new Checker(this.storage, this.cache, options.strict ?? true);
        this.roles = new RoleManager(this.storage, this.cache, () => this.checkInitialized());
        this.users = new UserRoleManager(this.storage, this.cache, () => this.checkInitialized());
    }

    async init(): Promise<void> {
        await this.storage.init();
        this.initialized = true;
    }

    async close(): Promise<void> {
        await this.storage.close();
        this.initialized = false;
    }

    async can(userId: string, action: string, resource: string) {
        this.checkInitialized();
        return this.checker.can(userId, action, resource);
    }

    async cannot(userId: string, action: string, resource: string) {
        this.checkInitialized();
        return this.checker.cannot(userId, action, resource);
    }

    async assert(userId: string, action: string, resource: string) {
        this.checkInitialized();
        return this.checker.assert(userId, action, resource);
    }

    async getRowScope(
        userId: string,
        action: string,
        resource: string,
        context?: Record<string, unknown>,
    ) {
        this.checkInitialized();
        return this.checker.getRowScope(userId, action, resource, context);
    }

    async canRow(
        userId: string,
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        this.checkInitialized();
        return this.checker.canRow(userId, action, resource, row, context);
    }

    async cannotRow(
        userId: string,
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        this.checkInitialized();
        return this.checker.cannotRow(userId, action, resource, row, context);
    }

    async assertRow(
        userId: string,
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        this.checkInitialized();
        return this.checker.assertRow(userId, action, resource, row, context);
    }

    async filterRows<T extends Record<string, unknown>>(
        userId: string,
        action: string,
        resource: string,
        rows: T[],
        context?: Record<string, unknown>,
    ) {
        this.checkInitialized();
        return this.checker.filterRows(userId, action, resource, rows, context);
    }

    async filterFields<T extends Record<string, unknown>>(
        userId: string,
        action: string,
        resource: string,
        data: T,
        context?: Record<string, unknown>,
    ) {
        this.checkInitialized();
        return this.checker.filterFields(userId, action, resource, data, context);
    }

    async getPermissions(userId: string) {
        this.checkInitialized();
        return this.checker.getPermissions(userId);
    }

    async getResources(userId: string, action?: string) {
        this.checkInitialized();
        return this.checker.getResources(userId, action);
    }

    for(userId: string) {
        this.checkInitialized();
        return new PermissionCoreContext(this.checker, userId);
    }

    async invalidate(userId: string): Promise<void> {
        this.checkInitialized();
        await this.cache.invalidate(userId);
    }

    async invalidateAll(): Promise<void> {
        this.checkInitialized();
        await this.cache.invalidateAll();
    }

    private checkInitialized() {
        if (!this.initialized) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.NOT_INITIALIZED,
                "Must call await pc.init() before using any API",
            );
        }
    }

    private normalizeCacheOptions(cache: CacheLike | CacheOptions | undefined) {
        // 允许用户直接传 cache-hub 兼容实例，也允许继续传轻量配置对象。
        if (isCacheLike(cache)) {
            return { cache };
        }

        return cache ?? {};
    }
}