import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PermissionCore } from "../../src";
import {
    FileMenuStorageAdapter,
    MonSQLizeMenuStorageAdapter,
    createMenuPermission,
    type ApiBinding,
    type MenuNode,
} from "../../src/menu";

type PlainDocument = Record<string, unknown>;

function matches(document: PlainDocument, filter: PlainDocument) {
    return Object.entries(filter).every(([key, value]) => document[key] === value);
}

class FakeCollection {
    readonly docs = new Map<string, PlainDocument>();
    readonly indexes: Array<{ keys: unknown; options: unknown }> = [];

    async find(query: PlainDocument = {}) {
        return Array.from(this.docs.values())
            .filter((document) => matches(document, query))
            .map((document) => structuredClone(document));
    }

    async findOne(query: PlainDocument = {}) {
        const document = Array.from(this.docs.values()).find((value) => matches(value, query));
        return document ? structuredClone(document) : null;
    }

    async replaceOne(filter: PlainDocument = {}, replacement: PlainDocument = {}) {
        const id = String(filter._id ?? replacement._id);
        this.docs.set(id, structuredClone(replacement));
        return { acknowledged: true };
    }

    async deleteOne(filter: PlainDocument = {}) {
        const entry = Array.from(this.docs.entries()).find(([, value]) => matches(value, filter));
        if (entry) {
            this.docs.delete(entry[0]);
        }
        return { acknowledged: true };
    }

    async createIndex(keys: unknown, options?: unknown) {
        this.indexes.push({ keys, options });
        return "ok";
    }
}

class FakeMonSQLize {
    readonly collections = new Map<string, FakeCollection>();
    closed = false;

    collection(name: string) {
        if (!this.collections.has(name)) {
            this.collections.set(name, new FakeCollection());
        }
        return this.collections.get(name) as FakeCollection;
    }

    async close() {
        this.closed = true;
    }
}

const SCOPE = { tenantId: "tenant-a", appId: "admin" };
const NODES: MenuNode[] = [
    { id: "users", type: "menu", title: "Users", resource: { action: "read", resource: "ui:menu:users" } },
];
const BINDINGS: ApiBinding[] = [{
    id: "list-users",
    ownerType: "apiGroup",
    ownerId: "users-api",
    method: "GET",
    path: "/api/users",
    resource: "api:GET:/api/users",
    action: "invoke",
    purpose: "entry",
    description: "List users for the management API",
}];

const tempDirs: string[] = [];

afterEach(async () => {
    if (process.env.PERMISSION_CORE_RETAIN_TEST_ARTIFACTS === "1") {
        tempDirs.length = 0;
        return;
    }
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("persistent menu storage adapters", () => {
    it("persists File menu assets, audits and revisions across manager restarts", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "permission-core-menu-storage-"));
        tempDirs.push(tempDir);
        const filePath = path.join(tempDir, "menu.json");
        const core = new PermissionCore();
        await core.init();
        const firstStorage = new FileMenuStorageAdapter({ path: filePath });
        const first = createMenuPermission({ core, storage: firstStorage });
        await first.importFrontendManifest(SCOPE, { nodes: NODES, apiBindings: BINDINGS });
        await first.close();

        const reopenedStorage = new FileMenuStorageAdapter({ path: filePath });
        await reopenedStorage.init();
        await expect(reopenedStorage.listMenuNodes(SCOPE)).resolves.toEqual(NODES);
        await expect(reopenedStorage.listApiBindings(SCOPE)).resolves.toEqual(BINDINGS);
        await expect(reopenedStorage.listAuditEntries(SCOPE)).resolves.toEqual([
            expect.objectContaining({ action: "manifest.import" }),
        ]);
        await expect(reopenedStorage.getRevision(SCOPE)).resolves.toBe(2);
        await expect(reopenedStorage.listMenuNodes({ tenantId: "tenant-b", appId: "admin" })).resolves.toEqual([]);
        await reopenedStorage.close();
    });

    it("persists MonSQLize menu assets with scope isolation, replace semantics and lifecycle ownership", async () => {
        const msq = new FakeMonSQLize();
        const storage = new MonSQLizeMenuStorageAdapter({
            msq: msq as never,
            namespace: "permission_core",
            ownsConnection: true,
        });
        await storage.init();
        const [first, second] = await Promise.all([
            storage.replaceMenuNodes(SCOPE, NODES),
            storage.replaceApiBindings(SCOPE, BINDINGS),
        ]);
        await storage.appendAuditEntries(SCOPE, [{
            id: "audit-1",
            scopeKey: "tenant:tenant-a|app:admin|module:-|ns:-",
            action: "manifest.import",
            createdAt: 1,
        }]);
        expect(first.revision).toBe(1);
        expect(second.revision).toBe(2);
        await storage.close();
        expect(msq.closed).toBe(true);

        const reopened = new MonSQLizeMenuStorageAdapter({ msq: msq as never, namespace: "permission_core" });
        await reopened.init();
        await expect(reopened.listMenuNodes(SCOPE)).resolves.toEqual(NODES);
        await expect(reopened.listApiBindings(SCOPE)).resolves.toEqual(BINDINGS);
        await expect(reopened.listAuditEntries(SCOPE)).resolves.toEqual([
            expect.objectContaining({ id: "audit-1" }),
        ]);
        await expect(reopened.getRevision(SCOPE)).resolves.toBe(2);
        await expect(reopened.listMenuNodes({ tenantId: "tenant-b" })).resolves.toEqual([]);

        const replacement = await reopened.replaceMenuNodes(SCOPE, []);
        expect(replacement).toMatchObject({ deleted: 1, changes: { deletedIds: ["users"] } });
        await expect(reopened.listMenuNodes(SCOPE)).resolves.toEqual([]);
    });
});
