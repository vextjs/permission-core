import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileAdapter, PermissionCoreErrorCode } from "../../src";

const tempDirs: string[] = [];

async function createTempFilePath() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "permission-core-file-adapter-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, "permission-core-data.json");
}

afterEach(async () => {
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

    it("throws STORAGE_ERROR when the file content is invalid JSON", async () => {
        const filePath = await createTempFilePath();
        await fs.writeFile(filePath, "{invalid json", "utf-8");

        const adapter = new FileAdapter({ path: filePath });
        await expect(adapter.init()).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });
    });
});