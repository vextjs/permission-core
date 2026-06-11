import type { CacheLike } from "cache-hub";

import { Checker } from "../check/checker";
import { PermissionCache } from "../cache";
import type { CacheOptions } from "../types";
import { PermissionCoreError, PermissionCoreErrorCode } from "./errors";
import { RoleManager, UserRoleManager } from "../rbac";
import { MemoryAdapter, type StorageAdapter } from "../storage";
import { isCacheLike } from "../utils/validation";

import { PermissionCoreContext } from "./context";

/**
 * PermissionCore 构造参数。
 */
export interface PermissionCoreOptions {
    /** 自定义存储适配器；默认使用 {@link MemoryAdapter}。 */
    storage?: StorageAdapter;
    /** 自定义缓存实例或轻量缓存配置。 */
    cache?: CacheLike | CacheOptions;
    /** 是否启用 strict 模式；默认开启。 */
    strict?: boolean;
}

/**
 * permission-core 的统一运行时入口。
 *
 * 它负责把存储、缓存、RBAC 管理器和鉴权执行器组装成稳定的对外 API。
 */
export class PermissionCore {
    private readonly storage: StorageAdapter;
    private readonly cache: PermissionCache;
    private readonly checker: Checker;
    private initialized = false;

    /** 角色管理入口。 */
    readonly roles: RoleManager;
    /** 用户与角色绑定管理入口。 */
    readonly users: UserRoleManager;

    /**
     * @param options 存储、缓存与 strict 模式配置。
     */
    constructor(options: PermissionCoreOptions = {}) {
        // 默认走 MemoryAdapter，方便文档示例、单测和最小接入直接启动。
        this.storage = options.storage ?? new MemoryAdapter();
        this.cache = new PermissionCache(this.normalizeCacheOptions(options.cache));
        this.checker = new Checker(this.storage, this.cache, options.strict ?? true);
        this.roles = new RoleManager(this.storage, this.cache, () => this.checkInitialized());
        this.users = new UserRoleManager(this.storage, this.cache, () => this.checkInitialized());
    }

    /**
     * 初始化底层存储并进入可用状态。
     */
    async init(): Promise<void> {
        await this.storage.init();
        this.initialized = true;
    }

    /**
     * 关闭底层存储并释放运行时资源。
     */
    async close(): Promise<void> {
        try {
            await this.storage.close();
        } finally {
            await this.cache.close();
            this.initialized = false;
        }
    }

    /**
     * 判断某个用户是否拥有指定权限。
     */
    async can(userId: string, action: string, resource: string) {
        this.checkInitialized();
        return this.checker.can(userId, action, resource);
    }

    /**
     * 判断某个用户是否不拥有指定权限。
     */
    async cannot(userId: string, action: string, resource: string) {
        this.checkInitialized();
        return this.checker.cannot(userId, action, resource);
    }

    /**
     * 对某个资源执行断言式鉴权。
     */
    async assert(userId: string, action: string, resource: string) {
        this.checkInitialized();
        return this.checker.assert(userId, action, resource);
    }

    /**
     * 获取某个用户在指定 `db:` 资源上的行级范围。
     */
    async getRowScope(
        userId: string,
        action: string,
        resource: string,
        context?: Record<string, unknown>,
    ) {
        this.checkInitialized();
        return this.checker.getRowScope(userId, action, resource, context);
    }

    /**
     * 判断某个用户是否可以访问指定数据行。
     */
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

    /**
     * 判断某个用户是否不能访问指定数据行。
     */
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

    /**
     * 对指定数据行执行断言式鉴权。
     */
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

    /**
     * 过滤当前用户可见的数据行。
     */
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

    /**
     * 过滤当前用户可见的数据字段。
     */
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

    /**
     * 获取某个用户合并后的全部权限规则。
     */
    async getPermissions(userId: string) {
        this.checkInitialized();
        return this.checker.getPermissions(userId);
    }

    /**
     * 获取某个用户在指定动作维度下可见的资源列表。
     */
    async getResources(userId: string, action?: string) {
        this.checkInitialized();
        return this.checker.getResources(userId, action);
    }

    /**
     * 绑定 `userId` 并返回链式上下文。
     *
     * 上下文只暴露按用户执行的鉴权 API；缓存失效、角色管理和用户绑定管理仍保留在主类实例上。
     */
    for(userId: string) {
        this.checkInitialized();
        return new PermissionCoreContext(this.checker, userId);
    }

    /**
     * 失效某个用户的规则缓存。
     */
    async invalidate(userId: string): Promise<void> {
        this.checkInitialized();
        await this.cache.invalidate(userId);
    }

    /**
     * 全量失效所有规则缓存。
     */
    async invalidateAll(): Promise<void> {
        this.checkInitialized();
        await this.cache.invalidateAll();
    }

    /**
     * 确保当前运行时已完成初始化。
     */
    private checkInitialized() {
        if (!this.initialized) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.NOT_INITIALIZED,
                "Must call await pc.init() before using any API",
            );
        }
    }

    /**
     * 将直接传入的缓存实例归一化成 `PermissionCache` 可消费的配置结构。
     */
    private normalizeCacheOptions(cache: CacheLike | CacheOptions | undefined) {
        // 允许用户直接传 cache-hub 兼容实例，也允许继续传轻量配置对象。
        if (isCacheLike(cache)) {
            return { cache };
        }

        return cache ?? {};
    }
}
