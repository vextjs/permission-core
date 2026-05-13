import { describe, expect, it, vi } from "vitest";

import { MonSQLizeStorageAdapter, PermissionCoreErrorCode } from "../../src";

type PlainDocument = Record<string, unknown>;

function matches(document: PlainDocument, filter: PlainDocument) {
    return Object.entries(filter).every(([key, value]) => {
        const actual = document[key];
        if (Array.isArray(actual)) {
            return actual.includes(value);
        }

        return actual === value;
    });
}

class FakeCollection {
    readonly docs = new Map<string, PlainDocument>();

    async find(query: PlainDocument = {}) {
        return Array.from(this.docs.values())
            .filter((document) => matches(document, query))
            .map((document) => structuredClone(document));
    }

    async findOne(query: PlainDocument = {}) {
        const doc = Array.from(this.docs.values()).find((document) => matches(document, query));
        return doc ? structuredClone(doc) : null;
    }

    async replaceOne(filter: PlainDocument = {}, replacement: PlainDocument = {}) {
        const id = String(filter._id ?? replacement._id);
        this.docs.set(id, structuredClone(replacement));
        return { acknowledged: true };
    }

    async deleteOne(filter: PlainDocument = {}) {
        const doc = Array.from(this.docs.entries()).find(([, value]) => matches(value, filter));
        if (doc) {
            this.docs.delete(doc[0]);
        }

        return { acknowledged: true };
    }

    async createIndex() {
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

describe("MonSQLizeStorageAdapter additional flows", () => {
    it("supports missing documents, delete operations and no-op close", async () => {
        const msq = new FakeMonSQLize();
        const adapter = new MonSQLizeStorageAdapter({
            msq: msq as never,
            namespace: "permission_core",
        });

        await adapter.init();
        await expect(adapter.getRole("missing")).resolves.toBeNull();

        await adapter.setRole("editor", {
            id: "editor",
            label: "编辑",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });
        await adapter.deleteRole("editor");
        await expect(adapter.getRole("editor")).resolves.toBeNull();

        await adapter.setRules("editor", [{ type: "allow", action: "read", resource: "db:orders" }]);
        await adapter.deleteRules("editor");
        await expect(adapter.getRules("editor")).resolves.toEqual([]);

        await adapter.close();
        expect(msq.closed).toBe(false);
    });

    it("wraps init, close and runtime failures as storage errors", async () => {
        const initFailingMsq = {
            collection() {
                return {
                    createIndex: vi.fn(async () => {
                        throw new Error("index failed");
                    }),
                };
            },
        };

        await expect(new MonSQLizeStorageAdapter({ msq: initFailingMsq as never }).init()).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });

        const closeFailingMsq = new FakeMonSQLize();
        closeFailingMsq.close = vi.fn(async () => {
            throw new Error("close failed");
        });

        const closeAdapter = new MonSQLizeStorageAdapter({
            msq: closeFailingMsq as never,
            namespace: "permission_core",
            ownsConnection: true,
        });
        await closeAdapter.init();
        await expect(closeAdapter.close()).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });

        const runtimeFailingMsq = new FakeMonSQLize();
        const runtimeAdapter = new MonSQLizeStorageAdapter({
            msq: runtimeFailingMsq as never,
            namespace: "permission_core",
        });
        await runtimeAdapter.init();

        vi.spyOn(runtimeFailingMsq.collection("permission_core_roles"), "findOne").mockRejectedValue(new Error("query failed"));

        await expect(runtimeAdapter.getRole("editor")).rejects.toMatchObject({
            code: PermissionCoreErrorCode.STORAGE_ERROR,
        });
    });
});