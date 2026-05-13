import { describe, expect, it, vi } from "vitest";

import {
    MemoryAdapter,
    PermissionCache,
    PermissionCoreErrorCode,
    type PermissionRule,
} from "../../../src";
import { Checker } from "../../../src/check/checker";
import { Resolver } from "../../../src/check/resolver";

async function seedRole(
    storage: MemoryAdapter,
    id: string,
    rules: PermissionRule[],
    parent: string | null = null,
) {
    await storage.setRole(id, {
        id,
        label: id,
        parent,
        description: "",
        createdAt: 1,
        updatedAt: 1,
    });
    await storage.setRules(id, rules);
}

describe("Checker", () => {
    it("supports cache hits, non-strict precedence and permission helper APIs", async () => {
        const storage = new MemoryAdapter();
        await storage.init();
        await seedRole(storage, "editor", [
            { type: "allow", action: "invoke", resource: "GET:/dashboard" },
            { type: "deny", action: "invoke", resource: "GET:/dashboard" },
            { type: "allow", action: "create", resource: "db:orders" },
            { type: "allow", action: "update", resource: "db:orders" },
        ]);
        await storage.setUserRoles("user-1", ["editor"]);

        const getUserRolesSpy = vi.spyOn(storage, "getUserRoles");
        const checker = new Checker(storage, new PermissionCache({ ttl: 60_000 }), false);

        await expect(checker.can("user-1", "write", "db:orders")).resolves.toBe(true);
        await expect(checker.cannot("user-1", "invoke", "POST:/dashboard")).resolves.toBe(true);
        await expect(checker.assert("user-1", "invoke", "POST:/dashboard")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.PERMISSION_DENIED,
        });
        await expect(checker.getResources("user-1", "invoke")).resolves.toEqual(["GET:/dashboard"]);
        await expect(checker.getPermissions("user-1")).resolves.toHaveLength(4);
        await expect(checker.getPermissions("user-1")).resolves.toHaveLength(4);

        expect(getUserRolesSpy).toHaveBeenCalledTimes(1);
    });

    it("computes strict row scopes and filters rows and fields", async () => {
        const storage = new MemoryAdapter();
        await storage.init();
        await seedRole(storage, "sales", [
            {
                type: "allow",
                action: "read",
                resource: "db:orders",
                where: { field: "ownerId", op: "eq", valueFrom: "userId" },
            },
            {
                type: "deny",
                action: "read",
                resource: "db:orders",
                where: { field: "status", op: "eq", value: "archived" },
            },
            {
                type: "allow",
                action: "read",
                resource: "db:orders:id",
                where: { field: "ownerId", op: "eq", valueFrom: "userId" },
            },
            {
                type: "allow",
                action: "read",
                resource: "db:orders:status",
                where: { field: "ownerId", op: "eq", valueFrom: "userId" },
            },
        ]);
        await storage.setUserRoles("sales-user", ["sales"]);

        const checker = new Checker(storage, new PermissionCache({ ttl: 60_000 }), true);
        const ownActiveRow = { id: "o-1", ownerId: "sales-user", status: "paid", amount: 100 };
        const foreignRow = { id: "o-2", ownerId: "other", status: "paid", amount: 90 };
        const ownArchivedRow = { id: "o-3", ownerId: "sales-user", status: "archived", amount: 80 };

        await expect(checker.getRowScope("sales-user", "read", "db:orders")).resolves.toMatchObject({
            mode: "conditional",
            include: expect.any(Object),
            exclude: expect.any(Object),
        });
        await expect(checker.canRow("sales-user", "read", "db:orders", ownActiveRow)).resolves.toBe(true);
        await expect(checker.canRow("sales-user", "read", "db:orders", ownActiveRow, { userId: "other-user" })).resolves.toBe(true);
        await expect(checker.canRow("sales-user", "read", "db:orders", foreignRow)).resolves.toBe(false);
        await expect(checker.cannotRow("sales-user", "read", "db:orders", ownArchivedRow)).resolves.toBe(true);
        await expect(checker.assertRow("sales-user", "read", "db:orders", ownActiveRow)).resolves.toBeUndefined();
        await expect(checker.assertRow("sales-user", "read", "db:orders", ownArchivedRow)).rejects.toMatchObject({
            code: PermissionCoreErrorCode.PERMISSION_DENIED,
        });
        await expect(checker.filterRows("sales-user", "read", "db:orders", [ownActiveRow, foreignRow, ownArchivedRow])).resolves.toEqual([
            ownActiveRow,
        ]);
        await expect(checker.filterRows("sales-user", "read", "db:orders", {} as never)).rejects.toMatchObject({
            code: PermissionCoreErrorCode.INVALID_ARGUMENT,
        });
        await expect(checker.filterFields("sales-user", "read", "db:orders", ownActiveRow)).resolves.toEqual({
            id: "o-1",
            status: "paid",
        });
        await expect(checker.filterFields("sales-user", "read", "db:orders", [] as never)).rejects.toMatchObject({
            code: PermissionCoreErrorCode.INVALID_ARGUMENT,
        });
        await expect(checker.canRow("sales-user", "read", "db:orders", [] as never)).rejects.toMatchObject({
            code: PermissionCoreErrorCode.INVALID_ARGUMENT,
        });
    });

    it("handles unconditional allow and deny row scopes and strict resource listing", async () => {
        const storage = new MemoryAdapter();
        await storage.init();
        await seedRole(storage, "reviewer", [
            { type: "allow", action: "read", resource: "db:orders" },
            {
                type: "deny",
                action: "read",
                resource: "db:orders",
                where: { field: "status", op: "eq", value: "archived" },
            },
        ]);
        await seedRole(storage, "blocked", [
            { type: "deny", action: "read", resource: "db:orders" },
        ]);
        await seedRole(storage, "menu", [
            { type: "allow", action: "invoke", resource: "GET:/dashboard" },
            { type: "deny", action: "invoke", resource: "GET:/dashboard" },
        ]);
        await storage.setUserRoles("reviewer-user", ["reviewer"]);
        await storage.setUserRoles("blocked-user", ["blocked"]);
        await storage.setUserRoles("menu-user", ["menu"]);

        const checker = new Checker(storage, new PermissionCache({ ttl: 60_000 }), true);

        await expect(checker.getRowScope("reviewer-user", "read", "db:orders")).resolves.toMatchObject({
            mode: "all",
            exclude: expect.any(Object),
        });
        await expect(checker.canRow("reviewer-user", "read", "db:orders", { status: "paid" })).resolves.toBe(true);
        await expect(checker.canRow("reviewer-user", "read", "db:orders", { status: "archived" })).resolves.toBe(false);
        await expect(checker.getRowScope("blocked-user", "read", "db:orders")).resolves.toEqual({ mode: "none" });
        await expect(checker.canRow("blocked-user", "read", "db:orders", { status: "paid" })).resolves.toBe(false);
        await expect(checker.getResources("menu-user", "invoke")).resolves.toEqual([]);
    });

    it("covers empty include scopes and conditional scopes without include rules", async () => {
        const storage = new MemoryAdapter();
        await storage.init();

        const checker = new Checker(storage, new PermissionCache({ ttl: 60_000 }), true);
        vi.spyOn(checker as never, "can").mockResolvedValue(true);
        vi.spyOn(checker as never, "getRules").mockResolvedValue([]);

        await expect(checker.getRowScope("ghost-user", "read", "db:orders")).resolves.toEqual({ mode: "none" });

        vi.spyOn(checker as never, "getRowScope").mockResolvedValue({ mode: "conditional" });
        await expect(checker.canRow("ghost-user", "read", "db:orders", { id: "o-1" })).resolves.toBe(false);
    });

    it("treats non-strict unconditional allow+deny row scopes as none", async () => {
        const storage = new MemoryAdapter();
        await storage.init();
        await seedRole(storage, "conflicted", [
            { type: "allow", action: "read", resource: "db:orders" },
            { type: "deny", action: "read", resource: "db:orders" },
        ]);
        await storage.setUserRoles("conflicted-user", ["conflicted"]);

        const checker = new Checker(storage, new PermissionCache({ ttl: 60_000 }), false);

        await expect(checker.getRowScope("conflicted-user", "read", "db:orders")).resolves.toEqual({ mode: "none" });
    });
});

describe("Resolver", () => {
    it("resolves role chains, deduplicates shared parents and guards circular inheritance", async () => {
        const storage = new MemoryAdapter();
        await storage.init();
        await seedRole(storage, "base", [
            { type: "allow", action: "read", resource: "db:orders" },
        ]);
        await seedRole(storage, "editor", [
            { type: "deny", action: "delete", resource: "db:orders" },
        ], "base");
        await seedRole(storage, "auditor", [
            { type: "allow", action: "read", resource: "db:orders" },
        ], "base");

        const resolver = new Resolver();

        await expect(resolver.resolveRoleChain("editor", storage)).resolves.toEqual(["editor", "base"]);
        await expect(resolver.mergeRules(["editor", "auditor"], storage, true)).resolves.toEqual([
            { type: "deny", action: "delete", resource: "db:orders" },
            { type: "allow", action: "read", resource: "db:orders" },
        ]);
        await expect(resolver.mergeRules(["editor", "auditor"], storage, false)).resolves.toEqual([
            { type: "deny", action: "delete", resource: "db:orders" },
            { type: "allow", action: "read", resource: "db:orders" },
        ]);

        await seedRole(storage, "cycle-a", [], "cycle-b");
        await seedRole(storage, "cycle-b", [], "cycle-a");

        await expect(resolver.resolveRoleChain("cycle-a", storage)).rejects.toMatchObject({
            code: PermissionCoreErrorCode.CIRCULAR_INHERITANCE,
        });
    });
});