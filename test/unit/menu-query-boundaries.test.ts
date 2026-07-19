import { describe, expect, it, vi } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import { MenuQueryService, validateMenuGraph } from "../../src/menu/queries";
import type { PolicyValue } from "../../src/types/foundation";

const secret = new Uint8Array(Buffer.from("menu-query-boundary-secret-32-bytes!", "utf8"));

function fixture() {
    const tokens = new SignedTokenCodec(secret, "menu-query-boundary-namespace");
    const service = new MenuQueryService(
        { findMaxLimit: 100 } as never,
        new ResourceSchemeRegistry(),
        tokens,
    );
    const reader = {
        state: {
            scopeKey: "scope-key",
            revision: 6,
            rbacRevision: 4,
            menuRevision: 5,
            auditRevision: 6,
        },
    } as never;
    const access = service as unknown as {
        readCursor(token: string | undefined, method: string, reader: unknown, queryHash: string): unknown;
        writeCursor(method: string, reader: unknown, queryHash: string, anchor: Readonly<Record<string, PolicyValue>>): string;
    };
    return { access, reader, service, tokens };
}

function encode(tokens: SignedTokenCodec, body: Readonly<Record<string, PolicyValue>>) {
    return tokens.encode("pc:v2:manager-cursor", body);
}

function payload(now: number, anchor: PolicyValue, overrides: Readonly<Record<string, PolicyValue>> = {}) {
    return {
        method: "menus.list",
        scopeKey: "scope-key",
        queryHash: "query",
        menuRevision: 5,
        anchor,
        issuedAt: now - 1,
        expiresAt: now - 1 + 15 * 60 * 1_000,
        ...overrides,
    };
}

describe("menu query cursor boundaries", () => {
    it("rejects malformed menu and API list query inputs before storage", async () => {
        const { service } = fixture();
        for (const query of [
            { first: 0 },
            { first: 201 },
            { first: 1.5 },
            { after: "" },
            { after: 1 },
            { extra: true },
            { parentId: " reader " },
            { hidden: "yes" },
            { type: ["page", "unknown"] },
        ]) {
            await expect(service.listMenus({ tenantId: "tenant" }, query as never)).rejects.toThrow();
        }
        for (const query of [
            { first: 0 },
            { after: "" },
            { method: "get" },
            { path: "/orders?tab=all" },
            { purpose: "unknown" },
            { ownerId: " owner " },
            { extra: true },
        ]) {
            await expect(service.listApiBindings({ tenantId: "tenant" }, query as never)).rejects.toThrow();
        }
    });

    it("round-trips menu and API anchors and accepts an omitted cursor", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            const { access, reader } = fixture();
            expect(access.readCursor(undefined, "menus.list", reader, "query")).toBeUndefined();
            const menu = { parentId: null, order: 0, nodeId: "orders", mongoId: "str:b3JkZXJz" };
            const menuToken = access.writeCursor("menus.list", reader, "query", menu);
            expect(access.readCursor(menuToken, "menus.list", reader, "query")).toEqual(menu);
            const api = { method: "GET", path: "/api/orders", bindingId: "orders-list", mongoId: "oid:0123456789abcdef01234567" };
            const apiToken = access.writeCursor("apiBindings.list", reader, "query", api);
            expect(access.readCursor(apiToken, "apiBindings.list", reader, "query")).toEqual(api);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects cursor payload shape, scalar, binding, time, and revision drift", () => {
        vi.useFakeTimers();
        try {
            const now = 2_000_000;
            vi.setSystemTime(now);
            const { access, reader, tokens } = fixture();
            const anchor = { parentId: null, order: 0, nodeId: "orders", mongoId: "str:b3JkZXJz" };
            const invalid: Readonly<Record<string, PolicyValue>>[] = [
                { ...payload(now, anchor), extra: true },
                payload(now, anchor, { method: 1 }),
                payload(now, anchor, { scopeKey: 1 }),
                payload(now, anchor, { queryHash: 1 }),
                payload(now, anchor, { menuRevision: 1.5 }),
                payload(now, anchor, { menuRevision: -1 }),
                payload(now, null),
                payload(now, []),
                payload(now, anchor, { issuedAt: 1.5 }),
                payload(now, anchor, { expiresAt: 1.5 }),
                payload(now, anchor, { issuedAt: -1 }),
                payload(now, anchor, { issuedAt: 10, expiresAt: 10 }),
                payload(now, anchor, { method: "apiBindings.list" }),
                payload(now, anchor, { scopeKey: "other" }),
                payload(now, anchor, { queryHash: "other" }),
                payload(now, anchor, { expiresAt: now + 1 }),
                payload(now, anchor, { issuedAt: now + 1, expiresAt: now + 1 + 15 * 60 * 1_000 }),
                payload(now, anchor, { issuedAt: now - 15 * 60 * 1_000 - 1, expiresAt: now - 1 }),
                payload(now, anchor, { menuRevision: 4 }),
            ];
            for (const candidate of invalid) {
                expect(() => access.readCursor(encode(tokens, candidate), "menus.list", reader, "query")).toThrow();
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects malformed and non-canonical menu and API anchors", () => {
        vi.useFakeTimers();
        try {
            const now = 3_000_000;
            vi.setSystemTime(now);
            const { access, reader, tokens } = fixture();
            const menuAnchors: PolicyValue[] = [
                {},
                { parentId: null, order: 0, nodeId: "orders" },
                { parentId: 1, order: 0, nodeId: "orders", mongoId: "str:a" },
                { parentId: null, order: 1.5, nodeId: "orders", mongoId: "str:a" },
                { parentId: null, order: -1, nodeId: "orders", mongoId: "str:a" },
                { parentId: " parent ", order: 0, nodeId: "orders", mongoId: "str:a" },
                { parentId: null, order: 0, nodeId: " order ", mongoId: "str:a" },
                { parentId: null, order: 0, nodeId: "orders", mongoId: "raw" },
            ];
            for (const anchor of menuAnchors) {
                expect(() => access.readCursor(encode(tokens, payload(now, anchor)), "menus.list", reader, "query")).toThrow();
            }

            const apiAnchors: PolicyValue[] = [
                {},
                { method: 1, path: "/api/orders", bindingId: "orders", mongoId: "str:a" },
                { method: "GET", path: 1, bindingId: "orders", mongoId: "str:a" },
                { method: "GET", path: "/api/orders?x=1", bindingId: "orders", mongoId: "str:a" },
                { method: "get", path: "/api/orders", bindingId: "orders", mongoId: "str:a" },
                { method: "GET!", path: "/api/orders", bindingId: "orders", mongoId: "str:a" },
                { method: "GET", path: "/api/orders", bindingId: " orders ", mongoId: "str:a" },
                { method: "GET", path: "/api/orders", bindingId: "orders", mongoId: "raw" },
            ];
            for (const anchor of apiAnchors) {
                const token = encode(tokens, payload(now, anchor, { method: "apiBindings.list" }));
                expect(() => access.readCursor(token, "apiBindings.list", reader, "query")).toThrow();
            }

            const unknown = encode(tokens, payload(now, { id: "value" }, { method: "unknown" }));
            expect(() => access.readCursor(unknown, "unknown", reader, "query")).toThrow();
        } finally {
            vi.useRealTimers();
        }
    });
});

function node(input: Readonly<Record<string, unknown>>) {
    return {
        nodeId: "root",
        parentId: null,
        type: "directory",
        order: 0,
        ...input,
    } as never;
}

describe("persisted menu graph boundaries", () => {
    it("accepts a valid graph and sorts its children deterministically", () => {
        const graph = validateMenuGraph([
            node({ nodeId: "root", type: "directory" }),
            node({ nodeId: "orders", parentId: "root", type: "menu", order: 0 }),
            node({ nodeId: "reports", parentId: "root", type: "page", order: 1 }),
            node({ nodeId: "save", parentId: "reports", type: "button", order: 0 }),
        ]);
        expect(graph.depths.get("save")).toBe(3);
        expect(graph.children.get("root")?.map((entry) => entry.nodeId)).toEqual(["orders", "reports"]);
    });

    it("rejects duplicate identities, route metadata, sibling codes, and sparse order", () => {
        const cases = [
            [node({}), node({})],
            [node({ nodeId: "a", path: "/same" }), node({ nodeId: "b", path: "/same", order: 1 })],
            [node({ nodeId: "a", name: "same" }), node({ nodeId: "b", name: "same", order: 1 })],
            [node({ nodeId: "a", code: "same" }), node({ nodeId: "b", code: "same", order: 1 })],
            [node({ nodeId: "root", order: 1 })],
        ];
        for (const rows of cases) expect(() => validateMenuGraph(rows)).toThrow(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
    });

    it("rejects cycles, missing parents, incompatible types, root buttons, and excessive depth", () => {
        expect(() => validateMenuGraph([
            node({ nodeId: "a", parentId: "b", type: "menu" }),
            node({ nodeId: "b", parentId: "a", type: "menu" }),
        ])).toThrow(expect.objectContaining({
            code: "PERSISTED_STATE_INVALID",
            details: expect.objectContaining({ reason: expect.stringContaining("cycle") }),
        }));
        expect(() => validateMenuGraph([node({ nodeId: "child", parentId: "missing", type: "menu" })]))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: expect.stringContaining("parent reference") }) }));
        expect(() => validateMenuGraph([
            node({ nodeId: "root", type: "directory" }),
            node({ nodeId: "button", parentId: "root", type: "button" }),
        ])).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: expect.stringContaining("incompatible") }) }));
        expect(() => validateMenuGraph([node({ nodeId: "button", type: "button" })]))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: expect.stringContaining("root node") }) }));

        const deep = Array.from({ length: 65 }, (_, index) => node({
            nodeId: `node-${index}`,
            parentId: index === 0 ? null : `node-${index - 1}`,
            type: index === 0 ? "directory" : "menu",
        }));
        expect(() => validateMenuGraph(deep))
            .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: expect.stringContaining("depth 64") }) }));
    });
});
