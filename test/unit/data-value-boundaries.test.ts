import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import {
    normalizeCallerDocument,
    normalizeMongoValue,
    normalizePersistedDocument,
} from "../../src/data/value";

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

describe("Mongo value defensive branches", () => {
    it("normalizes every supported primitive identity", () => {
        expect(normalizeMongoValue(null, "caller-input", "value").value).toBeNull();
        expect(normalizeMongoValue(true, "caller-input", "value").value).toBe(true);
        expect(Object.is(normalizeMongoValue(-0, "caller-input", "value").value, 0)).toBe(true);
        expect(normalizeMongoValue("text", "caller-input", "value").value).toBe("text");
        expect(normalizeMongoValue(new Date("2026-01-01T00:00:00Z"), "caller-input", "value").value)
            .toEqual(new Date("2026-01-01T00:00:00Z"));
        expect(normalizeMongoValue(Buffer.from([1, 2]), "caller-input", "value").value).toEqual(new Uint8Array([1, 2]));
    });

    it("rejects unsupported primitives, malformed strings, numbers, and dates", () => {
        for (const value of [undefined, Symbol("value"), 1n, Number.NaN, Number.POSITIVE_INFINITY, "\ud800", new Date(Number.NaN)]) {
            expectPermissionError(() => normalizeMongoValue(value, "caller-input", "value"));
        }
    });

    it("rejects caller object keys, descriptors, classes, arrays, cycles, and limits", () => {
        const symbolKey = { [Symbol("key")]: true };
        const malformedKey = {} as Record<string, unknown>;
        Object.defineProperty(malformedKey, "\ud800", { enumerable: true, value: true });
        const forbiddenKey = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(forbiddenKey, "constructor", { enumerable: true, value: true });
        const accessor = {};
        Object.defineProperty(accessor, "value", { enumerable: true, get: () => true });
        const tagged = [true] as boolean[] & { extra?: boolean };
        tagged.extra = true;
        const hidden = [true];
        Object.defineProperty(hidden, "0", { enumerable: false, value: true });
        const sparse = new Array(1);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        let deep: Record<string, unknown> = { value: true };
        for (let index = 0; index < 13; index += 1) deep = { child: deep };

        class DomainValue {
            value = true;
        }
        for (const value of [
            symbolKey,
            malformedKey,
            forbiddenKey,
            accessor,
            tagged,
            hidden,
            sparse,
            cyclic,
            deep,
            new DomainValue(),
            Array.from({ length: 1_025 }, () => true),
            Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [`key${index}`, true])),
        ]) {
            expectPermissionError(() => normalizeMongoValue(value, "caller-input", "value"));
        }
    });

    it("normalizes trusted ObjectId/Binary shapes and rejects malformed BSON values", () => {
        const objectId = Object.create({
            _bsontype: "ObjectId",
            toHexString: () => "ABCDEF0123456789ABCDEF01",
        });
        expect(normalizeMongoValue(objectId, "persisted-data-state", "value").value)
            .toBe("abcdef0123456789abcdef01");

        const missingHex = Object.create({ _bsontype: "ObjectId" });
        const badHex = Object.create({ _bsontype: "ObjectId", toHexString: () => "bad" });
        const binaryBuffer = Object.create({ _bsontype: "Binary", buffer: new Uint8Array([1, 2]) });
        const binaryValue = Object.create({ _bsontype: "Binary", value: () => new Uint8Array([3, 4]) });
        const badBinary = Object.create({ _bsontype: "Binary", value: () => "bad" });
        expect(normalizeMongoValue(binaryBuffer, "persisted-data-state", "value").value).toEqual(new Uint8Array([1, 2]));
        expect(normalizeMongoValue(binaryValue, "persisted-data-state", "value").value).toEqual(new Uint8Array([3, 4]));
        for (const value of [missingHex, badHex, badBinary]) {
            expectPermissionError(() => normalizeMongoValue(value, "persisted-data-state", "value"), "DATA_VALUE_UNSUPPORTED");
        }
    });

    it("requires plain root documents for caller and persisted paths", () => {
        for (const value of [null, [], new Date(), new Uint8Array([1])]) {
            expectPermissionError(() => normalizeCallerDocument(value, "document"), "INVALID_ARGUMENT");
            expectPermissionError(() => normalizePersistedDocument(value), "DATA_VALUE_UNSUPPORTED");
        }
        expect(normalizeCallerDocument({ value: true }, "document").value).toEqual({ value: true });
        expect(normalizePersistedDocument({ value: true }).value).toEqual({ value: true });
    });
});
