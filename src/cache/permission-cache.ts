import { MemoryCache, type CacheLike } from "cache-hub";

import type { PermissionRule } from "../types";

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
function getCacheKey(userId: string) {
    return `${KEY_PREFIX}${userId}`;
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

    /**
     * @param options 缓存开关、TTL 和底层缓存实例。
     */
    constructor(options: PermissionCacheOptions = {}) {
        this.enabled = options.enabled ?? true;
        this.ttl = options.ttl ?? DEFAULT_TTL;
        this.cache =
            options.cache ??
            new MemoryCache({
                enabled: this.enabled,
                defaultTtl: this.ttl,
                maxEntries: options.maxEntries,
            });
    }

    /**
     * 读取某个用户的已合并规则。
     */
    async get(userId: string): Promise<PermissionRule[] | null> {
        if (!this.enabled) {
            return null;
        }

        const rules = await this.cache.get<PermissionRule[]>(getCacheKey(userId));
        return rules ?? null;
    }

    /**
     * 写入某个用户的已合并规则。
     */
    async set(userId: string, rules: PermissionRule[]): Promise<void> {
        if (!this.enabled) {
            return;
        }

        // 缓存前做 structuredClone，避免外部继续修改同一份规则数组。
        await this.cache.set(getCacheKey(userId), structuredClone(rules), this.ttl);
    }

    /**
     * 失效某个用户的规则缓存。
     */
    async invalidate(userId: string): Promise<void> {
        await this.cache.del(getCacheKey(userId));
    }

    /**
     * 全量失效所有规则缓存。
     */
    async invalidateAll(): Promise<void> {
        await this.cache.clear();
    }
}