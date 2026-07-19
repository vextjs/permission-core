import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import {
    assertNonOverlappingPaths,
    collectDocumentPaths,
    declaredPathClosure,
    deleteDataPath,
    normalizeDataPath,
    pathsOverlap,
    readDataPath,
    writeDataPath,
} from "../../src/data/path";
import {
    BsonByteLimitError,
    BsonEncodingError,
    bsonDocumentByteLengthUpperBound,
} from "../../src/internal/bson-size";
import {
    assertOnlyKeys,
    assertPlainRecord,
    clonePolicyRecord,
    deepFreeze,
} from "../../src/internal/plain-data";

function expectPermissionError(run: () => unknown) {
    expect(run).toThrowError(PermissionCoreError);
}

describe("data path structural helpers", () => {
    it("normalizes path grammar and rejects unsafe lengths or segments", () => {
        expect(normalizeDataPath("profile.name", "path")).toBe("profile.name");
        for (const value of [null, "", "\ud800", "x".repeat(257), "0field", "field-name", "__proto__", Array.from({ length: 17 }, () => "a").join(".")]) {
            expectPermissionError(() => normalizeDataPath(value, "path"));
        }
    });

    it("computes path overlap and closure and rejects ambiguous declarations", () => {
        expect(pathsOverlap("profile", "profile.name")).toBe(true);
        expect(pathsOverlap("profile.name", "profile")).toBe(true);
        expect(pathsOverlap("profile.name", "profile.name")).toBe(true);
        expect(pathsOverlap("profile.name", "profile.age")).toBe(false);
        expect([...declaredPathClosure(["profile.name", "status"])]).toEqual(["profile", "profile.name", "status"]);
        expect(() => assertNonOverlappingPaths(["profile", "profile.name"], "paths")).toThrowError(PermissionCoreError);
        expect(() => assertNonOverlappingPaths(["profile.name", "status"], "paths")).not.toThrow();
    });

    it("reads, writes, and deletes paths without traversing accessors or scalar nodes", () => {
        const document: Record<string, unknown> = {};
        writeDataPath(document, "profile.name", "Ada");
        expect(readDataPath(document, "profile.name")).toEqual({ found: true, value: "Ada" });
        expect(readDataPath(document, "profile.missing")).toEqual({ found: false });
        expect(readDataPath({ profile: null }, "profile.name")).toEqual({ found: false });

        const accessor = {};
        Object.defineProperty(accessor, "profile", { enumerable: true, get: () => ({ name: "hidden" }) });
        expect(readDataPath(accessor, "profile.name")).toEqual({ found: false });
        expectPermissionError(() => writeDataPath({ profile: "scalar" }, "profile.name", "Ada"));

        deleteDataPath(document, "profile.name");
        expect(readDataPath(document, "profile.name")).toEqual({ found: false });
        expect(() => deleteDataPath({ profile: [] }, "profile.name")).not.toThrow();
        expect(() => deleteDataPath({}, "profile.name")).not.toThrow();
    });

    it("collects nested object and array authorization paths", () => {
        expect(collectDocumentPaths({
            profile: { name: "Ada" },
            items: [{ sku: "A" }, new Date("2026-01-01T00:00:00Z"), new Uint8Array([1])],
        })).toEqual(["profile", "profile.name", "items", "items.sku"]);
        expect(collectDocumentPaths(null)).toEqual([]);
        expect(collectDocumentPaths("value", "field")).toEqual(["field"]);
    });
});

describe("plain policy data guards", () => {
    it("rejects exotic records and unsupported keys without invoking accessors", () => {
        expect(assertPlainRecord(Object.create(null), "INVALID_ARGUMENT", "value")).toEqual({});
        expectPermissionError(() => assertPlainRecord([], "INVALID_ARGUMENT", "value"));
        expectPermissionError(() => assertPlainRecord(new Proxy({}, {}), "INVALID_ARGUMENT", "value"));
        expectPermissionError(() => assertPlainRecord(new Date(), "INVALID_ARGUMENT", "value"));
        expectPermissionError(() => assertPlainRecord({ [Symbol("key")]: true }, "INVALID_ARGUMENT", "value"));

        const malformed = {} as Record<string, unknown>;
        Object.defineProperty(malformed, "\ud800", { enumerable: true, value: true });
        expectPermissionError(() => assertPlainRecord(malformed, "INVALID_ARGUMENT", "value"));
        const forbidden = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(forbidden, "__proto__", { enumerable: true, value: true });
        expectPermissionError(() => assertPlainRecord(forbidden, "INVALID_ARGUMENT", "value"));
        const accessor = {};
        Object.defineProperty(accessor, "value", { enumerable: true, get: () => true });
        expectPermissionError(() => assertPlainRecord(accessor, "INVALID_ARGUMENT", "value"));
        expectPermissionError(() => assertOnlyKeys({ extra: true }, [], "INVALID_ARGUMENT", "value"));
    });

    it("clones supported policy values, normalizes negative zero, and freezes recursively", () => {
        const input = { nil: null, yes: true, no: false, text: "ok", number: -0, list: [1, "two"] };
        const cloned = clonePolicyRecord(input, "INVALID_ARGUMENT", "value");
        expect(Object.is(cloned.number, 0)).toBe(true);
        expect(Object.isFrozen(cloned)).toBe(true);
        expect(Object.isFrozen(cloned.list)).toBe(true);
        const nested = { child: { value: true } };
        expect(deepFreeze(nested)).toBe(nested);
        expect(Object.isFrozen(nested.child)).toBe(true);
    });

    it("rejects malformed, cyclic, deep, oversized, sparse, and unsupported policy values", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        let deep: Record<string, unknown> = { value: true };
        for (let index = 0; index < 13; index += 1) deep = { child: deep };
        const sparse = new Array(1);
        const tagged = [true] as boolean[] & { extra?: boolean };
        tagged.extra = true;
        const hidden = [true];
        Object.defineProperty(hidden, "0", { enumerable: false, value: true });

        for (const value of [
            { value: Number.NaN },
            { value: "\ud800" },
            { value: undefined },
            { value: 1n },
            cyclic,
            deep,
            { list: sparse },
            { list: tagged },
            { list: hidden },
            { list: new Proxy([true], {}) },
            { list: Array.from({ length: 1_025 }, () => true) },
            Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [`key${index}`, true])),
            { text: "x".repeat(70_000) },
        ]) {
            expectPermissionError(() => clonePolicyRecord(value, "INVALID_ARGUMENT", "value"));
        }
    });
});

describe("BSON byte upper-bound encoder", () => {
    it("accounts for primitive, nested, and dense array documents", () => {
        const bytes = bsonDocumentByteLengthUpperBound({
            nil: null,
            bool: true,
            int32: 1,
            double: 1.5,
            text: "ok",
            nested: { values: [1, false] },
        });
        expect(bytes).toBeGreaterThan(20);
        expect(() => bsonDocumentByteLengthUpperBound({ value: true }, bytes)).not.toThrow();
        expect(() => bsonDocumentByteLengthUpperBound({ value: true }, -1)).toThrow(TypeError);
        expect(() => bsonDocumentByteLengthUpperBound(null)).toThrow(BsonEncodingError);
        expect(() => bsonDocumentByteLengthUpperBound([])).toThrow(BsonEncodingError);
    });

    it("rejects malformed values, records, arrays, cycles, depth, and byte overflow", () => {
        const malformedKey = {} as Record<string, unknown>;
        Object.defineProperty(malformedKey, "\ud800", { enumerable: true, value: true });
        const nulKey = { "bad\u0000key": true };
        const symbolKey = { [Symbol("key")]: true };
        const hidden = {};
        Object.defineProperty(hidden, "value", { enumerable: false, value: true });
        const sparse = new Array(1);
        const tagged = [true] as boolean[] & { extra?: boolean };
        tagged.extra = true;
        const hiddenArray = [true];
        Object.defineProperty(hiddenArray, "0", { enumerable: false, value: true });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        let deep: Record<string, unknown> = { value: true };
        for (let index = 0; index < 101; index += 1) deep = { child: deep };

        for (const value of [
            malformedKey,
            nulKey,
            symbolKey,
            hidden,
            { value: Number.POSITIVE_INFINITY },
            { value: "\ud800" },
            { value: undefined },
            { value: new Date() },
            { value: new Proxy({}, {}) },
            { value: sparse },
            { value: tagged },
            { value: hiddenArray },
            cyclic,
            deep,
        ]) {
            expect(() => bsonDocumentByteLengthUpperBound(value)).toThrow(BsonEncodingError);
        }
        expect(() => bsonDocumentByteLengthUpperBound({ text: "large" }, 4)).toThrow(BsonByteLimitError);
    });
});
