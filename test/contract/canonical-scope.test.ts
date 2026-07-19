import { describe, expect, it } from "vitest";
import {
    canonicalByteLength,
    canonicalString,
    digestCanonical,
} from "../../src/internal/canonical";
import {
    createContextFingerprint,
    createScopeKey,
    normalizePolicyContext,
    normalizeScope,
    normalizeSubject,
} from "../../src/scope";

describe("canonical and scope contracts", () => {
    it("uses stable UTF-8 key ordering, finite numbers, and 43-char digests", () => {
        expect(canonicalString({ b: 1, a: -0 })).toBe('{"a":0,"b":1}');
        expect(digestCanonical({ b: 1, a: -0 })).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(() => canonicalString({ value: Number.NaN })).toThrow("non-finite");
        expect(() => canonicalString({ value: new Date() })).toThrow("plain object");
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(() => canonicalString(cycle)).toThrow("cycle");
    });

    it("normalizes scope IDs without delimiter-based identity", () => {
        const left = normalizeScope({ tenantId: " tenant|a ", appId: "app::1" });
        const right = normalizeScope({ appId: "app::1", tenantId: "tenant|a" });
        expect(left).toEqual(right);
        expect(createScopeKey(left)).toBe(createScopeKey(right));
        expect(createScopeKey(left)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(Object.isFrozen(left)).toBe(true);
    });

    it("copies and freezes trusted subjects while rejecting role injection", () => {
        const claims = { merchant: { id: "m-1" }, flags: ["reader"] };
        const subject = normalizeSubject({
            userId: " u-1 ",
            scope: { tenantId: "tenant-a" },
            claims,
        });
        claims.merchant.id = "changed";
        claims.flags.push("admin");

        expect(subject).toEqual({
            userId: "u-1",
            scope: { tenantId: "tenant-a" },
            claims: { merchant: { id: "m-1" }, flags: ["reader"] },
        });
        expect(Object.isFrozen(subject.claims)).toBe(true);
        expect(Object.isFrozen(subject.claims?.merchant)).toBe(true);
        expect(() => normalizeSubject({
            userId: "u-1",
            scope: { tenantId: "tenant-a" },
            roles: ["admin"],
        } as never)).toThrowError(expect.objectContaining({ code: "INVALID_SUBJECT" }));
    });

    it("rejects controls, prototype keys, cycles, and policy budget overflow", () => {
        expect(() => normalizeScope({ tenantId: "tenant\u0000a" })).toThrowError(expect.objectContaining({ code: "INVALID_SUBJECT" }));
        expect(() => normalizeScope({ tenantId: "constructor" })).toThrowError(expect.objectContaining({ code: "INVALID_SUBJECT" }));

        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(() => normalizePolicyContext(cycle as never)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
        expect(() => normalizePolicyContext({ large: "x".repeat(65 * 1024) })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
        expect(() => normalizePolicyContext({ aggregate: Array.from({ length: 1024 }, () => "x".repeat(100)) })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
        expect(() => normalizeScope(new Proxy({ tenantId: "tenant-a" }, {}) as never)).toThrowError(expect.objectContaining({ code: "INVALID_SUBJECT" }));
    });

    it("rejects sparse arrays and non-index array properties before hashing", () => {
        const sparse = new Array(2);
        sparse[1] = "value";
        const extended = ["value"] as string[] & { role?: string };
        extended.role = "admin";

        expect(() => canonicalString(sparse)).toThrow("sparse array");
        expect(() => canonicalString(extended)).toThrow("non-index array property");
        expect(() => normalizePolicyContext({ sparse })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
        expect(() => normalizePolicyContext({ extended })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    });

    it("rejects Proxy values before reflection executes a trap", () => {
        let trapCalls = 0;
        const value = new Proxy({ alpha: 1 }, {
            ownKeys() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });

        expect(() => canonicalString(value)).toThrowError(expect.objectContaining({
            name: "CanonicalEncodingError",
            message: expect.stringContaining("Proxy"),
        }));
        expect(() => digestCanonical(value)).toThrowError(expect.objectContaining({
            name: "CanonicalEncodingError",
            message: expect.stringContaining("Proxy"),
        }));
        expect(trapCalls).toBe(0);
    });

    it("rejects unpaired UTF-16 surrogates before UTF-8 identity or hashing", () => {
        const high = "\ud800";
        const low = "\udc00";
        const malformedKey = { [high]: "value" };

        expect(() => canonicalString(high)).toThrow("unpaired UTF-16 surrogate");
        expect(() => canonicalString(low)).toThrow("unpaired UTF-16 surrogate");
        expect(() => canonicalString(malformedKey)).toThrow("object key");
        expect(() => normalizeScope({ tenantId: `tenant-${high}` })).toThrowError(expect.objectContaining({ code: "INVALID_SUBJECT" }));
        expect(() => normalizeSubject({
            userId: "u-1",
            scope: { tenantId: "tenant-a" },
            claims: { name: high },
        })).toThrowError(expect.objectContaining({ code: "INVALID_SUBJECT" }));
        expect(() => normalizePolicyContext(malformedKey)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
        expect(canonicalString("\ud83d\ude00")).toBe('"😀"');
    });

    it("fingerprints the frozen canonical context", () => {
        const first = createContextFingerprint({ request: { channel: "admin" }, n: -0 });
        const second = createContextFingerprint({ n: 0, request: { channel: "admin" } });
        expect(first).toBe(second);
        expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    });

    it("measures canonical bytes incrementally with an exact one-over boundary", () => {
        const value = { alpha: ["中", 1, true, null], beta: "x" };
        const exact = Buffer.byteLength(canonicalString(value), "utf8");

        expect(canonicalByteLength(value)).toBe(exact);
        expect(canonicalByteLength(value, exact)).toBe(exact);
        expect(() => canonicalByteLength(value, exact - 1)).toThrow(`exceeds ${exact - 1}`);
        expect(() => canonicalByteLength(value, -1)).toThrow(TypeError);
    });

    it("streams JSON string escaping without splitting astral characters", () => {
        const value = `\"\\\b\f\n\r\t\u0000${"x".repeat(4095)}😀tail`;
        const expected = JSON.stringify(value);

        expect(canonicalString(value)).toBe(expected);
        expect(canonicalByteLength(value)).toBe(Buffer.byteLength(expected, "utf8"));
    });
});
