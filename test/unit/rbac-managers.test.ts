import { describe, expect, it, vi } from "vitest";

import {
    MemoryAdapter,
    PermissionCoreErrorCode,
    RoleManager,
    UserRoleManager,
} from "../../src";

async function createRoleRecord(storage: MemoryAdapter, id: string, parent: string | null = null) {
    await storage.setRole(id, {
        id,
        label: id,
        parent,
        description: "",
        createdAt: 1,
        updatedAt: 1,
    });
}

describe("RoleManager", () => {
    it("covers create, update, rule maintenance and delete flows", async () => {
        const storage = new MemoryAdapter();
        await storage.init();
        const cache = {
            invalidateAll: vi.fn(async () => undefined),
        };
        const roles = new RoleManager(storage, cache as never, () => undefined);

        await roles.create("viewer", { label: "查看者" });
        await roles.create("editor", { label: "编辑", parent: "viewer" });
        await expect(roles.create("viewer", { label: "重复" })).rejects.toMatchObject({
            code: PermissionCoreErrorCode.ROLE_ALREADY_EXISTS,
        });
        await expect(roles.create("ghost", { label: "缺失父角色", parent: "missing" })).rejects.toMatchObject({
            code: PermissionCoreErrorCode.ROLE_NOT_FOUND,
        });

        await expect(roles.delete("viewer")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.INVALID_ARGUMENT,
            message: expect.stringContaining("editor"),
        });

        await roles.update("editor", { label: "编辑者", description: "可以改内容", parent: null });
        await expect(roles.get("editor")).resolves.toMatchObject({
            label: "编辑者",
            description: "可以改内容",
            parent: null,
        });

        await roles.allow("editor", ["read", "read", "update"], "db:orders", {
            where: { field: "ownerId", op: "eq", valueFrom: "userId" },
        });
        await roles.allow("editor", "invoke", "GET:/api/ping");
        await roles.deny("editor", "delete", "db:orders");
        await expect(roles.allow("editor", "read", "GET:/api/orders", {
            where: { field: "ownerId", op: "eq", valueFrom: "userId" },
        })).rejects.toMatchObject({
            code: PermissionCoreErrorCode.INVALID_ARGUMENT,
        });
        await expect(roles.getRules("editor")).resolves.toEqual([
            {
                type: "allow",
                action: "read",
                resource: "db:orders",
                where: { field: "ownerId", op: "eq", valueFrom: "userId" },
            },
            {
                type: "allow",
                action: "update",
                resource: "db:orders",
                where: { field: "ownerId", op: "eq", valueFrom: "userId" },
            },
            { type: "allow", action: "invoke", resource: "GET:/api/ping" },
            { type: "deny", action: "delete", resource: "db:orders" },
        ]);

        await roles.revokeRule("editor", ["read", "update"], "db:orders", {
            where: { field: "ownerId", op: "eq", valueFrom: "userId" },
        });
        await roles.revokeRule("editor", "invoke", "GET:/api/ping");
        await expect(roles.getRules("editor")).resolves.toEqual([
            { type: "deny", action: "delete", resource: "db:orders" },
        ]);

        await roles.clearRules("editor");
        await expect(roles.getRules("editor")).resolves.toEqual([]);
        await expect(roles.list()).resolves.toHaveLength(2);

        await storage.setUserRoles("user-rbac", ["editor"]);
        await roles.delete("editor");

        await expect(storage.getUserRoles("user-rbac")).resolves.toEqual([]);
        expect(cache.invalidateAll).toHaveBeenCalled();
    });

    it("guards self and transitive circular inheritance updates", async () => {
        const storage = new MemoryAdapter();
        await storage.init();
        const roles = new RoleManager(storage, { invalidateAll: vi.fn(async () => undefined) } as never, () => undefined);

        await roles.create("viewer", { label: "查看者" });
        await roles.create("editor", { label: "编辑", parent: "viewer" });
        await roles.update("editor", { label: "编辑已保留父角色" });
        await roles.update("editor", { parent: "viewer" });

        await expect(roles.update("editor", { parent: "editor" })).rejects.toMatchObject({
            code: PermissionCoreErrorCode.CIRCULAR_INHERITANCE,
        });
        await expect(roles.update("viewer", { parent: "editor" })).rejects.toMatchObject({
            code: PermissionCoreErrorCode.CIRCULAR_INHERITANCE,
        });
    });
});

describe("UserRoleManager", () => {
    it("covers assign, revoke, overwrite and clear flows", async () => {
        const storage = new MemoryAdapter();
        await storage.init();
        await createRoleRecord(storage, "viewer");
        await createRoleRecord(storage, "editor");

        const cache = {
            invalidate: vi.fn(async () => undefined),
        };
        const users = new UserRoleManager(storage, cache as never, () => undefined);

        await users.assign("user-1", "viewer");
        await users.assign("user-1", "viewer");
        await expect(users.getUserRoles("user-1")).resolves.toEqual(["viewer"]);

        await users.setUserRoles("user-1", ["viewer", "editor", "viewer"]);
        await expect(users.getUserRoles("user-1")).resolves.toEqual(["viewer", "editor"]);

        await users.revoke("user-1", "viewer");
        await expect(users.getUserRoles("user-1")).resolves.toEqual(["editor"]);

        await users.clearUserRoles("user-1");
        await expect(users.getUserRoles("user-1")).resolves.toEqual([]);

        await expect(users.assign("user-2", "missing")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.ROLE_NOT_FOUND,
        });

        expect(cache.invalidate).toHaveBeenCalled();
    });
});