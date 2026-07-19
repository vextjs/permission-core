import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { normalizeSafeMongoFilter } from "../../src/data/filter";
import {
    assertActiveTransaction,
    normalizeAuthorizedCollectionOptions,
    normalizeBulkOptions,
    normalizeCountOptions,
    normalizePageQuery,
    normalizeReadOptions,
    normalizeTransactionOptions,
} from "../../src/data/options";
import { normalizeSafeMongoUpdate } from "../../src/data/update";

const limits = { findMaxLimit: 200, maxTimeMS: 5_000 } as const;

function expectPermissionError(run: () => unknown, code?: string) {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionCoreError);
    if (code) expect(caught).toMatchObject({ code });
}

function transaction(active = true) {
    return {
        state: active ? "active" : "committed",
        abort() {},
        session: { inTransaction: () => active },
    };
}

describe("safe Mongo filter operator boundaries", () => {
    it("normalizes all bounded scalar operator forms", () => {
        const normalized = normalizeSafeMongoFilter({
            exists: { $exists: true },
            type: { $type: "string" },
            size: { $size: 0 },
            not: { $not: { $eq: "blocked" } },
            all: { $all: ["a", "b"] },
            norRoot: { $ne: null },
            $nor: [{ disabled: true }],
        });
        expect(normalized.filter).toMatchObject({
            exists: { $exists: true },
            type: { $type: "string" },
            size: { $size: 0 },
        });
    });

    it("rejects malformed exists/type/options/not/size/elemMatch contracts", () => {
        const invalid = [
            { value: { $exists: 1 } },
            { value: { $type: "decimal" } },
            { value: { $options: "i" } },
            { value: { $not: { $options: "i", $regex: "x" } } },
            { value: { $size: -1 } },
            { value: { $size: 1_001 } },
            { value: { $elemMatch: {} } },
            { value: { $elemMatch: { $or: [{ nested: true }] } } },
            { value: { $in: [{ $eq: 1 }] } },
            { value: { $eq: 1, literal: 2 } },
        ];
        for (const value of invalid) expectPermissionError(() => normalizeSafeMongoFilter(value as never), "INVALID_FILTER");
    });
});

describe("safe Mongo update operator boundaries", () => {
    it("normalizes unset, arithmetic, comparison, push, and scalar pull operands", () => {
        const normalized = normalizeSafeMongoUpdate({
            $unset: { removed: true },
            $inc: { count: -0 },
            $mul: { amount: 2 },
            $min: { floor: 1, dateFloor: new Date("2026-01-01T00:00:00Z") },
            $max: { label: "z" },
            $push: { tags: { $each: ["a", "b"] } },
            $pull: { obsolete: "legacy" },
        }, []);
        expect(Object.is(normalized.update.$inc?.count, 0)).toBe(true);
        expect(normalized.touchedPaths).toContain("obsolete");
    });

    it("rejects malformed record descriptors and unsupported operator envelopes", () => {
        class Exotic {
            $set = { value: true };
        }
        const accessor = {};
        Object.defineProperty(accessor, "$set", { enumerable: true, get: () => ({ value: true }) });
        const symbol = { [Symbol("operator")]: { value: true } };
        for (const value of [{}, { $rename: { old: "new" } }, new Exotic(), accessor, symbol]) {
            expectPermissionError(() => normalizeSafeMongoUpdate(value as never, []));
        }
        expectPermissionError(() => normalizeSafeMongoUpdate({ $set: {} }, []));
    });

    it("rejects invalid operator operands, deep pull predicates, and overlapping paths", () => {
        let deep: Record<string, unknown> = { value: true };
        for (let index = 0; index < 6; index += 1) deep = { nested: deep };
        const invalid = [
            { $unset: { value: false } },
            { $inc: { value: "1" } },
            { $mul: { value: Number.NaN } },
            { $min: { value: new Date(Number.NaN) } },
            { $max: { value: {} } },
            { $push: { value: { $each: Array.from({ length: 101 }, () => true) } } },
            { $pull: { value: {} } },
            { $pull: { value: deep } },
            { $set: { profile: {} }, $inc: { "profile.count": 1 } },
        ];
        for (const value of invalid) expectPermissionError(() => normalizeSafeMongoUpdate(value as never, []));
        expectPermissionError(() => normalizeSafeMongoUpdate({ $set: { "scope.tenantId": "other" } }, ["scope"]));
    });
});

describe("authorized collection option boundaries", () => {
    it("normalizes complete collection/read/page/count/transaction/bulk options", () => {
        expect(normalizeAuthorizedCollectionOptions({
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        }, { tenantId: "tenant-a" })).toMatchObject({ scopePaths: ["tenantId"] });

        const active = transaction();
        expect(() => assertActiveTransaction(active)).not.toThrow();
        expect(normalizeReadOptions({
            projection: { shown: 1, _id: 0 },
            sort: { amount: -1, _id: -1 },
            transaction: active as never,
        }, limits)).toMatchObject({ projection: { mode: "include", includeId: false } });
        expect(normalizePageQuery({ first: 10, after: "cursor", totals: true, filter: { status: "paid" } }, limits))
            .toMatchObject({ direction: "forward", cursor: "cursor", totals: true, filter: { status: "paid" } });
        expect(normalizeCountOptions({ maxTimeMS: 100 }, limits)).toMatchObject({ limit: 50, maxTimeMS: 100 });
        expect(normalizeTransactionOptions({ transaction: active as never })).toHaveProperty("transaction", active);
        expect(normalizeBulkOptions({ maxAffected: 1_000, transaction: active as never })).toMatchObject({ maxAffected: 1_000 });
    });

    it("normalizes all/exclude projections and stable sort tie-break directions", () => {
        expect(normalizeReadOptions({ projection: {} }, limits).projection).toEqual({ mode: "all", paths: [] });
        expect(normalizeReadOptions({ projection: { secret: 0, _id: 1 } }, limits).projection)
            .toEqual({ mode: "exclude", paths: ["secret"], includeId: true });
        expect(normalizeReadOptions({ projection: ["_id", "name"] }, limits).projection.includeId).toBe(true);
        expect(normalizeReadOptions({ sort: { amount: -1 } }, limits).sortEntries).toEqual([["amount", -1], ["_id", -1]]);
    });

    it("rejects malformed collection, projection, sort, and pagination contracts", () => {
        expectPermissionError(() => normalizeAuthorizedCollectionOptions({ resource: "api:orders", scopeFields: {} } as never, { tenantId: "t" }));
        expectPermissionError(() => normalizeAuthorizedCollectionOptions({ resource: "db:orders", scopeFields: {} } as never, { tenantId: "t" }));
        const invalidReads = [
            { projection: ["profile", "profile.name"] },
            { projection: ["name", "name"] },
            { projection: { shown: 1, hidden: 0 } },
            { projection: { shown: 2 } },
            { sort: {} },
            { sort: { amount: 0 } },
            { sort: { _id: 1, amount: 1 } },
            { sort: { profile: 1, "profile.name": 1 } },
        ];
        for (const value of invalidReads) expectPermissionError(() => normalizeReadOptions(value as never, limits));
        expectPermissionError(() => normalizeCountOptions({ limit: 1 } as never, limits));
        expectPermissionError(() => normalizePageQuery({ after: 1 } as never, limits));
        expectPermissionError(() => normalizePageQuery({ last: 10, before: 1 } as never, limits));
        expectPermissionError(() => normalizePageQuery({ first: 10, totals: "yes" } as never, limits));
    });

    it("rejects inactive transaction shapes, invalid bulk limits, and unsafe option descriptors", () => {
        for (const value of [
            transaction(false),
            { state: "active", session: { inTransaction: () => true } },
            { state: "active", abort() {}, session: null },
            { state: "active", abort() {}, session: {} },
            { state: "active", abort() {}, session: { inTransaction: () => false } },
        ]) {
            expectPermissionError(() => assertActiveTransaction(value));
        }
        for (const maxAffected of [0, 1_001, 1.5, "1"]) {
            expectPermissionError(() => normalizeBulkOptions({ maxAffected } as never));
        }
        const hidden = {};
        Object.defineProperty(hidden, "transaction", { enumerable: false, value: transaction() });
        expectPermissionError(() => normalizeTransactionOptions(hidden as never));
    });
});
