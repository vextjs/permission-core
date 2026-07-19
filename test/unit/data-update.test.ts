import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src/core/errors";
import { normalizeSafeMongoUpdate } from "../../src/data/update";
import { normalizeMongoValue } from "../../src/data/value";
import { canonicalByteLength } from "../../src/internal/canonical";

describe("SafeMongoUpdate", () => {
    it("accepts scalar pushes, the single $each form, and bounded pull predicates", () => {
        expect(normalizeSafeMongoUpdate({ $push: { tags: "paid" } }, [])).toMatchObject({
            update: { $push: { tags: "paid" } },
            touchedPaths: ["tags"],
        });
        expect(normalizeSafeMongoUpdate({ $addToSet: { tags: { $each: ["paid", "shipped"] } } }, [])).toMatchObject({
            update: { $addToSet: { tags: { $each: ["paid", "shipped"] } } },
        });
        expect(normalizeSafeMongoUpdate({ $pull: { scores: { $gte: 10, $lt: 20 } } }, [])).toMatchObject({
            update: { $pull: { scores: { $gte: 10, $lt: 20 } } },
        });
        expect(normalizeSafeMongoUpdate({ $pull: { items: { status: { $in: ["cancelled"] } } } }, [])).toMatchObject({
            update: { $pull: { items: { status: { $in: ["cancelled"] } } } },
        });
        expect(normalizeSafeMongoUpdate({
            $addToSet: { items: { $each: [{ name: "new", details: { code: "A" } }] } },
            $pull: { archived: { status: "expired" } },
        }, [])).toMatchObject({
            authorizationPaths: ["items", "items.name", "items.details", "items.details.code", "archived"],
        });
    });

    it.each([
        { $push: { tags: { $each: ["paid"], $slice: 1 } } },
        { $addToSet: { tags: { $each: [] } } },
        { $pull: { tags: { $regex: "paid" } } },
        { $pull: { tags: { $where: "return true" } } },
        { $pull: { tags: { $unknown: 1 } } },
        { $set: { tenantId: "other" } },
        { $set: { profile: {} }, $unset: { "profile.name": true } },
    ])("rejects unsafe or ambiguous update input %#", (update) => {
        const scopePaths = Object.hasOwn(update, "$set") && Object.hasOwn((update as { $set: object }).$set, "tenantId")
            ? ["tenantId"]
            : [];
        expect(() => normalizeSafeMongoUpdate(update as never, scopePaths)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
    });

    it("enforces the touched-path exact boundary", () => {
        const exact = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`field_${index}`, index]));
        expect(() => normalizeSafeMongoUpdate({ $set: exact }, [])).not.toThrow();
        expect(() => normalizeSafeMongoUpdate({ $set: { ...exact, overflow: true } }, [])).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "LIMIT_EXCEEDED" }),
        );
    });

    it("accepts the exact 64 KiB update boundary and rejects one byte over", () => {
        const emptyTail = normalizeSafeMongoUpdate({ $set: { left: "x".repeat(30_000), right: "" } }, []);
        const emptyBytes = canonicalByteLength(normalizeMongoValue(emptyTail.update, "caller-input", "update", false).canonical);
        const rightLength = 64 * 1024 - emptyBytes;
        expect(rightLength).toBeGreaterThanOrEqual(0);
        expect(rightLength).toBeLessThan(64_000);
        const exact = normalizeSafeMongoUpdate({ $set: { left: "x".repeat(30_000), right: "x".repeat(rightLength) } }, []);
        expect(canonicalByteLength(normalizeMongoValue(exact.update, "caller-input", "update", false).canonical)).toBe(64 * 1024);
        expect(() => normalizeSafeMongoUpdate({
            $set: { left: "x".repeat(30_000), right: "x".repeat(rightLength + 1) },
        }, [])).toThrowError(expect.objectContaining<Partial<PermissionCoreError>>({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "update-bytes" }),
        }));
    });

    it("rejects sparse or proxied $each arrays before evaluating their contents", () => {
        const sparse = new Array(2);
        sparse[1] = "value";
        let touched = false;
        const proxied = new Proxy(["value"], {
            get() {
                touched = true;
                throw new Error("must not execute");
            },
        });

        expect(() => normalizeSafeMongoUpdate({ $push: { items: { $each: sparse } } } as never, [])).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeSafeMongoUpdate({ $push: { items: { $each: proxied } } } as never, [])).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(touched).toBe(false);
    });

    it("rejects a proxied comparison operand before invoking its prototype trap", () => {
        let touched = false;
        const value = new Proxy({}, {
            getPrototypeOf() {
                touched = true;
                throw new Error("must not execute");
            },
        });

        expect(() => normalizeSafeMongoUpdate({ $min: { amount: value } } as never, [])).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(touched).toBe(false);
    });
});
