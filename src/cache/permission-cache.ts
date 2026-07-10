import { MemoryCache, type CacheLike } from "cache-hub";

import { DEFAULT_PERMISSION_SCOPE, getPermissionScopeKey } from "../scope/scope";
import type { PermissionRule, PermissionScope } from "../types";

/**
 * PermissionCache 构造参数。
 */
export interface PermissionCacheOptions {
    /** 是否启用缓存。 */
    enabled?: boolean;
    /** 默认 TTL，单位毫秒。 */
    ttl?: number;
    /** 最大缓存条目数。 */
    maxEntries?: number;
    /** 自定义 `cache-hub` 兼容实例。 */
    cache?: CacheLike;
}

const DEFAULT_TTL = 300_000;
const KEY_PREFIX = "permission-core:rules:";

/**
 * 生成用户规则缓存键。
 */
function getScopePrefix(scope: PermissionScope = DEFAULT_PERMISSION_SCOPE) {
    return `${KEY_PREFIX}${getPermissionScopeKey(scope)}:`;
}

function getCacheKey(userId: string, scope: PermissionScope = DEFAULT_PERMISSION_SCOPE) {
    return `${getScopePrefix(scope)}${userId}`;
}

/**
 * 用户规则集合缓存。
 *
 * 这里缓存的是“用户合并后的规则集”，不缓存某一次 `can()` 的最终判定结果。
 */
export class PermissionCache {
    private readonly enabled: boolean;
    private readonly ttl: number;
    private readonly cache: CacheLike;
    private readonly ownsCache: boolean;
    private readonly knownKeys = new Set<string>();

    /**
     * @param options 缓存开关、TTL 和底层缓存实例。
     */
    constructor(options: PermissionCacheOptions = {}) {
        this.enabled = options.enabled ?? true;
        this.ttl = options.ttl ?? DEFAULT_TTL;
        this.ownsCache = options.cache === undefined;
        this.cache = options.cache ??
            new MemoryCache({
                enabled: this.enabled,
                defaultTtl: this.ttl,
                maxEntries: options.maxEntries,
            });
    }

    /**
     * 读取某个用户的已合并规则。
     */
    async get(userId: string, scope: PermissionScope = DEFAULT_PERMISSION_SCOPE): Promise<PermissionRule[] | null> {
        if (!this.enabled) {
            return null;
        }

        const rules = await this.cache.get<PermissionRule[]>(getCacheKey(userId, scope));
        return rules ? structuredClone(rules) : null;
    }

    /**
     * 写入某个用户的已合并规则。
     */
    async set(
        userId: string,
        rules: PermissionRule[],
        scope: PermissionScope = DEFAULT_PERMISSION_SCOPE,
    ): Promise<void> {
        if (!this.enabled) {
            return;
        }

        const key = getCacheKey(userId, scope);
        this.knownKeys.add(key);
        // 缓存前做 structuredClone，避免外部继续修改同一份规则数组。
        await this.cache.set(key, structuredClone(rules), this.ttl);
    }

    /**
     * 失效某个用户的规则缓存。
     */
    async invalidate(userId: string, scope: PermissionScope = DEFAULT_PERMISSION_SCOPE): Promise<void> {
        const key = getCacheKey(userId, scope);
        this.knownKeys.delete(key);
        await this.cache.del(key);
    }

    /**
     * 失效某个 scope 下的全部用户规则缓存。
     */
    async invalidateScope(scope: PermissionScope = DEFAULT_PERMISSION_SCOPE): Promise<void> {
        const prefix = getScopePrefix(scope);
        if (typeof this.cache.delPattern === "function") {
            await this.cache.delPattern(`${prefix}*`);
            for (const key of Array.from(this.knownKeys)) {
                if (key.startsWith(prefix)) {
                    this.knownKeys.delete(key);
                }
            }
            return;
        }

        for (const key of Array.from(this.knownKeys)) {
            if (key.startsWith(prefix)) {
                await this.cache.del(key);
                this.knownKeys.delete(key);
            }
        }
    }

    /**
     * 全量失效所有规则缓存。
     */
    async invalidateAll(): Promise<void> {
        if (typeof this.cache.delPattern === "function") {
            await this.cache.delPattern(`${KEY_PREFIX}*`);
            this.knownKeys.clear();
            return;
        }

        if (this.ownsCache) {
            await this.cache.clear();
            this.knownKeys.clear();
            return;
        }

        for (const key of Array.from(this.knownKeys)) {
            await this.cache.del(key);
            this.knownKeys.delete(key);
        }
    }

    /**
     * 释放由 PermissionCache 自己创建的底层缓存资源。
     */
    async close(): Promise<void> {
        if (!this.ownsCache) {
            return;
        }

        this.cache.destroy?.();
    }
}
