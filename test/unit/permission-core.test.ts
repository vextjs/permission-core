import { describe, expect, it } from "vitest";

import {
    PermissionCore,
    PermissionCoreErrorCode,
} from "../../src";

describe("PermissionCore", () => {
    it("requires init before using public APIs", async () => {
        const pc = new PermissionCore();

        await expect(pc.can("user-001", "invoke", "GET:/api/orders")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.NOT_INITIALIZED,
        });

        await expect(pc.roles.list()).rejects.toMatchObject({
            code: PermissionCoreErrorCode.NOT_INITIALIZED,
        });
    });

    it("supports inherited rules and write semantics", async () => {
        const pc = new PermissionCore();
        await pc.init();

        await pc.roles.create("viewer", { label: "查看者" });
        await pc.roles.allow("viewer", "invoke", "GET:/api/articles");

        await pc.roles.create("editor", { label: "编辑", parent: "viewer" });
        await pc.roles.allow("editor", "write", "db:articles");
        await pc.users.assign("user-001", "editor");

        await expect(pc.can("user-001", "invoke", "GET:/api/articles")).resolves.toBe(true);
        await expect(pc.can("user-001", "create", "db:articles")).resolves.toBe(true);
        await expect(pc.can("user-001", "update", "db:articles")).resolves.toBe(true);
        await expect(pc.can("user-001", "write", "db:articles")).resolves.toBe(true);
    });

    it("treats request-side write as create and update", async () => {
        const pc = new PermissionCore();
        await pc.init();

        await pc.roles.create("contributor", { label: "投稿者" });
        await pc.roles.allow("contributor", "create", "db:articles");
        await pc.users.assign("user-002", "contributor");

        await expect(pc.can("user-002", "create", "db:articles")).resolves.toBe(true);
        await expect(pc.can("user-002", "write", "db:articles")).resolves.toBe(false);
    });

    it("supports row-level and field-level evaluation", async () => {
        const pc = new PermissionCore();
        await pc.init();

        await pc.roles.create("sales", { label: "销售" });
        await pc.roles.allow("sales", "read", "db:orders", {
            where: {
                field: "ownerId",
                op: "eq",
                valueFrom: "userId",
            },
        });
        await pc.roles.deny("sales", "read", "db:orders", {
            where: {
                field: "status",
                op: "eq",
                value: "archived",
            },
        });
        await pc.roles.allow("sales", "read", "db:orders:id", {
            where: {
                field: "ownerId",
                op: "eq",
                valueFrom: "userId",
            },
        });
        await pc.roles.allow("sales", "read", "db:orders:status", {
            where: {
                field: "ownerId",
                op: "eq",
                valueFrom: "userId",
            },
        });
        await pc.users.assign("user-003", "sales");

        const orders = [
            { id: "o-1", ownerId: "user-003", status: "paid", amount: 100 },
            { id: "o-2", ownerId: "user-999", status: "paid", amount: 90 },
            { id: "o-3", ownerId: "user-003", status: "archived", amount: 80 },
        ];

        await expect(pc.canRow("user-003", "read", "db:orders", orders[0])).resolves.toBe(true);
        await expect(pc.canRow("user-003", "read", "db:orders", orders[1])).resolves.toBe(false);
        await expect(pc.cannotRow("user-003", "read", "db:orders", orders[2])).resolves.toBe(true);

        await expect(pc.filterRows("user-003", "read", "db:orders", orders)).resolves.toEqual([
            orders[0],
        ]);

        await expect(pc.filterFields("user-003", "read", "db:orders", orders[0])).resolves.toEqual({
            id: "o-1",
            status: "paid",
        });
    });

    it("removes direct role bindings when deleting a role", async () => {
        const pc = new PermissionCore();
        await pc.init();

        await pc.roles.create("viewer", { label: "查看者" });
        await pc.users.assign("user-004", "viewer");
        await pc.roles.delete("viewer");

        await expect(pc.users.getUserRoles("user-004")).resolves.toEqual([]);
        await expect(pc.roles.get("viewer")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.ROLE_NOT_FOUND,
        });
    });

    it("validates role existence before overwriting user bindings", async () => {
        const pc = new PermissionCore();
        await pc.init();

        await expect(pc.users.setUserRoles("user-005", ["missing"])).rejects.toMatchObject({
            code: PermissionCoreErrorCode.ROLE_NOT_FOUND,
        });
    });

    it("exposes a chain context for the same runtime", async () => {
        const pc = new PermissionCore();
        await pc.init();

        await pc.roles.create("viewer", { label: "查看者" });
        await pc.roles.allow("viewer", "invoke", "GET:/api/orders");
        await pc.users.assign("user-006", "viewer");

        const ctx = pc.for("user-006");
        await expect(ctx.can("invoke", "GET:/api/orders")).resolves.toBe(true);
        await expect(ctx.getResources()).resolves.toEqual(["GET:/api/orders"]);
    });
});