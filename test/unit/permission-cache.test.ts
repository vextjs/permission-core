import { describe, expect, it } from "vitest";

import { PermissionCache } from "../../src/cache/permission-cache";
import type { PermissionRule } from "../../src/types";

const RULES: PermissionRule[] = [
    {
        type: "allow",
        action: "invoke",
        resource: "GET:/api/orders",
    },
];

describe("PermissionCache", () => {
    it("stores and returns cached rules", async () => {
        const cache = new PermissionCache({ ttl: 60_000 });

        await cache.set("user-001", RULES);

        await expect(cache.get("user-001")).resolves.toEqual(RULES);
    });

    it("invalidates a single user cache entry", async () => {
        const cache = new PermissionCache({ ttl: 60_000 });

        await cache.set("user-001", RULES);
        await cache.invalidate("user-001");

        await expect(cache.get("user-001")).resolves.toBeNull();
    });

    it("clears all cache entries", async () => {
        const cache = new PermissionCache({ ttl: 60_000 });

        await cache.set("user-001", RULES);
        await cache.set("user-002", RULES);
        await cache.invalidateAll();

        await expect(cache.get("user-001")).resolves.toBeNull();
        await expect(cache.get("user-002")).resolves.toBeNull();
    });
});