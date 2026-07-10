import { describe, expect, it, vi } from "vitest";

import { PermissionCache } from "../../src/cache/permission-cache";

function createCacheLike(store = new Map<string, unknown>()) {
    return {
        get: vi.fn(<T = any>(key: string) => store.get(key) as T | undefined),
        set: vi.fn(async (key: string, value: unknown) => {
            store.set(key, value);
        }),
        del: vi.fn(async (key: string) => store.delete(key)),
        exists: vi.fn(async (key: string) => store.has(key)),
        has: vi.fn(async (key: string) => store.has(key)),
        clear: vi.fn(async () => {
            store.clear();
        }),
        getMany: vi.fn(async (keys: string[]) => Object.fromEntries(
            keys
                .filter((key) => store.has(key))
                .map((key) => [key, store.get(key)]),
        )),
        setMany: vi.fn(async (entries: Record<string, unknown>) => {
            Object.entries(entries).forEach(([key, value]) => {
                store.set(key, value);
            });

            return true;
        }),
        delMany: vi.fn(async (keys: string[]) => {
            let deletedCount = 0;

            keys.forEach((key) => {
                if (store.delete(key)) {
                    deletedCount += 1;
                }
            });

            return deletedCount;
        }),
        delPattern: vi.fn(async (pattern: string) => {
            const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
            let deletedCount = 0;

            Array.from(store.keys()).forEach((key) => {
                if (regex.test(key) && store.delete(key)) {
                    deletedCount += 1;
                }
            });

            return deletedCount;
        }),
        keys: vi.fn(async (pattern?: string) => {
            const allKeys = Array.from(store.keys());
            if (!pattern) {
                return allKeys;
            }

            const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
            return allKeys.filter((key) => regex.test(key));
        }),
        destroy: vi.fn(() => undefined),
    };
}

describe("PermissionCache additional branches", () => {
    it("returns independent permission snapshots on cache hits", async () => {
        const cache = new PermissionCache({ ttl: 60_000 });
        await cache.set("user-snapshot", [
            { type: "allow", action: "read", resource: "db:orders" },
        ]);

        const first = await cache.get("user-snapshot");
        expect(first).not.toBeNull();
        first![0].resource = "db:tampered";

        await expect(cache.get("user-snapshot")).resolves.toEqual([
            { type: "allow", action: "read", resource: "db:orders" },
        ]);
    });

    it("skips reads and writes when disabled but still forwards invalidation", async () => {
        const cacheLike = createCacheLike();
        const cache = new PermissionCache({ enabled: false, cache: cacheLike as never });

        await expect(cache.get("user-disabled")).resolves.toBeNull();
        await cache.set("user-disabled", [
            { type: "allow", action: "invoke", resource: "GET:/api/orders" },
        ]);
        await cache.invalidate("user-disabled");
        await cache.invalidateAll();

        expect(cacheLike.get).not.toHaveBeenCalled();
        expect(cacheLike.set).not.toHaveBeenCalled();
        expect(cacheLike.del).toHaveBeenCalledWith("permission-core:rules:tenant:default|app:-|module:-|ns:-:user-disabled");
        expect(cacheLike.delPattern).toHaveBeenCalledWith("permission-core:rules:*");
        expect(cacheLike.clear).not.toHaveBeenCalled();
    });

    it("invalidates only permission-core keys when sharing a cache instance", async () => {
        const store = new Map<string, unknown>([
            ["monsqlize:query:orders", { rows: [] }],
        ]);
        const cacheLike = createCacheLike(store);
        const cache = new PermissionCache({ cache: cacheLike });

        await cache.set("user-shared", [
            { type: "allow", action: "invoke", resource: "GET:/api/orders" },
        ]);
        await cache.invalidateAll();

        expect(store.has("permission-core:rules:tenant:default|app:-|module:-|ns:-:user-shared")).toBe(false);
        expect(store.has("monsqlize:query:orders")).toBe(true);
        expect(cacheLike.delPattern).toHaveBeenCalledWith("permission-core:rules:*");
        expect(cacheLike.clear).not.toHaveBeenCalled();
    });

    it("deletes known permission-core keys for legacy shared caches without pattern deletion", async () => {
        const legacyCache = {
            get: vi.fn(() => undefined),
            set: vi.fn(() => undefined),
            del: vi.fn(() => false),
            clear: vi.fn(() => undefined),
        };
        const cache = new PermissionCache({ cache: legacyCache as never });

        await cache.set("legacy-user", [
            { type: "allow", action: "invoke", resource: "GET:/api/orders" },
        ]);
        await cache.invalidateAll();

        expect(legacyCache.del).toHaveBeenCalledWith("permission-core:rules:tenant:default|app:-|module:-|ns:-:legacy-user");
        expect(legacyCache.clear).not.toHaveBeenCalled();
    });

    it("destroys only caches owned by permission-core", async () => {
        const ownedCache = new PermissionCache({ ttl: 60_000 });
        await ownedCache.set("user-owned", [
            { type: "allow", action: "invoke", resource: "GET:/api/orders" },
        ]);

        const internal = ownedCache as unknown as {
            cache: { getStats(): { entries: number } };
        };
        expect(internal.cache.getStats().entries).toBe(1);
        await ownedCache.close();
        expect(internal.cache.getStats().entries).toBe(0);

        const externalCache = createCacheLike();
        const sharedCache = new PermissionCache({ cache: externalCache });
        await sharedCache.close();
        expect(externalCache.destroy).not.toHaveBeenCalled();
    });
});
