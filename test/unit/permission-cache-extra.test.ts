import { describe, expect, it, vi } from "vitest";

import { PermissionCache } from "../../src/cache/permission-cache";

describe("PermissionCache additional branches", () => {
    it("skips reads and writes when disabled but still forwards invalidation", async () => {
        const cacheLike = {
            get: vi.fn(async () => null),
            set: vi.fn(async () => undefined),
            del: vi.fn(async () => undefined),
            clear: vi.fn(async () => undefined),
        };
        const cache = new PermissionCache({ enabled: false, cache: cacheLike as never });

        await expect(cache.get("user-disabled")).resolves.toBeNull();
        await cache.set("user-disabled", [
            { type: "allow", action: "invoke", resource: "GET:/api/orders" },
        ]);
        await cache.invalidate("user-disabled");
        await cache.invalidateAll();

        expect(cacheLike.get).not.toHaveBeenCalled();
        expect(cacheLike.set).not.toHaveBeenCalled();
        expect(cacheLike.del).toHaveBeenCalledWith("permission-core:rules:user-disabled");
        expect(cacheLike.clear).toHaveBeenCalledTimes(1);
    });
});