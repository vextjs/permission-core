import * as realFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionCoreErrorCode } from "../../src";

const tempDirs: string[] = [];

async function createTempFilePath() {
    const tempDir = await realFs.mkdtemp(path.join(os.tmpdir(), "permission-core-file-adapter-extra-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, "permission-core-data.json");
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("node:fs/promises");
    await Promise.all(tempDirs.splice(0).map((dirPath) => realFs.rm(dirPath, { recursive: true, force: true })));
});

describe("FileAdapter additional flows", () => {
    it("uses the default file path and tolerates partial persisted payloads", async () => {
        const { FileAdapter } = await import("../../src");
        const filePath = await createTempFilePath();
        await realFs.writeFile(filePath, JSON.stringify({}, null, 2), "utf-8");

        const adapter = new FileAdapter({ path: filePath });
        const defaultPathAdapter = new FileAdapter();

        expect((defaultPathAdapter as unknown as { filePath: string }).filePath).toBe("./permission-core-data.json");

        await adapter.init();
        await expect(adapter.getRoles()).resolves.toEqual(new Map());
        await expect(adapter.getUserRoles("missing-user")).resolves.toEqual([]);
        await adapter.close();
    });

    it("rebuilds reverse indexes and supports role and rule deletions", async () => {
        const { FileAdapter } = await import("../../src");
        const filePath = await createTempFilePath();
        await realFs.writeFile(filePath, JSON.stringify({
            roles: {
                viewer: { id: "viewer", label: "查看者", parent: null, description: "", createdAt: 1, updatedAt: 1 },
                editor: { id: "editor", label: "编辑", parent: null, description: "", createdAt: 1, updatedAt: 1 },
            },
            userRoles: {
                "user-1": ["viewer", "editor"],
            },
            rules: {
                viewer: [{ type: "allow", action: "invoke", resource: "GET:/api/orders" }],
                editor: [{ type: "allow", action: "read", resource: "db:orders" }],
            },
        }, null, 2), "utf-8");

        const adapter = new FileAdapter({ path: filePath });
        await adapter.init();

        await expect(adapter.getRoles()).resolves.toEqual(new Map([
            ["viewer", { id: "viewer", label: "查看者", parent: null, description: "", createdAt: 1, updatedAt: 1 }],
            ["editor", { id: "editor", label: "编辑", parent: null, description: "", createdAt: 1, updatedAt: 1 }],
        ]));
        await expect(adapter.getUsersByRole("viewer")).resolves.toEqual(["user-1"]);

        await adapter.setUserRoles("user-1", ["editor"]);
        await expect(adapter.getUsersByRole("viewer")).resolves.toEqual([]);

        await adapter.deleteRules("editor");
        await expect(adapter.getRules("editor")).resolves.toEqual([]);

        await adapter.deleteRole("editor");
        await expect(adapter.getRole("editor")).resolves.toBeNull();
        await expect(adapter.getRules("editor")).resolves.toEqual([]);

        await adapter.close();
    });

    it("wraps read and write failures and blocks further reads after a failed write", async () => {
        const filePath = await createTempFilePath();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            return {
                ...actual,
                readFile: vi.fn().mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" })),
            };
        });

        const { FileAdapter: ReadFailingFileAdapter } = await import("../../src");

        const readFailingAdapter = new ReadFailingFileAdapter({ path: filePath });
        await expect(readFailingAdapter.init()).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });

        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            return {
                ...actual,
                writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
            };
        });

        const { FileAdapter: WriteFailingFileAdapter } = await import("../../src");

        const adapter = new WriteFailingFileAdapter({ path: filePath });
        await adapter.init();
        await adapter.setRole("viewer", {
            id: "viewer",
            label: "查看者",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });

        const internal = adapter as any;
        if (internal.debounceTimer) {
            clearTimeout(internal.debounceTimer);
            internal.debounceTimer = null;
        }

        await expect(internal.writeToDisk()).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });
        await expect(adapter.getRole("viewer")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });
        await expect(adapter.close()).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });
    });

    it("flushes a pending write after the in-flight write completes", async () => {
        const filePath = await createTempFilePath();
        const actualWriteFile = realFs.writeFile as (...args: any[]) => Promise<void>;
        const deferred = createDeferred<void>();
        let writeCount = 0;

        vi.resetModules();
        vi.doMock("node:fs/promises", async () => {
            const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
            return {
                ...actual,
                writeFile: vi.fn(async (...args: any[]) => {
                    writeCount += 1;
                    if (writeCount === 1) {
                        await deferred.promise;
                    }

                    return actualWriteFile(...args);
                }),
            };
        });

        const { FileAdapter } = await import("../../src");
        const mockedAdapter = new FileAdapter({ path: filePath });
        await mockedAdapter.init();

        const mockedInternal = mockedAdapter as any;

        await mockedAdapter.setRole("viewer", {
            id: "viewer",
            label: "查看者",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });
        if (mockedInternal.debounceTimer) {
            clearTimeout(mockedInternal.debounceTimer);
            mockedInternal.debounceTimer = null;
        }

        const firstWrite = mockedInternal.writeToDisk();
        await Promise.resolve();

        await mockedAdapter.setRole("editor", {
            id: "editor",
            label: "编辑",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });
        if (mockedInternal.debounceTimer) {
            clearTimeout(mockedInternal.debounceTimer);
            mockedInternal.debounceTimer = null;
        }

        const secondWrite = mockedInternal.writeToDisk();
        expect(mockedInternal.pendingWrite).toBe(true);

        const closePromise = mockedAdapter.close();

        deferred.resolve();
        await Promise.all([firstWrite, secondWrite, closePromise]);

        const mockedFs = await import("node:fs/promises");
        expect((mockedFs.writeFile as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
        const persisted = JSON.parse(await realFs.readFile(filePath, "utf-8")) as { roles: Record<string, unknown> };
        expect(Object.keys(persisted.roles).sort()).toEqual(["editor", "viewer"]);
    });

    it("executes the debounced write callback when updates settle", async () => {
        const { FileAdapter } = await import("../../src");
        const filePath = await createTempFilePath();
        const adapter = new FileAdapter({ path: filePath });
        await adapter.init();
        vi.useFakeTimers();

        const writeSpy = vi.spyOn(adapter as never, "writeToDisk");

        await adapter.setRole("viewer", {
            id: "viewer",
            label: "查看者",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });

        await vi.runAllTimersAsync();

        expect(writeSpy).toHaveBeenCalled();

        vi.useRealTimers();
        await adapter.close();
    });
});