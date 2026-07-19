import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src/core/errors";
import { normalizeSafeMongoFilter } from "../../src/data/filter";
import { canonicalByteLength } from "../../src/internal/canonical";

describe("SafeMongoFilter", () => {
    it("normalizes a closed Mongo-style grammar and records inference paths", () => {
        const input = {
            status: { $in: ["paid", "shipped"] },
            name: { $regex: "a.*", $options: "i" },
            items: { $elemMatch: { sku: "sku-1" } },
            $or: [{ amount: { $gte: 10 } }, { priority: true }],
        } as const;

        const normalized = normalizeSafeMongoFilter(input);

        expect(normalized.filter).toEqual({
            status: { $in: ["paid", "shipped"] },
            name: { $regex: "a\\.\\*", $options: "i" },
            items: { $elemMatch: { sku: "sku-1" } },
            $or: [{ amount: { $gte: 10 } }, { priority: true }],
        });
        expect(normalized.referencedPaths).toEqual([
            "status", "name", "items", "items.sku", "amount", "priority",
        ]);
    });

    it("canonicalizes duplicate set values without conflating tagged values", () => {
        const normalized = normalizeSafeMongoFilter({
            value: { $in: [1, 1, "1", new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z")] },
        });

        expect(normalized.filter).toEqual({
            value: { $in: [1, "1", new Date("2026-01-01T00:00:00.000Z")] },
        });
    });

    it("records nested inference paths inside literal objects and set operands", () => {
        const normalized = normalizeSafeMongoFilter({
            profile: { name: "shown", secret: "hidden" },
            candidates: { $in: [{ code: "A" }, { code: "B", nested: { value: 1 } }] },
        });

        expect(normalized.referencedPaths).toEqual([
            "profile", "profile.name", "profile.secret",
            "candidates", "candidates.code", "candidates.nested", "candidates.nested.value",
        ]);
    });

    it.each([
        [{ $where: "return true" }, "INVALID_FILTER"],
        [{ $and: [] }, "INVALID_FILTER"],
        [{ amount: { $gt: 1, literal: 2 } }, "INVALID_FILTER"],
        [{ name: { $regex: ".*", $options: "m" } }, "INVALID_FILTER"],
        [{ value: { $type: 2 } }, "INVALID_FILTER"],
        [{ value: { $not: { $not: { $eq: 1 } } } }, "INVALID_FILTER"],
        [{ value: { $elemMatch: { $or: [{ nested: 1 }] } } }, "INVALID_FILTER"],
        [Object.assign(Object.create({ inherited: true }), { value: 1 }), "INVALID_FILTER"],
        [new Proxy({ value: 1 }, {}), "INVALID_FILTER"],
    ])("rejects unsafe filter input %#", (input, code) => {
        expect(() => normalizeSafeMongoFilter(input as never)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: code as PermissionCoreError["code"] }),
        );
    });

    it("rejects depth overflow before any database path can run", () => {
        let exact: Record<string, unknown> = { value: 1 };
        for (let index = 0; index < 11; index += 1) exact = { $and: [exact] };
        expect(() => normalizeSafeMongoFilter(exact as never)).not.toThrow();
        const overflow = { $and: [exact] };
        expect(() => normalizeSafeMongoFilter(overflow as never)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "LIMIT_EXCEEDED" }),
        );
    });

    it("enforces exact collection limits and rejects one-over inputs", () => {
        const exactKeys = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field_${index}`, index]));
        expect(() => normalizeSafeMongoFilter(exactKeys)).not.toThrow();
        expect(() => normalizeSafeMongoFilter({ ...exactKeys, overflow: true })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_FILTER" }),
        );

        const exactLogical = { $or: Array.from({ length: 32 }, (_, index) => ({ value: index })) };
        expect(() => normalizeSafeMongoFilter(exactLogical)).not.toThrow();
        expect(() => normalizeSafeMongoFilter({ $or: [...exactLogical.$or, { value: 33 }] })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_FILTER" }),
        );

        expect(() => normalizeSafeMongoFilter({ name: { $regex: "x".repeat(128) } })).not.toThrow();
        expect(() => normalizeSafeMongoFilter({ name: { $regex: "x".repeat(129) } })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_FILTER" }),
        );

        const exactSet = Array.from({ length: 100 }, (_, index) => index);
        expect(() => normalizeSafeMongoFilter({ value: { $in: exactSet } })).not.toThrow();
        expect(() => normalizeSafeMongoFilter({ value: { $in: [...exactSet, 100] } })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_FILTER" }),
        );

        const exactNodeGroups = Array.from({ length: 8 }, (_, group) => ({
            $or: Array.from({ length: group === 7 ? 30 : 31 }, (_, index) => ({ [`field_${group}_${index}`]: index })),
        }));
        expect(() => normalizeSafeMongoFilter({ $or: exactNodeGroups })).not.toThrow();
        const overflowNodeGroups = exactNodeGroups.map((entry, index) => (
            index === 7 ? { $or: [...entry.$or, { overflow: true }] } : entry
        ));
        expect(() => normalizeSafeMongoFilter({ $or: overflowNodeGroups })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "LIMIT_EXCEEDED" }),
        );
    });

    it("rejects cyclic and sparse values", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const sparse = new Array(2);
        sparse[1] = "value";

        expect(() => normalizeSafeMongoFilter({ value: cyclic } as never)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeSafeMongoFilter({ value: { $in: sparse } } as never)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_FILTER" }),
        );
    });

    it("rejects a nested Proxy before invoking its prototype traps", () => {
        let touched = false;
        const nested = new Proxy({}, {
            getPrototypeOf() {
                touched = true;
                throw new Error("must not execute");
            },
        });

        expect(() => normalizeSafeMongoFilter({ value: nested } as never)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_FILTER" }),
        );
        expect(touched).toBe(false);
    });

    it("enforces the aggregate filter byte budget independently of per-value limits", () => {
        const chunk = "x".repeat(50_000);
        expect(() => normalizeSafeMongoFilter({ left: chunk, right: chunk })).not.toThrow();
        expect(() => normalizeSafeMongoFilter({ left: chunk, middle: chunk, right: chunk })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({
                code: "LIMIT_EXCEEDED",
                details: expect.objectContaining({ limitName: "safe-filter-bytes" }),
            }),
        );

        const emptyTail = normalizeSafeMongoFilter({ left: "x".repeat(60_000), right: "x".repeat(60_000), tail: "" });
        const tailLength = 128 * 1024 - canonicalByteLength(emptyTail.canonical);
        expect(tailLength).toBeGreaterThanOrEqual(0);
        expect(tailLength).toBeLessThan(60_000);
        const exact = normalizeSafeMongoFilter({
            left: "x".repeat(60_000),
            right: "x".repeat(60_000),
            tail: "x".repeat(tailLength),
        });
        expect(canonicalByteLength(exact.canonical)).toBe(128 * 1024);
        expect(() => normalizeSafeMongoFilter({
            left: "x".repeat(60_000),
            right: "x".repeat(60_000),
            tail: "x".repeat(tailLength + 1),
        })).toThrowError(expect.objectContaining<Partial<PermissionCoreError>>({ code: "LIMIT_EXCEEDED" }));
    });
});
