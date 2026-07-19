import { describe, expect, it, vi } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import {
    apiBindingDocumentFromInput,
    menuNodeDocumentFromInput,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
} from "../../src/menu";
import { MAX_API_BINDINGS, MAX_MENU_NODES, MenuScopeReader } from "../../src/menu/store";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";

const schemes = new ResourceSchemeRegistry();
const scope = normalizeScope({ tenantId: "tenant-menu-store" });
const scopeKey = createScopeKey(scope);

const node = menuNodeDocumentFromInput(
    scopeKey,
    scope,
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

function binding(id: string, owners: readonly Readonly<Record<string, unknown>>[] = []) {
    return apiBindingDocumentFromInput(
        scopeKey,
        scope,
        normalizeApiBindingCreateInput({
            id,
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: {
                mode: "all",
                permissions: [{ action: "read", resource: "api:GET:/api/orders" }],
            },
            owners,
        } as never, schemes),
        1,
        100,
    );
}

function query(rows: readonly unknown[] | Error) {
    const chain = {
        sort: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        toArray: vi.fn(async () => {
            if (rows instanceof Error) throw rows;
            return [...rows];
        }),
    };
    return chain;
}

function fixture(input: {
    readonly nodeRows?: readonly unknown[];
    readonly bindingRows?: readonly unknown[];
    readonly nodeFindOne?: unknown;
    readonly bindingFindOne?: unknown;
    readonly findMaxLimit?: number;
    readonly persisted?: boolean;
    readonly menuNodeCount?: number;
    readonly apiBindingCount?: number;
    readonly replaceManifestBytes?: number;
    readonly current?: Readonly<Record<string, unknown>>;
}) {
    const state = {
        scope,
        scopeKey,
        persisted: input.persisted ?? true,
        revision: 3,
        rbacRevision: 1,
        menuRevision: 2,
        auditRevision: 3,
        menuNodeCount: input.menuNodeCount ?? (input.nodeRows?.length ?? 0),
        apiBindingCount: input.apiBindingCount ?? (input.bindingRows?.length ?? 0),
        replaceManifestBytes: input.replaceManifestBytes ?? 0,
    };
    const repository = {
        findMaxLimit: input.findMaxLimit ?? 100,
        scopeStates: { read: vi.fn(async () => input.current ?? state) },
        collections: {
            menuNodes: {
                findOne: vi.fn(async () => input.nodeFindOne ?? null),
                find: vi.fn(() => query(input.nodeRows ?? [])),
            },
            apiBindings: {
                findOne: vi.fn(async () => input.bindingFindOne ?? null),
                find: vi.fn(() => query(input.bindingRows ?? [])),
            },
            roleMenuGrants: {
                findOne: vi.fn(async () => null),
                find: vi.fn(() => query([])),
            },
        },
    };
    return { reader: new MenuScopeReader(repository as never, schemes, state as never), repository, state };
}

describe("menu scope reader corruption and read-conflict boundaries", () => {
    it("detects global, menu, and authorization revision drift", async () => {
        const menu = fixture({ current: { revision: 4, menuRevision: 3, rbacRevision: 1 } });
        await expect(menu.reader.verifyMenuUnchanged()).rejects.toMatchObject({ code: "READ_CONFLICT" });
        const authorization = fixture({ current: { revision: 4, menuRevision: 2, rbacRevision: 2 } });
        await expect(authorization.reader.verifyMenuAuthorizationUnchanged()).rejects.toMatchObject({ code: "READ_CONFLICT" });
    });

    it("rejects orphan rows, missing required records, oversized identities, and unexpected batch records", async () => {
        const orphan = fixture({ persisted: false, nodeFindOne: node, bindingFindOne: binding("orders-api") });
        await expect(orphan.reader.readNode("orders")).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        await expect(orphan.reader.readBinding("orders-api")).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        const missing = fixture({});
        await expect(missing.reader.requireNode("missing")).rejects.toMatchObject({ code: "MENU_NOT_FOUND" });
        await expect(missing.reader.requireBinding("missing")).rejects.toMatchObject({ code: "API_BINDING_NOT_FOUND" });
        await expect(missing.reader.readNodesByIds(Array.from({ length: MAX_MENU_NODES + 1 }, (_, index) => `node-${index}`)))
            .rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        await expect(missing.reader.readBindingsByIds(Array.from({ length: MAX_API_BINDINGS + 1 }, (_, index) => `binding-${index}`)))
            .rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        const wrongNode = fixture({ nodeRows: [node] });
        await expect(wrongNode.reader.readNodesByIds(["other"])).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        const wrongBinding = fixture({ bindingRows: [binding("orders-api")] });
        await expect(wrongBinding.reader.readBindingsByIds(["other"])).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    });

    it("rejects host-page overflow, count drift, non-advancing keysets, and database failures", async () => {
        const nodeOverflow = fixture({ nodeRows: [node, node], findMaxLimit: 1, menuNodeCount: 2 });
        await expect(nodeOverflow.reader.readAllNodes()).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        const bindingOverflow = fixture({ bindingRows: [binding("orders-api"), binding("orders-api-2")], findMaxLimit: 1, apiBindingCount: 2 });
        await expect(bindingOverflow.reader.readAllBindings()).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        await expect(fixture({ menuNodeCount: 1 }).reader.readAllNodes())
            .rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        await expect(fixture({ apiBindingCount: 1 }).reader.readAllBindings())
            .rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        const nodePages = [[node], [node]];
        const nodeKeyset = fixture({ findMaxLimit: 1, menuNodeCount: 2 });
        nodeKeyset.repository.collections.menuNodes.find = vi.fn(() => query(nodePages.shift() ?? []));
        await expect(nodeKeyset.reader.readAllNodes()).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        const bindingRow = binding("orders-api");
        const bindingPages = [[bindingRow], [bindingRow]];
        const bindingKeyset = fixture({ findMaxLimit: 1, apiBindingCount: 2 });
        bindingKeyset.repository.collections.apiBindings.find = vi.fn(() => query(bindingPages.shift() ?? []));
        await expect(bindingKeyset.reader.readAllBindings()).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        const failed = fixture({});
        failed.repository.collections.menuNodes.findOne = vi.fn(async () => { throw new Error("read failed"); });
        failed.repository.collections.apiBindings.findOne = vi.fn(async () => { throw new Error("read failed"); });
        await expect(failed.reader.readNode("orders")).rejects.toMatchObject({ code: "DATABASE_ERROR" });
        await expect(failed.reader.readBinding("orders-api")).rejects.toMatchObject({ code: "DATABASE_ERROR" });
    });

    it("rejects duplicate endpoints, owner type drift, and manifest aggregate drift", async () => {
        const duplicate = fixture({
            nodeRows: [node],
            bindingRows: [binding("orders-api"), binding("orders-api-2")],
            menuNodeCount: 1,
            apiBindingCount: 2,
        });
        await expect(duplicate.reader.readCompleteInventory()).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        const wrongOwner = binding("owner-type", [{ type: "menu", id: "orders", required: true }]);
        const typeDrift = fixture({ nodeRows: [node], bindingRows: [wrongOwner], menuNodeCount: 1, apiBindingCount: 1 });
        await expect(typeDrift.reader.readCompleteInventory()).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        const aggregate = fixture({ nodeRows: [node], menuNodeCount: 1, replaceManifestBytes: 1 });
        await expect(aggregate.reader.readCompleteInventory()).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    });
});
