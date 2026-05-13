import { describe, expect, it, vi } from "vitest";

import { PermissionCoreContext } from "../../src/core/context";
import { PermissionCoreError, PermissionCoreErrorCode, isPermissionCoreError } from "../../src/core/errors";
import type { Checker } from "../../src/check/checker";

describe("PermissionCoreContext", () => {
    it("delegates all public methods with the bound userId", async () => {
        const checker = {
            can: vi.fn().mockResolvedValue(true),
            cannot: vi.fn().mockResolvedValue(false),
            assert: vi.fn().mockResolvedValue(undefined),
            getRowScope: vi.fn().mockResolvedValue({ mode: "all" }),
            canRow: vi.fn().mockResolvedValue(true),
            cannotRow: vi.fn().mockResolvedValue(false),
            assertRow: vi.fn().mockResolvedValue(undefined),
            filterRows: vi.fn().mockResolvedValue([{ id: "r-1" }]),
            filterFields: vi.fn().mockResolvedValue({ id: "r-1" }),
            getPermissions: vi.fn().mockResolvedValue([{ type: "allow", action: "read", resource: "db:orders" }]),
            getResources: vi.fn().mockResolvedValue(["GET:/api/orders"]),
        } as unknown as Checker;

        const ctx = new PermissionCoreContext(checker, "user-ctx");
        const row = { id: "r-1" };
        const rows = [row];
        const context = { tenantId: "tenant-1" };

        await expect(ctx.can("invoke", "GET:/api/orders")).resolves.toBe(true);
        await expect(ctx.cannot("invoke", "GET:/api/orders")).resolves.toBe(false);
        await expect(ctx.assert("invoke", "GET:/api/orders")).resolves.toBeUndefined();
        await expect(ctx.getRowScope("read", "db:orders", context)).resolves.toEqual({ mode: "all" });
        await expect(ctx.canRow("read", "db:orders", row, context)).resolves.toBe(true);
        await expect(ctx.cannotRow("read", "db:orders", row, context)).resolves.toBe(false);
        await expect(ctx.assertRow("read", "db:orders", row, context)).resolves.toBeUndefined();
        await expect(ctx.filterRows("read", "db:orders", rows, context)).resolves.toEqual(rows);
        await expect(ctx.filterFields("read", "db:orders", row, context)).resolves.toEqual(row);
        await expect(ctx.getPermissions()).resolves.toEqual([
            { type: "allow", action: "read", resource: "db:orders" },
        ]);
        await expect(ctx.getResources("invoke")).resolves.toEqual(["GET:/api/orders"]);

        expect(checker.can).toHaveBeenCalledWith("user-ctx", "invoke", "GET:/api/orders");
        expect(checker.cannot).toHaveBeenCalledWith("user-ctx", "invoke", "GET:/api/orders");
        expect(checker.assert).toHaveBeenCalledWith("user-ctx", "invoke", "GET:/api/orders");
        expect(checker.getRowScope).toHaveBeenCalledWith("user-ctx", "read", "db:orders", context);
        expect(checker.canRow).toHaveBeenCalledWith("user-ctx", "read", "db:orders", row, context);
        expect(checker.cannotRow).toHaveBeenCalledWith("user-ctx", "read", "db:orders", row, context);
        expect(checker.assertRow).toHaveBeenCalledWith("user-ctx", "read", "db:orders", row, context);
        expect(checker.filterRows).toHaveBeenCalledWith("user-ctx", "read", "db:orders", rows, context);
        expect(checker.filterFields).toHaveBeenCalledWith("user-ctx", "read", "db:orders", row, context);
        expect(checker.getPermissions).toHaveBeenCalledWith("user-ctx");
        expect(checker.getResources).toHaveBeenCalledWith("user-ctx", "invoke");
    });
});

describe("PermissionCoreError", () => {
    it("stores code, message and data and can be type-guarded", () => {
        const error = new PermissionCoreError(
            PermissionCoreErrorCode.PERMISSION_DENIED,
            "denied",
            { resource: "db:orders" },
        );

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("PermissionCoreError");
        expect(error.code).toBe(PermissionCoreErrorCode.PERMISSION_DENIED);
        expect(error.message).toBe("denied");
        expect(error.data).toEqual({ resource: "db:orders" });
        expect(isPermissionCoreError(error)).toBe(true);
        expect(isPermissionCoreError(new Error("plain"))).toBe(false);
        expect(isPermissionCoreError({ code: PermissionCoreErrorCode.PERMISSION_DENIED })).toBe(false);
    });
});