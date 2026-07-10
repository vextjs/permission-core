import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileAdapter, PermissionCoreErrorCode, getPermissionScopeKey } from "../../src";

const tempDirs: string[] = [];

async function createTempFilePath() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "permission-core-file-adapter-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, "permission-core-data.json");
}

afterEach(async () => {
    if (process.env.PERMISSION_CORE_RETAIN_TEST_ARTIFACTS === "1") {
        tempDirs.length = 0;
        return;
    }
    await Promise.all(
        tempDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })),
    );
});

describe("FileAdapter", () => {
    it("persists roles, bindings and rules to disk", async () => {
        const filePath = await createTempFilePath();
        const adapter = new FileAdapter({ path: filePath });
        await adapter.init();

        await adapter.setRole("viewer", {
            id: "viewer",
            label: "查看者",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });
        await adapter.setUserRoles("user-001", ["viewer"]);
        await adapter.setRules("viewer", [
            { type: "allow", action: "invoke", resource: "GET:/api/articles" },
        ]);
        await adapter.close();

        const reopened = new FileAdapter({ path: filePath });
        await reopened.init();

        await expect(reopened.getRole("viewer")).resolves.toEqual({
            id: "viewer",
            label: "查看者",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });
        await expect(reopened.getUserRoles("user-001")).resolves.toEqual(["viewer"]);
        await expect(reopened.getUsersByRole("viewer")).resolves.toEqual(["user-001"]);
        await expect(reopened.getRules("viewer")).resolves.toEqual([
            { type: "allow", action: "invoke", resource: "GET:/api/articles" },
        ]);

        await reopened.close();
    });

    it("persists scoped data separately and migrates legacy payloads to default scope", async () => {
        const filePath = await createTempFilePath();
        await fs.writeFile(filePath, JSON.stringify({
            roles: {
                legacy: { id: "legacy", label: "Legacy", parent: null, description: "", createdAt: 1, updatedAt: 1 },
            },
            userRoles: {
                "user-001": ["legacy"],
            },
            rules: {
                legacy: [{ type: "allow", action: "read", resource: "ui:menu:legacy" }],
            },
        }, null, 2), "utf-8");

        const adapter = new FileAdapter({ path: filePath });
        await adapter.init();

        await expect(adapter.getRole("legacy")).resolves.toMatchObject({ id: "legacy" });
        await adapter.setScopedRole({ tenantId: "tenant-a" }, "admin", {
            id: "admin",
            label: "Admin A",
            parent: null,
            description: "",
            createdAt: 2,
            updatedAt: 2,
        });
        await adapter.setScopedUserRoles({ tenantId: "tenant-a" }, "user-001", ["admin"]);
        await adapter.setScopedRules({ tenantId: "tenant-a" }, "admin", [
            { type: "allow", action: "read", resource: "ui:menu:tenant-a" },
        ]);
        await adapter.close();

        const persisted = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
            schemaVersion: number;
            scopes: Record<string, { roles: Record<string, unknown>; userRoles: Record<string, string[]> }>;
        };
        expect(persisted.schemaVersion).toBe(2);
        expect(Object.keys(persisted.scopes[getPermissionScopeKey({ tenantId: "default" })].roles)).toEqual(["legacy"]);
        expect(Object.keys(persisted.scopes[getPermissionScopeKey({ tenantId: "tenant-a" })].roles)).toEqual(["admin"]);

        const reopened = new FileAdapter({ path: filePath });
        await reopened.init();

        await expect(reopened.getRole("admin")).resolves.toBeNull();
        await expect(reopened.getScopedRole({ tenantId: "tenant-a" }, "admin")).resolves.toMatchObject({
            id: "admin",
            label: "Admin A",
        });
        await expect(reopened.getScopedUserRoles({ tenantId: "tenant-a" }, "user-001")).resolves.toEqual(["admin"]);
        await expect(reopened.getScopedUsersByRole({ tenantId: "tenant-a" }, "admin")).resolves.toEqual(["user-001"]);
        await expect(reopened.getScopedRules({ tenantId: "tenant-a" }, "admin")).resolves.toEqual([
            { type: "allow", action: "read", resource: "ui:menu:tenant-a" },
        ]);

        await reopened.close();
    });

    it("throws STORAGE_ERROR when the file content is invalid JSON", async () => {
        const filePath = await createTempFilePath();
        await fs.writeFile(filePath, "{invalid json", "utf-8");

        const adapter = new FileAdapter({ path: filePath });
        await expect(adapter.init()).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });
    });
});
