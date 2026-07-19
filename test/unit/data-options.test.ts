import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src/core/errors";
import { normalizeMongoValue } from "../../src/data/value";
import { canonicalByteLength } from "../../src/internal/canonical";
import {
    normalizeAuthorizedCollectionOptions,
    normalizeCountOptions,
    normalizePageQuery,
    normalizeReadOptions,
    normalizeTransactionOptions,
} from "../../src/data/options";

const limits = { findMaxLimit: 97, maxTimeMS: 5_000 } as const;

describe("AuthorizedCollection options", () => {
    it("requires every active scope mapping and rejects overlapping paths", () => {
        expect(normalizeAuthorizedCollectionOptions({
            resource: "db:orders",
            scopeFields: { tenantId: "scope.tenantId", appId: "scope.appId" },
        }, { tenantId: "tenant-1", appId: "app-1" })).toMatchObject({
            resource: "db:orders",
            scopePaths: ["scope.tenantId", "scope.appId"],
        });

        expect(() => normalizeAuthorizedCollectionOptions({
            resource: "db:orders",
            scopeFields: { tenantId: "tenantId" },
        }, { tenantId: "tenant-1", appId: "app-1" })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "SCOPE_FIELD_MAPPING_REQUIRED" }),
        );
        expect(() => normalizeAuthorizedCollectionOptions({
            resource: "db:orders",
            scopeFields: { tenantId: "scope", appId: "scope.appId" },
        }, { tenantId: "tenant-1", appId: "app-1" })).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
    });

    it("applies host limits, stable _id tie-breaks, and option shape boundaries", () => {
        expect(normalizeReadOptions(undefined, limits)).toMatchObject({
            limit: 50,
            maxTimeMS: 5_000,
            sortEntries: [["_id", 1]],
            callerSortPaths: [],
        });
        expect(normalizeReadOptions({ limit: 97, sort: { amount: -1 } }, limits)).toMatchObject({
            limit: 97,
            sortEntries: [["amount", -1], ["_id", -1]],
            callerSortPaths: ["amount"],
        });
        expect(() => normalizeReadOptions({ limit: 98 }, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeReadOptions({ maxTimeMS: 5_001 }, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeReadOptions({ projection: { shown: 1, hidden: 0 } }, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeReadOptions({
            sort: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field_${index}`, 1])) as Record<string, 1>,
        }, limits)).toThrowError(expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }));

        const exactSort = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field_${index}`, 1])) as Record<string, 1>;
        const exactProjection = Array.from({ length: 256 }, (_, index) => `field_${index}`);
        expect(normalizeReadOptions({ sort: exactSort }, limits).callerSortPaths).toHaveLength(32);
        expect(normalizeReadOptions({ projection: exactProjection }, limits).projection.paths).toHaveLength(256);
        expect(() => normalizeReadOptions({ projection: [...exactProjection, "overflow"] }, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
    });

    it("keeps forward and backward page inputs mutually exclusive", () => {
        expect(normalizePageQuery({ first: 10, after: "cursor" }, limits)).toMatchObject({
            direction: "forward",
            cursor: "cursor",
            limit: 10,
        });
        expect(normalizePageQuery({ last: 10, before: "cursor" }, limits)).toMatchObject({
            direction: "backward",
            cursor: "cursor",
            limit: 10,
        });
        expect(() => normalizePageQuery({ before: "cursor" } as never, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizePageQuery({ first: 10, last: 10 } as never, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(normalizePageQuery({ first: 97 }, limits).limit).toBe(97);
        expect(() => normalizePageQuery({ first: 98 }, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        const largeHost = { findMaxLimit: 1_000, maxTimeMS: 5_000 } as const;
        expect(normalizePageQuery({ first: 200 }, largeHost).limit).toBe(200);
        expect(() => normalizePageQuery({ first: 201 }, largeHost)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
    });

    it("rejects sparse/accessor projections and closed-option shape violations without invoking traps", () => {
        const sparse = new Array(2);
        sparse[1] = "shown";
        let accessorRead = false;
        const accessor: string[] = [];
        Object.defineProperty(accessor, "0", {
            enumerable: true,
            get() {
                accessorRead = true;
                return "shown";
            },
        });
        accessor.length = 1;
        let proxyRead = false;
        const proxy = new Proxy({}, {
            get() {
                proxyRead = true;
                throw new Error("must not execute");
            },
        });

        expect(() => normalizeReadOptions({ projection: sparse } as never, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeReadOptions({ projection: accessor } as never, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(accessorRead).toBe(false);
        expect(() => normalizePageQuery(proxy as never, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeCountOptions({ extra: true } as never, limits)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeTransactionOptions({ extra: true } as never)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(proxyRead).toBe(false);
    });

    it("uses the dedicated read-options byte discriminator at the exact 64 KiB boundary", () => {
        const target = 64 * 1024;
        const largeHost = { findMaxLimit: 1_000, maxTimeMS: 5_000 } as const;
        let paths: string[] | undefined;
        for (let length = 8; length <= 256 && !paths; length += 1) {
            const fixed = Array.from({ length: 255 }, (_, index) => {
                const prefix = `p${index}_`;
                return `${prefix}${"x".repeat(length - prefix.length)}`;
            });
            const tail = "tail_a";
            const projection = { mode: "include", paths: [...fixed, tail], includeId: false } as const;
            const bytes = canonicalByteLength(normalizeMongoValue({
                projection,
                sortEntries: [["_id", 1]],
                limit: 50,
                maxTimeMS: 5_000,
            }, "caller-input", "options", false).canonical);
            const additional = target - bytes;
            if (additional >= 0 && tail.length + additional <= 255) {
                paths = [...fixed, `${tail}${"x".repeat(additional)}`];
            }
        }
        expect(paths).toBeDefined();
        const exact = normalizeReadOptions({ projection: paths! }, largeHost);
        const exactBytes = canonicalByteLength(normalizeMongoValue({
            projection: exact.projection,
            sortEntries: exact.sortEntries,
            limit: exact.limit,
            maxTimeMS: exact.maxTimeMS,
        }, "caller-input", "options", false).canonical);
        expect(exactBytes).toBe(target);
        const overflow = [...paths!];
        overflow[overflow.length - 1] = `${overflow.at(-1)}x`;
        expect(() => normalizeReadOptions({ projection: overflow }, largeHost)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({
                code: "LIMIT_EXCEEDED",
                details: expect.objectContaining({ limitName: "read-options-bytes" }),
            }),
        );
    });

    it("rejects transaction and session Proxies before invoking their traps", () => {
        let transactionRead = false;
        const transaction = new Proxy({}, {
            get() {
                transactionRead = true;
                throw new Error("must not execute");
            },
        });
        let sessionRead = false;
        const session = new Proxy({}, {
            get() {
                sessionRead = true;
                throw new Error("must not execute");
            },
        });

        expect(() => normalizeTransactionOptions({ transaction } as never)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }),
        );
        expect(() => normalizeTransactionOptions({
            transaction: { state: "active", abort() {}, session },
        } as never)).toThrowError(expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_ARGUMENT" }));
        expect(transactionRead).toBe(false);
        expect(sessionRead).toBe(false);
    });
});
