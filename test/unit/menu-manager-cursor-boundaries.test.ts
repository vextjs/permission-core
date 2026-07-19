import { describe, expect, it, vi } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import { calculateReplaceManifestBytes } from "../../src/menu/aggregate";
import { MenuManifestService } from "../../src/menu/manifest-service";
import {
    apiBindingDocumentFromInput,
    menuNodeDocumentFromInput,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
} from "../../src/menu";
import { RoleMenuPermissionQueryService } from "../../src/menu/role-menu-queries";
import { StructuralStaleReferenceService } from "../../src/menu/stale-references";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";

const secret = new Uint8Array(Buffer.from("menu-manager-boundary-secret-32-bytes", "utf8"));
const scope = { tenantId: "tenant-a" } as const;
const cursorTtl = 15 * 60 * 1_000;

function tokens(namespace: string) {
    return new SignedTokenCodec(secret, namespace);
}

function encode(codec: SignedTokenCodec, value: Readonly<Record<string, unknown>>) {
    return codec.encode("pc:v2:manager-cursor", value as never);
}

describe("menu manifest cursor and progress boundaries", () => {
    function fixture() {
        const codec = tokens("manifest-boundaries");
        const service = new MenuManifestService(
            { findMaxLimit: 100 } as never,
            new ResourceSchemeRegistry(),
            codec,
        );
        const reader = {
            state: {
                scopeKey: "scope-key",
                menuRevision: 5,
                menuNodeCount: 2,
                apiBindingCount: 1,
                replaceManifestBytes: calculateReplaceManifestBytes({
                    menuNodeCount: 2,
                    apiBindingCount: 1,
                    itemBytes: 30,
                }),
            },
        };
        const access = service as unknown as {
            readCursor(token: string | undefined, reader: unknown, queryHash: string): unknown;
            writeCursor(
                reader: unknown,
                queryHash: string,
                anchor: Readonly<Record<string, unknown>>,
                progress: Readonly<Record<string, number>>,
            ): string;
            assertManifestProgress(
                reader: unknown,
                kind: "node" | "api-binding" | undefined,
                progress: Readonly<Record<string, number>>,
            ): void;
            readManifestPageRecords(
                reader: unknown,
                kind: "node" | "api-binding" | undefined,
                cursor: unknown,
                limit: number,
            ): Promise<unknown[]>;
            readManifestKindPage(
                reader: unknown,
                kind: "node" | "api-binding",
                after: string | undefined,
                limit: number,
            ): Promise<unknown[]>;
        };
        return { access, codec, reader, service };
    }

    function payload(now: number, overrides: Readonly<Record<string, unknown>> = {}) {
        return {
            method: "menus.manifest.exportPage",
            scopeKey: "scope-key",
            queryHash: "query",
            menuRevision: 5,
            anchor: { kind: "node", id: "orders" },
            progress: { menuNodeCount: 1, apiBindingCount: 0, itemBytes: 10 },
            issuedAt: now - 1,
            expiresAt: now - 1 + cursorTtl,
            ...overrides,
        };
    }

    it("rejects malformed manifest page queries before opening storage", async () => {
        const { service } = fixture();
        const accessor = {};
        Object.defineProperty(accessor, "first", { enumerable: true, get: () => 1 });
        for (const query of [
            [],
            new Date(),
            new Proxy({}, {}),
            accessor,
            { extra: true },
            { first: 0 },
            { first: 201 },
            { first: 1.5 },
            { after: "" },
            { after: 1 },
            { kind: "menu" },
        ]) {
            await expect(service.exportPage(scope, query as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        }
    });

    it("round-trips canonical cursors and rejects payload, binding, time, and revision drift", () => {
        vi.useFakeTimers();
        try {
            const now = 2_000_000;
            vi.setSystemTime(now);
            const { access, codec, reader } = fixture();
            expect(access.readCursor(undefined, reader, "query")).toBeUndefined();
            const token = access.writeCursor(
                reader,
                "query",
                { kind: "node", id: "orders" },
                { menuNodeCount: 1, apiBindingCount: 0, itemBytes: 10 },
            );
            expect(access.readCursor(token, reader, "query")).toMatchObject({
                anchor: { kind: "node", id: "orders" },
                progress: { menuNodeCount: 1, apiBindingCount: 0, itemBytes: 10 },
            });

            const invalid = [
                payload(now, { extra: true }),
                payload(now, { method: 1 }),
                payload(now, { scopeKey: 1 }),
                payload(now, { queryHash: 1 }),
                payload(now, { menuRevision: 1.5 }),
                payload(now, { menuRevision: -1 }),
                payload(now, { issuedAt: 1.5 }),
                payload(now, { expiresAt: 1.5 }),
                payload(now, { issuedAt: -1 }),
                payload(now, { issuedAt: 10, expiresAt: 10 }),
                payload(now, { anchor: null }),
                payload(now, { anchor: [] }),
                payload(now, { progress: null }),
                payload(now, { progress: [] }),
                payload(now, { anchor: { kind: "node" } }),
                payload(now, { anchor: { kind: "unknown", id: "orders" } }),
                payload(now, { anchor: { kind: "node", id: 1 } }),
                payload(now, { anchor: { kind: "node", id: " orders " } }),
                payload(now, { progress: { menuNodeCount: 1, apiBindingCount: 0 } }),
                payload(now, { progress: { menuNodeCount: 1.5, apiBindingCount: 0, itemBytes: 10 } }),
                payload(now, { progress: { menuNodeCount: -1, apiBindingCount: 0, itemBytes: 10 } }),
                payload(now, { progress: { menuNodeCount: 10_001, apiBindingCount: 0, itemBytes: 10 } }),
                payload(now, { progress: { menuNodeCount: 1, apiBindingCount: 0, itemBytes: 100_000_001 } }),
                payload(now, { progress: { menuNodeCount: 0, apiBindingCount: 0, itemBytes: 0 } }),
                payload(now, { anchor: { kind: "api-binding", id: "orders-api" }, progress: { menuNodeCount: 0, apiBindingCount: 0, itemBytes: 0 } }),
                payload(now, { scopeKey: "other" }),
                payload(now, { queryHash: "other" }),
                payload(now, { expiresAt: now + 1 }),
                payload(now, { issuedAt: now + 1, expiresAt: now + 1 + cursorTtl }),
                payload(now, { issuedAt: now - cursorTtl - 1, expiresAt: now - 1 }),
                payload(now, { menuRevision: 4 }),
            ];
            for (const candidate of invalid) {
                expect(() => access.readCursor(encode(codec, candidate), reader, "query")).toThrow();
            }

            vi.spyOn(codec, "decode").mockReturnValueOnce(null as never);
            expect(() => access.readCursor("invalid-payload", reader, "query")).toThrow();
        } finally {
            vi.useRealTimers();
        }
    });

    it("validates each manifest pagination phase against aggregate truth", () => {
        const { access, reader } = fixture();
        const valid = { menuNodeCount: 2, apiBindingCount: 1, itemBytes: 30 };
        expect(() => access.assertManifestProgress(reader, undefined, valid)).not.toThrow();
        expect(() => access.assertManifestProgress(reader, "node", valid)).not.toThrow();
        expect(() => access.assertManifestProgress(reader, "api-binding", valid)).not.toThrow();

        for (const [kind, progress] of [
            [undefined, { menuNodeCount: 3, apiBindingCount: 1, itemBytes: 30 }],
            ["node", { menuNodeCount: 1, apiBindingCount: 1, itemBytes: 30 }],
            ["api-binding", { menuNodeCount: 2, apiBindingCount: 0, itemBytes: 30 }],
            [undefined, { menuNodeCount: 1, apiBindingCount: 1, itemBytes: 30 }],
            [undefined, { menuNodeCount: 2, apiBindingCount: 1, itemBytes: 31 }],
        ] as const) {
            expect(() => access.assertManifestProgress(reader, kind, progress)).toThrow();
        }
    });

    it("rejects cross-phase manifest cursors and selects only valid inventory phases", async () => {
        const { access, reader, service } = fixture();
        const cursor = (
            kind: "node" | "api-binding",
            menuNodeCount: number,
            apiBindingCount: number,
        ) => ({
            anchor: { kind, id: kind === "node" ? "orders" : "orders-api" },
            progress: { menuNodeCount, apiBindingCount, itemBytes: 10 },
        });

        await expect(access.readManifestPageRecords(reader, "node", cursor("api-binding", 0, 1), 2)).rejects.toThrow();
        await expect(access.readManifestPageRecords(reader, "node", cursor("node", 1, 1), 2)).rejects.toThrow();
        await expect(access.readManifestPageRecords(reader, "api-binding", cursor("api-binding", 1, 1), 2)).rejects.toThrow();
        await expect(access.readManifestPageRecords(reader, undefined, cursor("api-binding", 1, 1), 2)).rejects.toThrow();
        await expect(access.readManifestPageRecords(reader, undefined, cursor("node", 1, 0), 2)).rejects.toThrow();

        const readKind = vi.fn(async (
            _reader: unknown,
            kind: "node" | "api-binding",
            after: string | undefined,
            limit: number,
        ) => Array.from({ length: Math.min(limit, 1) }, () => ({ kind, after })));
        Object.defineProperty(service, "readManifestKindPage", {
            value: readKind,
            configurable: true,
        });
        await expect(access.readManifestPageRecords(reader, "node", undefined, 2)).resolves.toHaveLength(1);
        await expect(access.readManifestPageRecords(reader, "api-binding", undefined, 2)).resolves.toHaveLength(1);
        await expect(access.readManifestPageRecords(reader, undefined, undefined, 2)).resolves.toHaveLength(2);
        await expect(access.readManifestPageRecords(reader, undefined, cursor("node", 1, 1), 2)).resolves.toHaveLength(1);
        expect(readKind).toHaveBeenCalledWith(reader, "node", "orders", 2);
    });

    it("fails closed when host manifest pages violate limits, ownership, keysets, or reads", async () => {
        const schemes = new ResourceSchemeRegistry();
        const normalizedScope = normalizeScope(scope);
        const scopeKey = createScopeKey(normalizedScope);
        const node = menuNodeDocumentFromInput(
            scopeKey,
            normalizedScope,
            normalizeMenuNodeCreateInput({
                id: "orders",
                type: "page",
                title: "Orders",
                path: "/orders",
                name: "orders",
                component: "OrdersPage",
                permission: { action: "read", resource: "ui:page:orders" },
            }, schemes),
            0,
            1,
            100,
        );
        const binding = apiBindingDocumentFromInput(
            scopeKey,
            normalizedScope,
            normalizeApiBindingCreateInput({
                id: "orders-api",
                method: "GET",
                path: "/api/orders",
                purpose: "entry",
                authorization: {
                    mode: "all",
                    permissions: [{ action: "read", resource: "api:GET:/api/orders" }],
                },
            }, schemes),
            1,
            100,
        );
        const reader = { state: { scope: normalizedScope, scopeKey, persisted: true } };

        const accessFor = (rows: readonly unknown[] | Error) => {
            const find = vi.fn(() => {
                if (rows instanceof Error) throw rows;
                const chain = {
                    sort: vi.fn(() => chain),
                    limit: vi.fn(() => chain),
                    toArray: vi.fn(async () => [...rows]),
                };
                return chain;
            });
            const service = new MenuManifestService({
                findMaxLimit: 100,
                collections: { menuNodes: { find }, apiBindings: { find } },
            } as never, schemes, tokens("manifest-page-boundaries"));
            return service as unknown as {
                readManifestKindPage(
                    reader: unknown,
                    kind: "node" | "api-binding",
                    after: string | undefined,
                    limit: number,
                ): Promise<unknown[]>;
            };
        };

        await expect(accessFor([node, node]).readManifestKindPage(reader, "node", undefined, 1)).rejects.toThrow();
        await expect(accessFor([node]).readManifestKindPage(
            { state: { ...reader.state, persisted: false } },
            "node",
            undefined,
            1,
        )).rejects.toThrow();
        await expect(accessFor([node]).readManifestKindPage(reader, "node", "orders", 1)).rejects.toThrow();
        await expect(accessFor([binding]).readManifestKindPage(reader, "api-binding", "orders-api", 1)).rejects.toThrow();
        await expect(accessFor(new Error("query failed")).readManifestKindPage(reader, "node", undefined, 1))
            .rejects.toMatchObject({ code: "DATABASE_ERROR" });
    });
});

describe("role-menu manager cursor boundaries", () => {
    function fixture() {
        const codec = tokens("role-menu-boundaries");
        const service = new RoleMenuPermissionQueryService(
            { findMaxLimit: 100 } as never,
            new ResourceSchemeRegistry(),
            codec,
            {} as never,
        );
        const reader = { state: { scopeKey: "scope-key", rbacRevision: 3, menuRevision: 4 } };
        const access = service as unknown as {
            readCursor(token: string | undefined, method: string, reader: unknown, queryHash: string): unknown;
            writeCursor(
                method: string,
                reader: unknown,
                queryHash: string,
                anchor: Readonly<Record<string, string>>,
            ): string;
        };
        return { access, codec, reader, service };
    }

    function payload(now: number, overrides: Readonly<Record<string, unknown>> = {}) {
        return {
            method: "roles.menuPermissions.listDirect",
            scopeKey: "scope-key",
            queryHash: "query",
            rbacRevision: 3,
            menuRevision: 4,
            anchor: { effect: "allow", grantId: "orders" },
            issuedAt: now - 1,
            expiresAt: now - 1 + cursorTtl,
            ...overrides,
        };
    }

    it("rejects malformed direct and stale queries before opening storage", async () => {
        const { service } = fixture();
        for (const query of [
            [],
            new Date(),
            new Proxy({}, {}),
            { extra: true },
            { first: 0 },
            { first: 201 },
            { first: 1.5 },
            { after: "" },
            { after: 1 },
            { effect: "audit" },
        ]) {
            await expect(service.listDirect(scope, "reader", query as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        }
        await expect(service.listStale(scope, { after: "" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(service.listStale(scope, { extra: true } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });

    it("binds cursors to method, scope, query, revisions, interval, and canonical anchors", () => {
        vi.useFakeTimers();
        try {
            const now = 3_000_000;
            vi.setSystemTime(now);
            const { access, codec, reader } = fixture();
            expect(access.readCursor(undefined, "roles.menuPermissions.listDirect", reader, "query")).toBeUndefined();
            const direct = access.writeCursor(
                "roles.menuPermissions.listDirect",
                reader,
                "query",
                { effect: "allow", grantId: "orders" },
            );
            expect(access.readCursor(direct, "roles.menuPermissions.listDirect", reader, "query"))
                .toEqual({ effect: "allow", grantId: "orders" });
            const stale = access.writeCursor(
                "roles.menuPermissions.listStale",
                reader,
                "query",
                { roleId: "reader", grantId: "orders", sourceId: "source-1" },
            );
            expect(access.readCursor(stale, "roles.menuPermissions.listStale", reader, "query"))
                .toEqual({ roleId: "reader", grantId: "orders", sourceId: "source-1" });

            const invalid = [
                payload(now, { extra: true }),
                payload(now, { method: 1 }),
                payload(now, { scopeKey: 1 }),
                payload(now, { queryHash: 1 }),
                payload(now, { rbacRevision: 1.5 }),
                payload(now, { menuRevision: 1.5 }),
                payload(now, { issuedAt: 1.5 }),
                payload(now, { expiresAt: 1.5 }),
                payload(now, { anchor: null }),
                payload(now, { anchor: [] }),
                payload(now, { method: "roles.menuPermissions.listStale" }),
                payload(now, { scopeKey: "other" }),
                payload(now, { queryHash: "other" }),
                payload(now, { expiresAt: now + 1 }),
                payload(now, { issuedAt: now + 1, expiresAt: now + 1 + cursorTtl }),
                payload(now, { issuedAt: now - cursorTtl - 1, expiresAt: now - 1 }),
                payload(now, { rbacRevision: 2 }),
                payload(now, { menuRevision: 3 }),
                payload(now, { anchor: { effect: "allow" } }),
                payload(now, { anchor: { effect: "audit", grantId: "orders" } }),
                payload(now, { anchor: { effect: "allow", grantId: 1 } }),
                payload(now, { anchor: { effect: "allow", grantId: " orders " } }),
                payload(now, { method: "roles.menuPermissions.listStale", anchor: { roleId: "reader", grantId: "orders" } }),
                payload(now, { method: "roles.menuPermissions.listStale", anchor: { roleId: " reader ", grantId: "orders", sourceId: "source-1" } }),
                payload(now, { method: "unsupported", anchor: { id: "value" } }),
            ];
            for (const candidate of invalid) {
                const method = typeof candidate.method === "string" ? candidate.method : "roles.menuPermissions.listDirect";
                expect(() => access.readCursor(encode(codec, candidate), method, reader, "query")).toThrow();
            }

            vi.spyOn(codec, "decode").mockReturnValueOnce(null as never);
            expect(() => access.readCursor("invalid-payload", "roles.menuPermissions.listDirect", reader, "query")).toThrow();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("structural stale-reference cursor boundaries", () => {
    function fixture() {
        const codec = tokens("stale-reference-boundaries");
        const service = new StructuralStaleReferenceService(
            { findMaxLimit: 100 } as never,
            new ResourceSchemeRegistry(),
            codec,
        );
        const reader = { state: { scopeKey: "scope-key", menuRevision: 5 } };
        const access = service as unknown as {
            readCursor(token: string | undefined, reader: unknown, queryHash: string): unknown;
            writeCursor(reader: unknown, queryHash: string, anchor: Readonly<Record<string, string>>): string;
        };
        return { access, codec, reader, service };
    }

    function payload(now: number, overrides: Readonly<Record<string, unknown>> = {}) {
        return {
            scopeKey: "scope-key",
            queryHash: "query",
            menuRevision: 5,
            anchor: { type: "parent", id: "orders" },
            issuedAt: now - 1,
            expiresAt: now - 1 + cursorTtl,
            ...overrides,
        };
    }

    it("rejects malformed list queries before opening storage", async () => {
        const { service } = fixture();
        for (const query of [
            [],
            new Date(),
            new Proxy({}, {}),
            { extra: true },
            { first: 0 },
            { first: 201 },
            { first: 1.5 },
            { after: "" },
            { after: 1 },
        ]) {
            await expect(service.findStaleReferences(scope, query as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        }
    });

    it("round-trips both anchors and rejects malformed or stale cursor payloads", () => {
        vi.useFakeTimers();
        try {
            const now = 4_000_000;
            vi.setSystemTime(now);
            const { access, codec, reader } = fixture();
            expect(access.readCursor(undefined, reader, "query")).toBeUndefined();
            for (const anchor of [
                { type: "parent", id: "orders" },
                { type: "api-owner", id: "orders-api" },
            ]) {
                const token = access.writeCursor(reader, "query", anchor);
                expect(access.readCursor(token, reader, "query")).toEqual(anchor);
            }

            const invalid = [
                payload(now, { extra: true }),
                payload(now, { scopeKey: 1 }),
                payload(now, { queryHash: 1 }),
                payload(now, { menuRevision: 1.5 }),
                payload(now, { menuRevision: -1 }),
                payload(now, { issuedAt: 1.5 }),
                payload(now, { expiresAt: 1.5 }),
                payload(now, { anchor: null }),
                payload(now, { anchor: [] }),
                payload(now, { anchor: { type: "parent" } }),
                payload(now, { anchor: { type: "unknown", id: "orders" } }),
                payload(now, { anchor: { type: "parent", id: "" } }),
                payload(now, { scopeKey: "other" }),
                payload(now, { queryHash: "other" }),
                payload(now, { expiresAt: now + 1 }),
                payload(now, { issuedAt: now + 1, expiresAt: now + 1 + cursorTtl }),
                payload(now, { issuedAt: now - cursorTtl - 1, expiresAt: now - 1 }),
                payload(now, { menuRevision: 4 }),
            ];
            for (const candidate of invalid) {
                expect(() => access.readCursor(encode(codec, candidate), reader, "query")).toThrow();
            }

            vi.spyOn(codec, "decode").mockReturnValueOnce(null as never);
            expect(() => access.readCursor("invalid-payload", reader, "query")).toThrow();
        } finally {
            vi.useRealTimers();
        }
    });
});
