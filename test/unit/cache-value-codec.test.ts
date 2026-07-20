import { describe, expect, it } from "vitest";
import {
    MAX_SEMANTIC_CACHE_VALUE_BYTES,
    createSemanticCacheEnvelope,
    decodeSemanticCacheEnvelope,
    type SemanticSnapshotCodec,
} from "../../src/cache";

interface ExampleSnapshot {
    readonly label: string;
    readonly nested: { readonly allowed: boolean };
}

const codec: SemanticSnapshotCodec<ExampleSnapshot> = {
    encode: (value) => value,
    decode(value) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
        const record = value as Record<string, unknown>;
        if (Object.keys(record).sort().join(",") !== "label,nested" || typeof record.label !== "string") {
            throw new Error("invalid");
        }
        const nested = record.nested;
        if (nested === null || typeof nested !== "object" || Array.isArray(nested)) throw new Error("invalid");
        const nestedRecord = nested as Record<string, unknown>;
        if (Object.keys(nestedRecord).join(",") !== "allowed" || typeof nestedRecord.allowed !== "boolean") {
            throw new Error("invalid");
        }
        return Object.freeze({ label: record.label, nested: Object.freeze({ allowed: nestedRecord.allowed }) });
    },
};

describe("semantic cache value envelope", () => {
    it("binds the family, key, revisions and TTL while returning an independent clone", async () => {
        const source = { label: "orders", nested: { allowed: true } };
        const created = await createSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            revisions: { rbacRevision: 7, menuRevision: 9 },
            ttlMs: 1_000,
            value: source,
            codec,
            now: 10_000,
        });
        source.nested.allowed = false;

        const decoded = await decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            ttlMs: 1_000,
            value: created.envelope,
            codec,
            now: 10_999,
        });

        expect(decoded).toMatchObject({
            expired: false,
            revisions: { rbacRevision: 7, menuRevision: 9 },
            value: { label: "orders", nested: { allowed: true } },
        });
        expect(decoded.value).not.toBe(source);
        expect(decoded.value.nested).not.toBe(source.nested);
        expect(Object.isFrozen(decoded.value)).toBe(true);
    });

    it("rejects cross-key swaps, payload tampering and unknown envelope fields", async () => {
        const created = await createSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            revisions: { rbacRevision: 1, menuRevision: 2 },
            ttlMs: 1_000,
            value: { label: "orders", nested: { allowed: true } },
            codec,
            now: 1,
        });
        await expect(decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-b",
            family: "permissions",
            ttlMs: 1_000,
            value: created.envelope,
            codec,
            now: 2,
        })).rejects.toThrow(/digest/u);
        await expect(decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            ttlMs: 1_000,
            value: { ...created.envelope, snapshot: { label: "orders", nested: { allowed: false } } },
            codec,
            now: 2,
        })).rejects.toThrow(/digest/u);
        await expect(decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            ttlMs: 1_000,
            value: { ...created.envelope, extra: true },
            codec,
            now: 2,
        })).rejects.toThrow(/not supported/u);
    });

    it("marks a valid value expired without extending its configured lifetime", async () => {
        const created = await createSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            revisions: { rbacRevision: 0, menuRevision: 0 },
            ttlMs: 100,
            value: { label: "empty", nested: { allowed: false } },
            codec,
            now: 50,
        });
        const decoded = await decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            ttlMs: 100,
            value: created.envelope,
            codec,
            now: 150,
        });
        expect(decoded.expired).toBe(true);
        await expect(decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            ttlMs: 101,
            value: created.envelope,
            codec,
            now: 100,
        })).rejects.toThrow(/configured TTL/u);
    });

    it("rejects an otherwise valid envelope created in the future", async () => {
        const created = await createSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            revisions: { rbacRevision: 0, menuRevision: 0 },
            ttlMs: 100,
            value: { label: "future", nested: { allowed: false } },
            codec,
            now: 101,
        });
        await expect(decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            ttlMs: 100,
            value: created.envelope,
            codec,
            now: 100,
        })).rejects.toThrow(/future/u);
    });

    it("makes the exact and one-over four MiB cache-value boundary directly observable", async () => {
        const empty = await createSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            revisions: { rbacRevision: 0, menuRevision: 0 },
            ttlMs: 1_000,
            value: { label: "", nested: { allowed: false } },
            codec,
            now: 1,
        });
        const exactLength = MAX_SEMANTIC_CACHE_VALUE_BYTES - empty.bytes;
        const exact = await createSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            revisions: { rbacRevision: 0, menuRevision: 0 },
            ttlMs: 1_000,
            value: { label: "x".repeat(exactLength), nested: { allowed: false } },
            codec,
            now: 1,
        });
        const oneOver = await createSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            revisions: { rbacRevision: 0, menuRevision: 0 },
            ttlMs: 1_000,
            value: { label: "x".repeat(exactLength + 1), nested: { allowed: false } },
            codec,
            now: 1,
        });
        expect(exact.bytes).toBe(MAX_SEMANTIC_CACHE_VALUE_BYTES);
        expect(oneOver.bytes).toBe(MAX_SEMANTIC_CACHE_VALUE_BYTES + 1);
        await expect(decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            ttlMs: 1_000,
            value: oneOver.envelope,
            codec,
            now: 2,
        })).rejects.toThrow(/budget/u);
    }, 30_000);

    it("rejects snapshots that decode but are not in canonical codec form", async () => {
        const normalizingCodec: SemanticSnapshotCodec<{ label: string }> = {
            encode: (value) => ({ label: value.label }),
            decode(value) {
                if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
                const label = (value as Record<string, unknown>).label;
                if (typeof label !== "string") throw new Error("invalid");
                return { label: label.trim() };
            },
        };
        const created = await createSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            revisions: { rbacRevision: 1, menuRevision: 1 },
            ttlMs: 100,
            value: { label: " orders " },
            codec: normalizingCodec,
            now: 1,
        });
        await expect(decodeSemanticCacheEnvelope({
            key: "permission-core:v2:test:key-a",
            family: "permissions",
            ttlMs: 100,
            value: created.envelope,
            codec: normalizingCodec,
            now: 2,
        })).rejects.toThrow(/not canonical/u);
    });
});
