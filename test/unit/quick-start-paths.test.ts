import { MemoryCache } from "cache-hub";
import { describe, expect, it } from "vitest";

import { MemoryAdapter, MonSQLizeStorageAdapter, PermissionCore } from "../../src";

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

    collection(name: string) {
        if (!this.collections.has(name)) {
            this.collections.set(name, new FakeCollection());
        }

        return this.collections.get(name) as FakeCollection;
    }
}

describe("quick start smoke", () => {
    it("covers the HTTP-only path from README and docs", async () => {
        const pc = new PermissionCore({
            storage: new MemoryAdapter(),
        });

        await pc.init();

        try {
            await pc.roles.create("operator", { label: "接口操作员" });
            await pc.roles.allow("operator", "invoke", "GET:/api/orders");
            await pc.roles.allow("operator", "invoke", "POST:/api/orders");
            await pc.users.setUserRoles("u-1", ["operator"]);

            await expect(pc.assert("u-1", "invoke", "GET:/api/orders")).resolves.toBeUndefined();
            await expect(pc.getResources("u-1", "invoke")).resolves.toEqual([
                "GET:/api/orders",
                "POST:/api/orders",
            ]);
        } finally {
            await pc.close();
        }
    });

    it("covers the DB-only path from README and docs", async () => {
        const pc = new PermissionCore({
            storage: new MemoryAdapter(),
        });

        await pc.init();

        try {
            await pc.roles.create("analyst", { label: "数据分析员" });
            await pc.roles.allow("analyst", "read", "db:reports");
            await pc.roles.allow("analyst", "read", "db:reports:title");
            await pc.roles.allow("analyst", "read", "db:reports:summary");
            await pc.users.assign("u-2", "analyst");

            await expect(pc.can("u-2", "read", "db:reports")).resolves.toBe(true);
            await expect(pc.getRowScope("u-2", "read", "db:reports")).resolves.toEqual({ mode: "all" });
            await expect(
                pc.filterFields("u-2", "read", "db:reports", {
                    title: "Q2",
                    summary: "good",
                    rawCost: 100,
                }),
            ).resolves.toEqual({
                title: "Q2",
                summary: "good",
            });
        } finally {
            await pc.close();
        }
    });

    it("covers the Full standard stack path with monsqlize and cache-hub", async () => {
        const msq = new FakeMonSQLize();
        const pc = new PermissionCore({
            storage: new MonSQLizeStorageAdapter({
                msq: msq as never,
                namespace: "permission_core",
            }),
            cache: new MemoryCache({
                defaultTtl: 300_000,
                maxEntries: 100,
            }),
        });

        await pc.init();

        try {
            await pc.roles.create("platform-admin", { label: "平台管理员" });
            await pc.roles.allow("platform-admin", "invoke", "GET:/api/admin/users");
            await pc.roles.allow("platform-admin", "read", "db:users");
            await pc.roles.allow("platform-admin", "read", "db:users:id");
            await pc.roles.allow("platform-admin", "read", "db:users:name");
            await pc.users.assign("u-3", "platform-admin");

            await expect(pc.assert("u-3", "invoke", "GET:/api/admin/users")).resolves.toBeUndefined();
            await expect(pc.filterFields("u-3", "read", "db:users", {
                id: "u-3",
                name: "Alice",
                salary: 100,
            })).resolves.toEqual({
                id: "u-3",
                name: "Alice",
            });
            await expect(pc.getResources("u-3", "invoke")).resolves.toEqual([
                "GET:/api/admin/users",
            ]);
        } finally {
            await pc.close();
        }
    });
});