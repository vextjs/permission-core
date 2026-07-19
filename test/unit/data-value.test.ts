import { describe, expect, it, vi } from "vitest";
import { PermissionCoreError } from "../../src/core/errors";
import { canonicalByteLength } from "../../src/internal/canonical";
import {
    normalizeCallerDocument,
    normalizeMongoValue,
    normalizePersistedDocument,
} from "../../src/data/value";

describe("Mongo value normalization", () => {
    it("clones supported mutable values and keeps tagged canonical identities distinct", () => {
        const date = new Date("2026-01-01T00:00:00.000Z");
        const bytes = new Uint8Array([1, 2, 3]);
        const normalized = normalizeCallerDocument({ date, bytes, text: "2026-01-01T00:00:00.000Z" }, "document");

        expect(normalized.value.date).toEqual(date);
        expect(normalized.value.date).not.toBe(date);
        expect(normalized.value.bytes).toEqual(bytes);
        expect(normalized.value.bytes).not.toBe(bytes);
        expect(normalized.canonical).not.toEqual(normalizeMongoValue({
            date: date.toISOString(),
            bytes: Buffer.from(bytes).toString("base64"),
            text: date.toISOString(),
        }, "caller-input", "document").canonical);
    });

    it("rejects caller BSON impersonation without invoking its codec method", () => {
        const toHexString = vi.fn(() => "0123456789abcdef01234567");
        class FakeObjectId {
            readonly _bsontype = "ObjectId";
            readonly toHexString = toHexString;
        }

        expect(() => normalizeMongoValue(new FakeObjectId(), "caller-input", "value")).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(toHexString).not.toHaveBeenCalled();
    });

    it("normalizes trusted driver-like BSON once and rejects unknown BSON classes", () => {
        const prototype = {
            _bsontype: "ObjectId",
            toHexString() {
                return "ABCDEF0123456789ABCDEF01";
            },
        };
        const objectId = Object.create(prototype) as object;
        expect(normalizePersistedDocument({ _id: objectId }).value).toEqual({
            _id: "abcdef0123456789abcdef01",
        });

        expect(() => normalizePersistedDocument({ value: Object.assign(Object.create({ _bsontype: "Decimal128" }), {}) })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "DATA_VALUE_UNSUPPORTED" }),
        );
    });

    it("rejects Proxy input before reading user properties", () => {
        const get = vi.fn(() => {
            throw new Error("must not execute");
        });
        const proxy = new Proxy({}, { get });
        expect(() => normalizeMongoValue(proxy, "caller-input", "value")).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(get).not.toHaveBeenCalled();
    });

    it("enforces per-value and aggregate document byte budgets separately", () => {
        expect(() => normalizeCallerDocument({ value: "x".repeat(70_000) }, "document")).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({
                code: "LIMIT_EXCEEDED",
                details: expect.objectContaining({ limitName: "mongo-value-bytes" }),
            }),
        );

        const document = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [
            `field_${index}`,
            "x".repeat(65_000),
        ]));
        expect(() => normalizeCallerDocument(document, "document")).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({
                code: "LIMIT_EXCEEDED",
                details: expect.objectContaining({ limitName: "mongo-document-bytes" }),
            }),
        );
    });

    it("accepts the exact 8 MiB canonical document boundary and rejects one byte over", () => {
        const target = 8 * 1024 * 1024;
        const base = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [
            `field_${index}`,
            "x".repeat(65_000),
        ]));
        const emptyTail = { ...base, tail: "" };
        const emptyBytes = canonicalByteLength(normalizeMongoValue(emptyTail, "caller-input", "document", false).canonical);
        const tailLength = target - emptyBytes;
        expect(tailLength).toBeGreaterThanOrEqual(0);
        expect(tailLength).toBeLessThanOrEqual(65_000);
        const exact = { ...base, tail: "x".repeat(tailLength) };
        expect(canonicalByteLength(normalizeMongoValue(exact, "caller-input", "document", false).canonical)).toBe(target);
        expect(() => normalizeCallerDocument(exact, "document")).not.toThrow();
        expect(() => normalizeCallerDocument({ ...base, tail: "x".repeat(tailLength + 1) }, "document")).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({
                code: "LIMIT_EXCEEDED",
                details: expect.objectContaining({ limitName: "mongo-document-bytes" }),
            }),
        );
    });

    it("accepts the exact 64 KiB canonical value boundary and rejects one byte over", () => {
        const target = 64 * 1024;
        const emptyBytes = canonicalByteLength(normalizeMongoValue("", "caller-input", "value", false).canonical);
        const exact = "x".repeat(target - emptyBytes);
        expect(canonicalByteLength(normalizeMongoValue(exact, "caller-input", "value").canonical)).toBe(target);
        expect(() => normalizeMongoValue(`${exact}x`, "caller-input", "value")).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({
                code: "LIMIT_EXCEEDED",
                details: expect.objectContaining({ limitName: "mongo-value-bytes" }),
            }),
        );
    });
});
