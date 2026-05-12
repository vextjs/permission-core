import { MemoryCache, type CacheLike } from "cache-hub";

import type { PermissionRule } from "../types";

export interface PermissionCacheOptions {
    enabled?: boolean;
    ttl?: number;
    maxEntries?: number;
    cache?: CacheLike;
}

const DEFAULT_TTL = 300_000;
const KEY_PREFIX = "permission-core:rules:";

function getCacheKey(userId: string) {
    return `${KEY_PREFIX}${userId}`;
}

// PermissionCache 只缓存“用户合并后的规则集”，不缓存最终判定结果。
export class PermissionCache {
    private readonly enabled: boolean;
    private readonly ttl: number;
    private readonly cache: CacheLike;

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

    async get(userId: string): Promise<PermissionRule[] | null> {
        if (!this.enabled) {
            return null;
        }

        const rules = await this.cache.get<PermissionRule[]>(getCacheKey(userId));
        return rules ?? null;
    }

    async set(userId: string, rules: PermissionRule[]): Promise<void> {
        if (!this.enabled) {
            return;
        }

        // 缓存前做 structuredClone，避免外部继续修改同一份规则数组。
        await this.cache.set(getCacheKey(userId), structuredClone(rules), this.ttl);
    }

    async invalidate(userId: string): Promise<void> {
        await this.cache.del(getCacheKey(userId));
    }

    async invalidateAll(): Promise<void> {
        await this.cache.clear();
    }
}