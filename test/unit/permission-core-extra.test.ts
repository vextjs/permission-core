import type { CacheLike } from "cache-hub";
import { describe, expect, it, vi } from "vitest";

import { PermissionCore, PermissionCoreErrorCode } from "../../src";

describe("PermissionCore additional APIs", () => {
    it("supports cache-like instances and exposes remaining public helpers", async () => {
        const store = new Map<string, unknown>();
        const cacheLike: CacheLike = {
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
        };

        const pc = new PermissionCore({ cache: cacheLike });
        await pc.init();

        await pc.roles.create("viewer", { label: "查看者" });
        await pc.roles.allow("viewer", "invoke", "GET:/api/orders");
        await pc.roles.allow("viewer", "read", "db:orders", {
            where: { field: "ownerId", op: "eq", valueFrom: "userId" },
        });
        await pc.users.assign("user-100", "viewer");

        await expect(pc.getPermissions("user-100")).resolves.toEqual([
            { type: "allow", action: "invoke", resource: "GET:/api/orders" },
            {
                type: "allow",
                action: "read",
                resource: "db:orders",
                where: { field: "ownerId", op: "eq", valueFrom: "userId" },
            },
        ]);

        await expect(pc.cannot("user-100", "invoke", "POST:/api/orders")).resolves.toBe(true);
        await expect(pc.assert("user-100", "invoke", "POST:/api/orders")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.PERMISSION_DENIED,
        });
        await expect(pc.assertRow("user-100", "read", "db:orders", { ownerId: "user-100" })).resolves.toBeUndefined();
        await expect(pc.assertRow("user-100", "read", "db:orders", { ownerId: "other" })).rejects.toMatchObject({
            code: PermissionCoreErrorCode.PERMISSION_DENIED,
        });

        await pc.invalidate("user-100");
        await pc.invalidateAll();

        expect(cacheLike.get).toHaveBeenCalled();
        expect(cacheLike.set).toHaveBeenCalled();
        expect(cacheLike.del).toHaveBeenCalled();
        expect(cacheLike.clear).toHaveBeenCalled();

        await pc.close();

        await expect(pc.getPermissions("user-100")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.NOT_INITIALIZED,
        });
    });
});