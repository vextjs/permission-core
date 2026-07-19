import { randomUUID } from "node:crypto";
import MonSQLize from "monsqlize";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PermissionCore, PermissionCoreError } from "../../src";
import type { PermissionScope } from "../../src/types";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const PREFIX = `pc_data_${randomUUID().replaceAll("-", "")}`;

interface RawCollection {
    insertMany(documents: readonly Record<string, unknown>[]): Promise<unknown>;
    insertOne(document: Record<string, unknown>, options?: unknown): Promise<{ insertedId: unknown }>;
    findOne(filter: unknown): Promise<Record<string, unknown> | null>;
    countDocuments(filter: unknown): Promise<number>;
    find(filter: unknown, options?: unknown): unknown;
}

function scope(label: string): PermissionScope {
    return { tenantId: `tenant-${label}-${randomUUID()}` };
}

function rawCollection(context: RealMongoContext, name: string) {
    return context.monsqlize.collection(name).raw() as RawCollection;
}

async function grant(
    core: PermissionCore,
    targetScope: PermissionScope,
    userId: string,
    roleId: string,
    rules: readonly {
        effect?: "allow" | "deny";
        action: "read" | "create" | "update" | "delete";
        resource: string;
        where?: unknown;
    }[],
) {
    const scoped = core.scope(targetScope);
    await scoped.roles.create({ id: roleId, label: roleId });
    for (const rule of rules) {
        const input = { action: rule.action, resource: rule.resource, ...(rule.where === undefined ? {} : { where: rule.where as never }) };
        if (rule.effect === "deny") await scoped.roles.deny(roleId, input);
        else await scoped.roles.allow(roleId, input);
    }
    await scoped.userRoles.assign(userId, roleId);
}

describe("AuthorizedCollection on host-owned MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let core: PermissionCore;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 97 });
        core = new PermissionCore({
            monsqlize: context.monsqlize,
            collectionPrefix: PREFIX,
            tokenSecret: "permission-core-data-runtime-integration-secret",
        });
        await core.init();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await core?.close();
        await context?.close();
    }, TEST_TIMEOUT);

    it("combines business, exact scalar tenant, and conditional row filters without an override path", async () => {
        const targetScope = scope("read");
        const otherScope = scope("other");
        const name = `orders_read_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-read", "reader", [{
            action: "read",
            resource: "db:orders",
            where: { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" },
        }]);
        await rawCollection(context, name).insertMany([
            { tenantId: targetScope.tenantId, merchantId: "m-1", status: "paid", amount: 10 },
            { tenantId: targetScope.tenantId, merchantId: "m-2", status: "paid", amount: 20 },
            { tenantId: otherScope.tenantId, merchantId: "m-1", status: "paid", amount: 30 },
            { tenantId: [targetScope.tenantId], merchantId: "m-1", status: "paid", amount: 40 },
            { tenantId: { value: targetScope.tenantId }, merchantId: "m-1", status: "paid", amount: 50 },
        ]);
        const orders = core.forSubject({
            userId: "u-read",
            scope: targetScope,
            claims: { merchantId: "m-1" },
        }).data.collection(name, { resource: "db:orders", scopeFields: { tenantId: "tenantId" } });

        const rows = await orders.find({ $or: [{ status: "paid" }, { tenantId: otherScope.tenantId }] } as never);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ tenantId: targetScope.tenantId, merchantId: "m-1", amount: 10 });
    });

    it("keeps exact scalar scope isolation across count, bulk update, and bulk delete", async () => {
        const targetScope = scope("scope-write");
        const otherScope = scope("scope-write-other");
        const name = `orders_scope_write_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-scope-write", "scope-writer", [
            { action: "read", resource: "db:orders" },
            { action: "update", resource: "db:orders" },
            { action: "delete", resource: "db:orders" },
        ]);
        await rawCollection(context, name).insertMany([
            { tenantId: targetScope.tenantId, marker: "exact" },
            { tenantId: [targetScope.tenantId, otherScope.tenantId], marker: "array" },
            { tenantId: { value: targetScope.tenantId }, marker: "object" },
            { marker: "missing" },
        ]);
        const orders = core.forSubject({ userId: "u-scope-write", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        expect(await orders.count()).toBe(1);
        await expect(orders.updateMany({}, { $set: { changed: true } }, { maxAffected: 10 })).resolves.toMatchObject({ matchedCount: 1 });
        expect(await rawCollection(context, name).countDocuments({ changed: true })).toBe(1);
        await expect(orders.deleteMany({}, { maxAffected: 10 })).resolves.toMatchObject({ deletedCount: 1 });
        expect(await rawCollection(context, name).countDocuments({})).toBe(3);
        expect(await orders.count()).toBe(0);
    });

    it("rejects missing policy context before touching the business collection", async () => {
        const targetScope = scope("context");
        const name = `orders_context_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-context", "context-reader", [{
            action: "read",
            resource: "db:orders",
            where: { field: "region", op: "eq", valueFrom: "context.region" },
        }]);
        const orders = core.forSubject({ userId: "u-context", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        await expect(orders.find()).rejects.toMatchObject({ code: "POLICY_CONTEXT_MISSING" });
        expect(await rawCollection(context, name).countDocuments({})).toBe(0);
    });

    it("combines allow OR with deny true-or-unknown fail-closed semantics", async () => {
        const targetScope = scope("effect-composition");
        const name = `orders_effects_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-effects", "effect-reader", [
            { action: "read", resource: "db:orders", where: { field: "region", op: "eq", value: "east" } },
            { action: "read", resource: "db:orders", where: { field: "ownerId", op: "eq", valueFrom: "subject.userId" } },
            { effect: "deny", action: "read", resource: "db:orders", where: { field: "risk", op: "eq", value: "blocked" } },
        ]);
        await rawCollection(context, name).insertMany([
            { tenantId: targetScope.tenantId, marker: "region", region: "east", risk: "safe" },
            { tenantId: targetScope.tenantId, marker: "owner", region: "west", ownerId: "u-effects", risk: "safe" },
            { tenantId: targetScope.tenantId, marker: "denied", region: "east", risk: "blocked" },
            { tenantId: targetScope.tenantId, marker: "missing", region: "east" },
            { tenantId: targetScope.tenantId, marker: "no-allow", region: "west", risk: "safe" },
            { tenantId: targetScope.tenantId, marker: "mixed", region: "east", risk: ["safe", { nested: true }] },
        ]);
        const orders = core.forSubject({ userId: "u-effects", scope: targetScope }).data.collection<{ marker: string }>(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        expect((await orders.find({}, { sort: { marker: 1 } })).map((row) => row.marker)).toEqual(["owner", "region"]);
    });

    it("filters returned fields and prevents filter/sort inference through conditional fields", async () => {
        const targetScope = scope("fields");
        const name = `orders_fields_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-fields", "field-reader", [
            { action: "read", resource: "db:orders" },
            { action: "read", resource: "db:orders:field:publicValue" },
            { action: "read", resource: "db:orders:field:conditionalValue", where: { field: "status", op: "eq", value: "open" } },
            { effect: "deny", action: "read", resource: "db:orders:field:secret" },
        ]);
        await rawCollection(context, name).insertMany([
            { tenantId: targetScope.tenantId, publicValue: "shown", conditionalValue: "shown-open", secret: "hidden", status: "open" },
        ]);
        const orders = core.forSubject({ userId: "u-fields", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        const rows = await orders.find({}, { projection: ["publicValue", "conditionalValue"] });
        expect(rows).toEqual([{ publicValue: "shown", conditionalValue: "shown-open" }]);
        await expect(orders.find({}, { projection: ["secret"] })).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
        await expect(orders.find({ secret: "hidden" })).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
        await expect(orders.find({}, { sort: { conditionalValue: 1 } })).rejects.toMatchObject({
            code: "FIELD_PERMISSION_DENIED",
            details: { stage: "query" },
        });
    });

    it("propagates known descendant field restrictions to parent query and write paths", async () => {
        const targetScope = scope("field-descendants");
        const name = `orders_field_descendants_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-field-descendants", "field-descendant-guard", [
            { action: "read", resource: "db:orders" },
            { effect: "deny", action: "read", resource: "db:orders:field:profile.secret" },
            { action: "update", resource: "db:orders" },
            { action: "update", resource: "db:orders:field:profile" },
            { effect: "deny", action: "update", resource: "db:orders:field:profile.secret" },
        ]);
        await rawCollection(context, name).insertOne({
            tenantId: targetScope.tenantId,
            profile: { name: "shown", secret: "hidden" },
        });
        const orders = core.forSubject({ userId: "u-field-descendants", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        await expect(orders.find({ profile: { name: "shown", secret: "hidden" } })).rejects.toMatchObject({
            code: "FIELD_PERMISSION_DENIED",
        });
        await expect(orders.find({}, { sort: { profile: 1 } })).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
        await expect(orders.updateOne({}, { $unset: { profile: true } })).rejects.toMatchObject({ code: "FIELD_PERMISSION_DENIED" });
        expect(await rawCollection(context, name).countDocuments({ "profile.secret": "hidden" })).toBe(1);
    });

    it("recursively applies inclusion and exclusion projection inside object arrays", async () => {
        const targetScope = scope("array-projection");
        const name = `orders_array_projection_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-array-projection", "array-reader", [{ action: "read", resource: "db:orders" }]);
        await rawCollection(context, name).insertOne({
            tenantId: targetScope.tenantId,
            items: [
                { name: "visible-a", secret: "hidden-a" },
                { name: "visible-b", secret: "hidden-b" },
            ],
        });
        const orders = core.forSubject({ userId: "u-array-projection", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        expect(await orders.find({}, { projection: ["items.name"] })).toEqual([{
            items: [{ name: "visible-a" }, { name: "visible-b" }],
        }]);
        const excluded = await orders.find({}, { projection: { "items.secret": 0 } });
        expect(excluded[0]).toMatchObject({ items: [{ name: "visible-a" }, { name: "visible-b" }] });
        expect(excluded[0]).not.toHaveProperty("items.0.secret");
        expect(excluded[0]).not.toHaveProperty("items.1.secret");
    });

    it("protects insert, update, bulk bounds, and delete in real transactions", async () => {
        const targetScope = scope("writes");
        const name = `orders_write_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-write", "writer", [
            { action: "create", resource: "db:orders", where: { field: "ownerId", op: "eq", valueFrom: "subject.userId" } },
            { action: "update", resource: "db:orders", where: { field: "ownerId", op: "eq", valueFrom: "subject.userId" } },
            { action: "delete", resource: "db:orders", where: { field: "ownerId", op: "eq", valueFrom: "subject.userId" } },
            { action: "read", resource: "db:orders", where: { field: "ownerId", op: "eq", valueFrom: "subject.userId" } },
        ]);
        const orders = core.forSubject({ userId: "u-write", scope: targetScope }).data.collection<
            { _id: string; tenantId: string; ownerId: string; status: string },
            { ownerId: string; status: string }
        >(name, { resource: "db:orders", scopeFields: { tenantId: "tenantId" } });

        const inserted = await orders.insertOne({ ownerId: "u-write", status: "draft" });
        expect(inserted.acknowledged).toBe(true);
        expect(await rawCollection(context, name).findOne({ _id: inserted.insertedId })).toMatchObject({ tenantId: targetScope.tenantId });

        await expect(orders.insertOne({ ownerId: "someone-else", status: "draft" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        expect(await orders.updateOne({ ownerId: "u-write" }, { $set: { status: "paid" } })).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
        expect(await orders.findOne()).toMatchObject({ status: "paid" });
        await expect(orders.updateMany({}, { $set: { ownerId: "someone-else" } }, { maxAffected: 10 })).rejects.toMatchObject({ code: "DATA_BULK_SCOPE_MUTATION_UNSAFE" });

        const borrowed = await context.monsqlize.startSession();
        await borrowed.start();
        await expect(orders.updateOne(
            { ownerId: "u-write" },
            { $set: { ownerId: "someone-else" } },
            { transaction: borrowed },
        )).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        expect(borrowed.session.inTransaction()).toBe(false);
        await expect(borrowed.commit()).rejects.toThrow();
        expect(await orders.findOne()).toMatchObject({ ownerId: "u-write", status: "paid" });

        const unresolved = await context.monsqlize.startSession();
        await unresolved.start();
        const abort = vi.spyOn(unresolved, "abort").mockResolvedValue(undefined);
        await expect(orders.updateOne(
            { ownerId: "u-write" },
            { $set: { ownerId: "someone-else" } },
            { transaction: unresolved },
        )).rejects.toMatchObject({
            code: "TRANSACTION_FAILED",
            details: { kind: "database-failure", stage: "transaction-abort" },
        });
        expect(unresolved.session.inTransaction()).toBe(true);
        abort.mockRestore();
        await unresolved.abort();

        expect(await orders.deleteOne({ ownerId: "u-write" })).toEqual({ acknowledged: true, deletedCount: 1 });
        expect(await orders.count()).toBe(0);
    });

    it("uses confidential revision-bound forward cursors", async () => {
        const targetScope = scope("cursor");
        const name = `orders_cursor_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-page", "pager", [{ action: "read", resource: "db:orders" }]);
        await rawCollection(context, name).insertMany(Array.from({ length: 5 }, (_, index) => ({
            tenantId: targetScope.tenantId,
            sequence: index + 1,
        })));
        const orders = core.forSubject({ userId: "u-page", scope: targetScope }).data.collection<{
            _id: string;
            tenantId: string;
            sequence: number;
        }>(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        const first = await orders.findPage({ first: 2, sort: { sequence: 1 } });
        expect(first.items.map((item) => item.sequence)).toEqual([1, 2]);
        expect(first.pageInfo.hasNext).toBe(true);
        const token = first.pageInfo.endCursor!;
        expect(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).not.toContain(targetScope.tenantId);

        const foreignMonSQLize = new MonSQLize({
            type: "mongodb",
            databaseName: context.databaseName,
            config: { uri: context.uri },
        });
        await foreignMonSQLize.connect();
        const foreignCore = new PermissionCore({
            monsqlize: foreignMonSQLize,
            collectionPrefix: PREFIX,
            tokenSecret: "permission-core-data-runtime-integration-secret",
        });
        await foreignCore.init();
        try {
            const foreignOrders = foreignCore.forSubject({ userId: "u-page", scope: targetScope }).data.collection(name, {
                resource: "db:orders",
                scopeFields: { tenantId: "tenantId" },
            });
            expect(() => foreignOrders.findPage({ first: 2, after: token, sort: { sequence: 1 } })).toThrowError(
                expect.objectContaining({ code: "INVALID_CURSOR" }),
            );
        } finally {
            await foreignCore.close();
            await foreignMonSQLize.close();
        }

        const recreated = core.forSubject({ userId: "u-page", scope: targetScope }).data.collection<{
            _id: string;
            tenantId: string;
            sequence: number;
        }>(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });
        const second = await recreated.findPage({ first: 2, after: token, sort: { sequence: 1 } });
        expect(second.items.map((item) => item.sequence)).toEqual([3, 4]);
        const previous = await recreated.findPage({ last: 2, before: second.pageInfo.startCursor!, sort: { sequence: 1 } });
        expect(previous.items.map((item) => item.sequence)).toEqual([1, 2]);
        expect(previous.pageInfo.hasNext).toBe(true);
        expect(() => recreated.findPage({ last: 2, before: second.pageInfo.endCursor!, sort: { sequence: 1 } }))
            .toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));

        const changedContext = core.forSubject(
            { userId: "u-page", scope: targetScope },
            { requestKind: "different" },
        ).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });
        expect(() => changedContext.findPage({ first: 2, after: token, sort: { sequence: 1 } }))
            .toThrowError(expect.objectContaining({ code: "CURSOR_STALE" }));

        const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
        expect(() => orders.findPage({ first: 2, after: tampered, sort: { sequence: 1 } })).toThrow(PermissionCoreError);
        expect(() => orders.findPage({ first: 2, after: tampered, sort: { sequence: 1 } }))
            .toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));

        await core.scope(targetScope).roles.allow("pager", {
            action: "read",
            resource: "db:orders",
            where: { field: "sequence", op: "gte", value: 1 },
        });
        await expect(orders.findPage({ first: 2, after: token, sort: { sequence: 1 } }))
            .rejects.toMatchObject({ code: "CURSOR_STALE" });
    });

    it("rejects pagination over missing, array, or mixed BSON sort domains", async () => {
        const targetScope = scope("cursor-sort-domain");
        await grant(core, targetScope, "u-sort-domain", "sort-domain-reader", [{ action: "read", resource: "db:orders" }]);

        for (const [label, documents] of [
            ["mixed", [{ sequence: 1 }, { sequence: "2" }]],
            ["missing", [{ sequence: 1 }, { marker: "missing" }]],
            ["array", [{ sequence: [1, 2] }, { sequence: [3, 4] }]],
        ] as const) {
            const name = `orders_sort_${label}_${randomUUID().replaceAll("-", "")}`;
            await rawCollection(context, name).insertMany(documents.map((document) => ({
                tenantId: targetScope.tenantId,
                ...document,
            })));
            const orders = core.forSubject({ userId: "u-sort-domain", scope: targetScope }).data.collection(name, {
                resource: "db:orders",
                scopeFields: { tenantId: "tenantId" },
            });

            await expect(orders.findPage({ first: 1, sort: { sequence: 1 } })).rejects.toMatchObject({
                code: "PERSISTED_STATE_INVALID",
                details: { kind: "persisted-state-invalid", stage: "load" },
            });
        }

        const validName = `orders_sort_null_${randomUUID().replaceAll("-", "")}`;
        await rawCollection(context, validName).insertMany([
            { tenantId: targetScope.tenantId, sequence: null, marker: "a" },
            { tenantId: targetScope.tenantId, sequence: null, marker: "b" },
        ]);
        const valid = core.forSubject({ userId: "u-sort-domain", scope: targetScope }).data.collection<{ marker: string }>(validName, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });
        const first = await valid.findPage({ first: 1, sort: { sequence: 1 } });
        const second = await valid.findPage({ first: 1, after: first.pageInfo.endCursor!, sort: { sequence: 1 } });
        expect(first.items).toHaveLength(1);
        expect(second.items).toHaveLength(1);
        expect(second.items[0].marker).not.toBe(first.items[0].marker);

        const codecName = `orders_sort_binary_codec_${randomUUID().replaceAll("-", "")}`;
        const codecCollection = rawCollection(context, codecName);
        await codecCollection.insertOne({ tenantId: targetScope.tenantId, value: Buffer.from([0]) });
        const codecDocument = await codecCollection.findOne({});
        const Binary = (codecDocument?.value as {
            constructor: new(value: Uint8Array, subtype?: number) => unknown;
        }).constructor;
        const binaryName = `orders_sort_binary_${randomUUID().replaceAll("-", "")}`;
        await rawCollection(context, binaryName).insertMany([
            { tenantId: targetScope.tenantId, code: new Binary(new Uint8Array([1]), 4), marker: "binary-a" },
            { tenantId: targetScope.tenantId, code: new Binary(new Uint8Array([2]), 4), marker: "binary-b" },
        ]);
        const binaries = core.forSubject({ userId: "u-sort-domain", scope: targetScope }).data.collection<{ marker: string }>(binaryName, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });
        const binaryFirst = await binaries.findPage({ first: 1, sort: { code: 1 } });
        const binarySecond = await binaries.findPage({ first: 1, after: binaryFirst.pageInfo.endCursor!, sort: { code: 1 } });
        expect(binaryFirst.items.map((item) => item.marker)).toEqual(["binary-a"]);
        expect(binarySecond.items.map((item) => item.marker)).toEqual(["binary-b"]);
    });

    it("rolls back unowned sibling fields and same-path caller value rewrites", async () => {
        const targetScope = scope("provenance");
        const name = `orders_provenance_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-provenance", "creator", [{ action: "create", resource: "db:orders" }]);
        const native = rawCollection(context, name);
        const prototype = Object.getPrototypeOf(native) as RawCollection;
        const original = prototype.insertOne;
        const injected = vi.spyOn(prototype, "insertOne").mockImplementation(function (this: RawCollection, document, options) {
            const current = this as unknown as { collectionName?: string };
            const profile = document.profile as Record<string, unknown>;
            const candidate = current.collectionName === name
                ? profile.name === "rewrite-me"
                    ? { ...document, profile: { ...profile, name: "server-rewrite" } }
                    : { ...document, profile: { ...profile, serverOnly: true } }
                : document;
            return original.call(this, candidate, options);
        });
        const orders = core.forSubject({ userId: "u-provenance", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "scope.tenantId" },
        });

        try {
            await expect(orders.insertOne({ profile: { name: "caller" } } as never)).rejects.toMatchObject({
                code: "PERSISTED_STATE_INVALID",
                details: { kind: "unexpected-post-image-field", stage: "post-image-invariant" },
            });
            await expect(orders.insertOne({ profile: { name: "rewrite-me" } } as never)).rejects.toMatchObject({
                code: "PERSISTED_STATE_INVALID",
                details: {
                    kind: "unexpected-post-image-field",
                    stage: "post-image-invariant",
                    reason: "post-image changed caller-controlled values",
                },
            });
        } finally {
            injected.mockRestore();
        }
        expect(await native.countDocuments({})).toBe(0);
    });

    it("enforces maxAffected before bulk writes and executes the supported update operators in Mongo", async () => {
        const targetScope = scope("operators");
        const name = `orders_operators_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-operators", "operator", [
            { action: "create", resource: "db:orders" },
            { action: "read", resource: "db:orders" },
            { action: "update", resource: "db:orders" },
            { action: "delete", resource: "db:orders" },
        ]);
        const orders = core.forSubject({ userId: "u-operators", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });
        await orders.insertOne({
            group: "bounded", counter: 2, minimum: 10, maximum: 1,
            tags: ["a"], queue: ["x"], scores: [1, 2, 3], temporary: true,
        });
        await orders.insertOne({ group: "bounded", counter: 3 });

        await expect(orders.updateMany({ group: "bounded" }, { $set: { changed: true } }, { maxAffected: 1 }))
            .rejects.toMatchObject({ code: "DATA_BULK_SCOPE_MUTATION_UNSAFE" });
        expect(await orders.count({ changed: true })).toBe(0);
        await expect(orders.deleteMany({ group: "bounded" }, { maxAffected: 1 }))
            .rejects.toMatchObject({ code: "DATA_BULK_SCOPE_MUTATION_UNSAFE" });
        expect(await orders.count({ group: "bounded" })).toBe(2);

        await orders.updateOne({ counter: 2 }, {
            $set: { status: "ready" },
            $unset: { temporary: true },
            $inc: { counter: 1 },
            $min: { minimum: 5 },
            $max: { maximum: 5 },
            $addToSet: { tags: "b" },
            $push: { queue: { $each: ["y", "z"] } },
            $pull: { scores: { $gte: 2 } },
        });
        await orders.updateOne({ counter: 3, status: "ready" }, { $mul: { counter: 2 } });
        expect(await orders.findOne({ status: "ready" })).toMatchObject({
            counter: 6,
            minimum: 5,
            maximum: 5,
            tags: ["a", "b"],
            queue: ["x", "y", "z"],
            scores: [1],
        });
    });

    it("keeps bulk pre/post-image reads within the host findMaxLimit across mixed _id types", async () => {
        const targetScope = scope("bulk-host-budget");
        const name = `orders_bulk_budget_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-bulk-budget", "bulk-budget-writer", [
            { action: "read", resource: "db:orders" },
            { action: "update", resource: "db:orders" },
        ]);
        await rawCollection(context, name).insertMany(Array.from({ length: 98 }, (_, index) => ({
            ...(index === 0 ? { _id: "manual-bulk-id" } : {}),
            tenantId: targetScope.tenantId,
            sequence: index,
        })));
        const orders = core.forSubject({ userId: "u-bulk-budget", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        await expect(orders.updateMany({}, { $set: { changed: true } }, { maxAffected: 98 })).resolves.toMatchObject({
            matchedCount: 98,
        });
        expect(await orders.count({ changed: true })).toBe(98);

        await rawCollection(context, name).insertOne({ tenantId: targetScope.tenantId, sequence: 98 });
        await expect(orders.updateMany({}, { $set: { overflow: true } }, { maxAffected: 98 })).rejects.toMatchObject({
            code: "DATA_BULK_SCOPE_MUTATION_UNSAFE",
        });
        expect(await orders.count({ overflow: true })).toBe(0);
    });

    it("authorizes real $each item fields without treating update syntax as business fields", async () => {
        const targetScope = scope("update-field-ownership");
        const name = `orders_update_ownership_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-update-ownership", "update-ownership-writer", [
            { action: "read", resource: "db:orders" },
            { action: "update", resource: "db:orders" },
            { action: "update", resource: "db:orders:field:items" },
            { action: "update", resource: "db:orders:field:items.name" },
        ]);
        await rawCollection(context, name).insertOne({
            tenantId: targetScope.tenantId,
            items: [{ name: "old" }],
        });
        const orders = core.forSubject({ userId: "u-update-ownership", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        await expect(orders.updateOne({}, { $addToSet: { items: { $each: [{ name: "new" }] } } })).resolves.toMatchObject({ matchedCount: 1 });
        await expect(orders.updateOne({}, { $pull: { items: { name: "old" } } })).resolves.toMatchObject({ matchedCount: 1 });
        await expect(orders.updateOne({}, { $push: { items: { name: "blocked", secret: true } } })).rejects.toMatchObject({
            code: "FIELD_PERMISSION_DENIED",
        });
        expect(await orders.findOne()).toMatchObject({ items: [{ name: "new" }] });
    });

    it("fails collection/resource/scope contracts synchronously and keeps mode-none off the business collection", async () => {
        const targetScope = { ...scope("boundary"), appId: `app-${randomUUID()}` };
        const subject = core.forSubject({ userId: "u-none", scope: targetScope });
        const valid = { resource: "db:orders", scopeFields: { tenantId: "tenantId", appId: "appId" } } as const;

        for (const [name, options] of [
            ["", valid],
            ["system.users", valid],
            ["bad$name", valid],
            [`${PREFIX}_roles`, valid],
            ["orders", { ...valid, resource: "db:*" }],
            ["orders", { ...valid, resource: "db:orders:field:amount" }],
            ["orders", { resource: "db:orders", scopeFields: { tenantId: "tenantId" } }],
            ["orders", { resource: "db:orders", scopeFields: { tenantId: "scope", appId: "scope.appId" } }],
        ] as const) {
            expect(() => subject.data.collection(name, options as never)).toThrow(PermissionCoreError);
        }

        const name = `orders_none_${randomUUID().replaceAll("-", "")}`;
        const native = rawCollection(context, name);
        const prototype = Object.getPrototypeOf(native) as RawCollection;
        const originalFind = prototype.find;
        const originalCount = prototype.countDocuments;
        let businessReads = 0;
        const findSpy = vi.spyOn(prototype, "find").mockImplementation(function (this: RawCollection, filter, options) {
            if ((this as unknown as { collectionName?: string }).collectionName === name) businessReads += 1;
            return originalFind.call(this, filter, options);
        });
        const countSpy = vi.spyOn(prototype, "countDocuments").mockImplementation(function (this: RawCollection, filter) {
            if ((this as unknown as { collectionName?: string }).collectionName === name) businessReads += 1;
            return originalCount.call(this, filter);
        });
        const orders = subject.data.collection(name, valid);
        try {
            let queryRead = false;
            const query = new Proxy({}, {
                get() {
                    queryRead = true;
                    throw new Error("must not execute");
                },
            });
            expect(() => orders.findPage(query as never)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
            expect(queryRead).toBe(false);
            await expect(orders.find()).resolves.toEqual([]);
            await expect(orders.findOne()).resolves.toBeNull();
            await expect(orders.count()).resolves.toBe(0);
            await expect(orders.findAndCount()).resolves.toEqual({ data: [], total: 0 });
            await expect(orders.findPage()).resolves.toMatchObject({ items: [], pageInfo: { hasNext: false, hasPrev: false } });
            await expect(orders.insertOne({ value: 1 })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
            expect(businessReads).toBe(0);
        } finally {
            findSpy.mockRestore();
            countSpy.mockRestore();
        }
    });

    it("normalizes real ObjectId/Binary/Date readback and fails closed for unsupported BSON", async () => {
        const targetScope = scope("bson");
        const name = `orders_bson_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-bson", "bson-reader", [
            { action: "read", resource: "db:orders" },
            { action: "delete", resource: "db:orders" },
        ]);
        const when = new Date("2026-07-18T00:00:00.000Z");
        await rawCollection(context, name).insertOne({
            tenantId: targetScope.tenantId,
            kind: "supported",
            when,
            bytes: Buffer.from([1, 2, 3]),
        });
        const orders = core.forSubject({ userId: "u-bson", scope: targetScope }).data.collection<{
            _id: string;
            tenantId: string;
            kind: string;
            when?: Date;
            bytes?: Uint8Array;
        }>(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });
        const row = await orders.findOne({ kind: "supported" });
        expect(row?._id).toMatch(/^[a-f0-9]{24}$/u);
        expect(row?.when).toEqual(when);
        expect(row?.when).not.toBe(when);
        expect(row?.bytes).toBeInstanceOf(Uint8Array);
        expect(row?.bytes).toEqual(new Uint8Array([1, 2, 3]));

        await rawCollection(context, name).insertOne({
            tenantId: targetScope.tenantId,
            kind: "unsupported",
            pattern: /unsafe/u,
        });
        await expect(orders.find({ kind: "unsupported" })).rejects.toMatchObject({ code: "DATA_VALUE_UNSUPPORTED" });
        await expect(orders.deleteOne({ kind: "unsupported" })).rejects.toMatchObject({ code: "DATA_VALUE_UNSUPPORTED" });
        expect(await rawCollection(context, name).countDocuments({ kind: "unsupported" })).toBe(1);
    });

    it("rejects a transaction from another MonSQLize client without a partial write or aborting its owner", async () => {
        const targetScope = scope("foreign-transaction");
        const name = `orders_foreign_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-foreign", "foreign-creator", [{ action: "create", resource: "db:orders" }]);
        const orders = core.forSubject({ userId: "u-foreign", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });
        const foreign = new MonSQLize({
            type: "mongodb",
            databaseName: context.databaseName,
            config: { uri: context.uri },
        });
        await foreign.connect();
        const transaction = await foreign.startSession();
        await transaction.start();
        try {
            await expect(orders.insertOne({ value: "foreign" }, { transaction })).rejects.toMatchObject({
                code: "INVALID_ARGUMENT",
            });
            expect(transaction.session.inTransaction()).toBe(true);
            expect(await rawCollection(context, name).countDocuments({})).toBe(0);
        } finally {
            if (transaction.session.inTransaction()) await transaction.abort();
            await foreign.close();
        }
    });

    it("enforces insert post-image, update pre/post-image, and unconditional bulk field grants", async () => {
        const targetScope = scope("field-write-time");
        const name = `orders_field_write_${randomUUID().replaceAll("-", "")}`;
        await grant(core, targetScope, "u-field-write", "field-writer", [
            { action: "create", resource: "db:orders" },
            { action: "create", resource: "db:orders:field:status" },
            { action: "create", resource: "db:orders:field:amount", where: { field: "status", op: "eq", value: "draft" } },
            { action: "read", resource: "db:orders" },
            { action: "update", resource: "db:orders" },
            { action: "update", resource: "db:orders:field:status" },
            { action: "update", resource: "db:orders:field:amount", where: { field: "status", op: "eq", value: "draft" } },
        ]);
        const orders = core.forSubject({ userId: "u-field-write", scope: targetScope }).data.collection(name, {
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        });

        await orders.insertOne({ status: "draft", amount: 10 });
        await expect(orders.insertOne({ status: "published", amount: 10 })).rejects.toMatchObject({
            code: "FIELD_PERMISSION_DENIED",
            details: { reason: "field permission failed at post-image" },
        });
        expect(await orders.count()).toBe(1);

        await expect(orders.updateOne({}, { $set: { status: "published", amount: 20 } })).rejects.toMatchObject({
            code: "FIELD_PERMISSION_DENIED",
            details: { reason: "field permission failed at post-image", stage: "post-image" },
        });
        expect(await orders.findOne()).toMatchObject({ status: "draft", amount: 10 });

        await expect(orders.updateMany({}, { $set: { amount: 20 } }, { maxAffected: 10 })).rejects.toMatchObject({
            code: "FIELD_PERMISSION_DENIED",
        });
        expect(await orders.findOne()).toMatchObject({ status: "draft", amount: 10 });

        await rawCollection(context, name).insertOne({ tenantId: targetScope.tenantId, status: "published", amount: 5 });
        await expect(orders.updateOne({ status: "published" }, { $set: { amount: 6 } })).rejects.toMatchObject({
            code: "FIELD_PERMISSION_DENIED",
            details: { stage: "pre-image" },
        });
    });
});
