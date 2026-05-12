import { describe, expect, it } from "vitest";

import { MemoryAdapter } from "../../src/storage/memory-adapter";

describe("MemoryAdapter", () => {
    it("stores roles and returns defensive copies", async () => {
        const storage = new MemoryAdapter();
        await storage.init();

        await storage.setRole("editor", {
            id: "editor",
            label: "编辑",
            parent: "viewer",
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });

        const role = await storage.getRole("editor");
        expect(role).toEqual({
            id: "editor",
            label: "编辑",
            parent: "viewer",
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });

        if (!role) {
            throw new Error("role should exist");
        }

        role.label = "已改坏";

        await expect(storage.getRole("editor")).resolves.toEqual({
            id: "editor",
            label: "编辑",
            parent: "viewer",
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });
    });

    it("updates direct user bindings by role", async () => {
        const storage = new MemoryAdapter();

        await storage.setUserRoles("user-001", ["viewer", "editor"]);
        await storage.setUserRoles("user-002", ["viewer"]);
        await storage.setUserRoles("user-001", ["editor"]);

        await expect(storage.getUsersByRole("viewer")).resolves.toEqual(["user-002"]);
        await expect(storage.getUsersByRole("editor")).resolves.toEqual(["user-001"]);
    });

    it("stores and deletes role rules", async () => {
        const storage = new MemoryAdapter();

        await storage.setRules("editor", [
            {
                type: "allow",
                action: "read",
                resource: "db:articles",
            },
        ]);

        await expect(storage.getRules("editor")).resolves.toEqual([
            {
                type: "allow",
                action: "read",
                resource: "db:articles",
            },
        ]);

        await storage.deleteRules("editor");
        await expect(storage.getRules("editor")).resolves.toEqual([]);
    });
});