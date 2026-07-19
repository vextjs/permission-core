import { describe, expect, it, vi } from "vitest";
import { createSubjectDataRuntime } from "../../src/data/authorized-collection";
import { normalizeSafeMongoFilter } from "../../src/data/filter";
import { normalizePageQuery } from "../../src/data/options";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import { createMonSQLizeStub } from "../contract/helpers/monsqlize-stub";

const subject = {
    userId: "cursor-user",
    scope: { tenantId: "cursor-tenant" },
    claims: { region: "east" },
} as const;

const run = <T>(operation: () => Promise<T>) => operation();

function fixture() {
    const stub = createMonSQLizeStub();
    const repository = {
        findMaxLimit: 100,
        namespaces: {
            roles: { collection: "permission_core_roles" },
            scopeState: { collection: "permission_core_scope_state" },
        },
        getScopeStateNamespace: () => ({ db: "test-db", collection: "permission_core_scope_state" }),
        withTransaction: vi.fn(),
    };
    const runtime = createSubjectDataRuntime({
        monsqlize: stub.instance,
        repository,
        queryService: {} as never,
        schemes: new ResourceSchemeRegistry(),
        subject,
        context: { request: { region: "east" } },
        run,
        coreNamespaceHash: digestCanonical({ namespace: "data-cursor-boundaries" }),
        tokenSecret: new Uint8Array(Buffer.from("data-cursor-boundary-secret-32-bytes!", "utf8")),
        maxTimeMS: 5_000,
    } as never);
    const collection = runtime.collection("orders", {
        resource: "db:orders",
        scopeFields: { tenantId: "tenantId" },
    });
    const access = collection as unknown as {
        cursorCodec: { encode(payload: Readonly<Record<string, unknown>>): string };
        cursorBinding(
            business: ReturnType<typeof normalizeSafeMongoFilter>,
            page: ReturnType<typeof normalizePageQuery>,
        ): Readonly<Record<string, string>>;
        decodeCursor(
            token: string,
            page: ReturnType<typeof normalizePageQuery>,
            binding: Readonly<Record<string, string>>,
        ): unknown;
        restoreAnchorValue(path: string, canonical: unknown): unknown;
        anchorCanonicalValue(path: string, value: unknown): unknown;
        rememberBsonCodec(value: unknown): void;
        anchorFromRaw(
            raw: Readonly<Record<string, unknown>>,
            sort: readonly (readonly [string, 1 | -1])[],
            expectedTypes: readonly string[],
        ): unknown;
    };
    const page = normalizePageQuery({ first: 10, sort: { _id: 1 } }, { findMaxLimit: 100, maxTimeMS: 5_000 });
    const binding = access.cursorBinding(normalizeSafeMongoFilter(undefined), page);
    return { access, binding, collection, page, repository, stub };
}

function payload(binding: Readonly<Record<string, string>>, now: number) {
    return {
        purpose: "pc:v2:data-cursor",
        version: 2,
        direction: "forward",
        resource: "db:orders",
        action: "read",
        ...binding,
        rbacRevision: 3,
        menuRevision: 5,
        anchor: [{ path: "_id", type: "string", value: { tag: "string", value: "order-1" } }],
        issuedAt: now - 1,
        expiresAt: now - 1 + 15 * 60 * 1_000,
    } as Record<string, unknown>;
}

describe("AuthorizedCollection cursor and trust boundaries", () => {
    it("rejects unsafe, internal, and foreign-namespace collection names", () => {
        const { repository, stub } = fixture();
        const runtime = createSubjectDataRuntime({
            monsqlize: stub.instance,
            repository,
            queryService: {} as never,
            schemes: new ResourceSchemeRegistry(),
            subject,
            context: {},
            run,
            coreNamespaceHash: digestCanonical("collection-name-boundary"),
            tokenSecret: new Uint8Array(32),
            maxTimeMS: 1_000,
        } as never);
        for (const name of ["", "x".repeat(121), "bad\0name", "bad$name", "system.users", "permission_core_roles"]) {
            expect(() => runtime.collection(name, { resource: "db:orders", scopeFields: { tenantId: "tenantId" } }))
                .toThrow();
        }

        const foreign = createMonSQLizeStub();
        const wrapper = foreign.spies.collection("orders") as unknown as { getNamespace: ReturnType<typeof vi.fn> };
        wrapper.getNamespace.mockReturnValue({ iid: "other:orders", type: "mongodb", db: "other-db", collection: "orders" });
        const foreignRuntime = createSubjectDataRuntime({
            monsqlize: foreign.instance,
            repository,
            queryService: {} as never,
            schemes: new ResourceSchemeRegistry(),
            subject,
            context: {},
            run,
            coreNamespaceHash: digestCanonical("foreign-namespace-boundary"),
            tokenSecret: new Uint8Array(32),
            maxTimeMS: 1_000,
        } as never);
        expect(() => foreignRuntime.collection("orders", { resource: "db:orders", scopeFields: { tenantId: "tenantId" } }))
            .toThrow(expect.objectContaining({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" }));
    });

    it("round-trips every scalar anchor representation and rejects malformed values", () => {
        const { access } = fixture();
        expect(access.restoreAnchorValue("id", { tag: "null" })).toBeNull();
        expect(access.restoreAnchorValue("active", { tag: "boolean", value: true })).toBe(true);
        expect(access.restoreAnchorValue("amount", { tag: "number", value: 12.5 })).toBe(12.5);
        expect(access.restoreAnchorValue("name", { tag: "string", value: "order" })).toBe("order");
        expect(access.restoreAnchorValue("createdAt", { tag: "date", epochMs: 1_000 })).toEqual(new Date(1_000));
        expect(access.restoreAnchorValue("bytes", { tag: "bytes", base64: "AQID" })).toEqual(new Uint8Array([1, 2, 3]));

        for (const canonical of [
            null,
            [],
            { tag: "boolean", value: "true" },
            { tag: "number", value: Number.NaN },
            { tag: "string", value: "x", extra: true },
            { tag: "date", epochMs: Number.POSITIVE_INFINITY },
            { tag: "bytes", base64: "not canonical" },
            { tag: "unknown" },
        ]) {
            expect(() => access.restoreAnchorValue("field", canonical)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
        }
    });

    it("learns Binary and ObjectId codecs only from trusted readback values", () => {
        const { access } = fixture();
        expect(() => access.restoreAnchorValue("binary", { tag: "binary", subtype: 2, base64: "AQI=" }))
            .toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
        expect(() => access.restoreAnchorValue("id", { tag: "object-id", hex: "0123456789abcdef01234567" }))
            .toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));

        class BinaryValue {
            readonly _bsontype = "Binary";
            readonly buffer: Uint8Array;
            readonly sub_type: number;
            constructor(value: Uint8Array, subtype = 0) {
                this.buffer = value;
                this.sub_type = subtype;
            }
        }
        class ObjectIdValue {
            readonly _bsontype = "ObjectId";
            constructor(readonly hex: string) {}
            static createFromHexString(hex: string) { return new ObjectIdValue(hex); }
        }
        access.rememberBsonCodec(null);
        access.rememberBsonCodec({ _bsontype: "Binary", constructor: "not-a-function" });
        access.rememberBsonCodec(new BinaryValue(new Uint8Array([1, 2]), 2));
        access.rememberBsonCodec(new ObjectIdValue("0123456789abcdef01234567"));

        expect(access.restoreAnchorValue("binary", { tag: "binary", subtype: 2, base64: "AQI=" }))
            .toBeInstanceOf(BinaryValue);
        expect(access.restoreAnchorValue("id", { tag: "object-id", hex: "0123456789abcdef01234567" }))
            .toBeInstanceOf(ObjectIdValue);
        expect(access.anchorCanonicalValue("binary", new BinaryValue(new Uint8Array([1, 2]), 2)))
            .toEqual({ tag: "binary", subtype: 2, base64: "AQI=" });
        expect(() => access.anchorCanonicalValue("binary", { _bsontype: "Binary", sub_type: -1, buffer: new Uint8Array() }))
            .toThrow(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
        expect(access.anchorCanonicalValue("name", "order")).toEqual({ tag: "string", value: "order" });
    });

    it("rejects cursor shape, binding, time, revision, and sort-anchor drift", () => {
        vi.useFakeTimers();
        try {
            const now = 2_000_000;
            vi.setSystemTime(now);
            const { access, binding, page } = fixture();
            const decode = (candidate: Record<string, unknown>) => access.decodeCursor(
                access.cursorCodec.encode(candidate),
                page,
                binding,
            );
            expect(decode(payload(binding, now))).toMatchObject({
                anchor: ["order-1"],
                sortTypes: ["string"],
                rbacRevision: 3,
                menuRevision: 5,
            });

            const invalid: Record<string, unknown>[] = [
                { ...payload(binding, now), extra: true },
                { ...payload(binding, now), purpose: "other" },
                { ...payload(binding, now), claimsFingerprint: "x".repeat(43) },
                { ...payload(binding, now), issuedAt: "now" },
                { ...payload(binding, now), expiresAt: "later" },
                { ...payload(binding, now), issuedAt: 1.5 },
                { ...payload(binding, now), expiresAt: now + 1 },
                { ...payload(binding, now), issuedAt: now + 1, expiresAt: now + 1 + 15 * 60 * 1_000 },
                { ...payload(binding, now), issuedAt: now - 15 * 60 * 1_000 - 1, expiresAt: now - 1 },
                { ...payload(binding, now), rbacRevision: 1.5 },
                { ...payload(binding, now), menuRevision: Number.MAX_SAFE_INTEGER + 1 },
                { ...payload(binding, now), anchor: "anchor" },
                { ...payload(binding, now), anchor: [] },
                { ...payload(binding, now), anchor: [null] },
                { ...payload(binding, now), anchor: [["bad"]] },
                { ...payload(binding, now), anchor: [{ path: "other", type: "string", value: { tag: "string", value: "x" } }] },
                { ...payload(binding, now), anchor: [{ path: "_id", type: "unknown", value: { tag: "string", value: "x" } }] },
                { ...payload(binding, now), anchor: [{ path: "_id", type: "number", value: { tag: "string", value: "x" } }] },
            ];
            for (const candidate of invalid) expect(() => decode(candidate)).toThrow();
        } finally {
            vi.useRealTimers();
        }
    });

    it("validates raw page anchors against the stable BSON sort domain", () => {
        const { access } = fixture();
        expect(() => access.anchorFromRaw({}, [["_id", 1]], ["string"]))
            .toThrow(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
        expect(() => access.anchorFromRaw({ _id: "order-1" }, [["_id", 1]], ["number"]))
            .toThrow(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
        expect(access.anchorFromRaw({ _id: "order-1" }, [["_id", 1]], ["string"]))
            .toEqual([{ path: "_id", type: "string", value: { tag: "string", value: "order-1" } }]);
    });
});
