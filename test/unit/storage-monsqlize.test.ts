import { describe, expect, it } from "vitest";

import { MonSQLizeStorageAdapter } from "../../src";

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
    readonly indexes: Array<{ keys: unknown; options: unknown }> = [];

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

describe("MonSQLizeStorageAdapter", () => {
    it("stores and reloads roles, bindings and rules through collection facades", async () => {
        const msq = new FakeMonSQLize();
        const adapter = new MonSQLizeStorageAdapter({
            msq: msq as never,
            namespace: "permission_core",
            ownsConnection: true,
        });

        await adapter.init();

        await adapter.setRole("editor", {
            id: "editor",
            label: "编辑",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });
        await adapter.setUserRoles("user-001", ["editor"]);
        await adapter.setRules("editor", [
            { type: "allow", action: "write", resource: "db:articles" },
        ]);

        await expect(adapter.getRoles()).resolves.toEqual(
            new Map([
                [
                    "editor",
                    {
                        id: "editor",
                        label: "编辑",
                        parent: null,
                        description: "",
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            ]),
        );
        await expect(adapter.getUserRoles("user-001")).resolves.toEqual(["editor"]);
        await expect(adapter.getUsersByRole("editor")).resolves.toEqual(["user-001"]);
        await expect(adapter.getRules("editor")).resolves.toEqual([
            { type: "allow", action: "write", resource: "db:articles" },
        ]);

        await adapter.close();
        expect(msq.closed).toBe(true);

        msq.closed = false;

        const reloadedAdapter = new MonSQLizeStorageAdapter({
            msq: msq as never,
            namespace: "permission_core",
        });

        await reloadedAdapter.init();

        await expect(reloadedAdapter.getRoles()).resolves.toEqual(
            new Map([
                [
                    "editor",
                    {
                        id: "editor",
                        label: "编辑",
                        parent: null,
                        description: "",
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            ]),
        );
        await expect(reloadedAdapter.getUserRoles("user-001")).resolves.toEqual(["editor"]);
        await expect(reloadedAdapter.getRules("editor")).resolves.toEqual([
            { type: "allow", action: "write", resource: "db:articles" },
        ]);
    });

    it("stores scoped roles, bindings and rules without tenant bleed", async () => {
        const msq = new FakeMonSQLize();
        const adapter = new MonSQLizeStorageAdapter({
            msq: msq as never,
            namespace: "permission_core",
        });

        await adapter.init();

        await adapter.setScopedRole({ tenantId: "tenant-a" }, "manager", {
            id: "manager",
            label: "Manager A",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        });
        await adapter.setScopedRole({ tenantId: "tenant-b" }, "manager", {
            id: "manager",
            label: "Manager B",
            parent: null,
            description: "",
            createdAt: 2,
            updatedAt: 2,
        });
        await adapter.setScopedUserRoles({ tenantId: "tenant-a" }, "user-001", ["manager"]);
        await adapter.setScopedRules({ tenantId: "tenant-a" }, "manager", [
            { type: "allow", action: "read", resource: "ui:menu:tenant-a" },
        ]);
        await adapter.setScopedRules({ tenantId: "tenant-b" }, "manager", [
            { type: "allow", action: "read", resource: "ui:menu:tenant-b" },
        ]);

        await expect(adapter.getScopedRole({ tenantId: "tenant-a" }, "manager")).resolves.toMatchObject({
            label: "Manager A",
        });
        await expect(adapter.getScopedRole({ tenantId: "tenant-b" }, "manager")).resolves.toMatchObject({
            label: "Manager B",
        });
        await expect(adapter.getScopedUserRoles({ tenantId: "tenant-a" }, "user-001")).resolves.toEqual(["manager"]);
        await expect(adapter.getScopedUserRoles({ tenantId: "tenant-b" }, "user-001")).resolves.toEqual([]);
        await expect(adapter.getScopedRules({ tenantId: "tenant-a" }, "manager")).resolves.toEqual([
            { type: "allow", action: "read", resource: "ui:menu:tenant-a" },
        ]);
        await expect(adapter.getScopedRules({ tenantId: "tenant-b" }, "manager")).resolves.toEqual([
            { type: "allow", action: "read", resource: "ui:menu:tenant-b" },
        ]);
    });
});
