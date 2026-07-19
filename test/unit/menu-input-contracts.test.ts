import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import {
    normalizeApiBindingCreateInput,
    normalizeApiBindingFilter,
    normalizeApiBindingImpactUpdateRequest,
    normalizeApiBindingRemoveInput,
    normalizeApiBindingReplaceInput,
    normalizeApiBindingUpdateInput,
    normalizeDeclaredPath,
    normalizeHttpUrl,
    normalizeMenuManifestInput,
    normalizeMenuMoveInput,
    normalizeMenuNodeCreateInput,
    normalizeMenuNodeFilter,
    normalizeMenuNodeImpactUpdateRequest,
    normalizeMenuNodeUpdateInput,
    normalizeMenuRemoveInput,
    normalizeMenuReorderInput,
    normalizeStaleRepairInput,
} from "../../src/menu";

const schemes = new ResourceSchemeRegistry();

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

function page(overrides: Record<string, unknown> = {}) {
    return {
        id: "orders",
        type: "page",
        title: "Orders",
        path: "/orders",
        name: "orders",
        component: "OrdersPage",
        permission: { action: "read", resource: "ui:page:orders" },
        ...overrides,
    };
}

function binding(overrides: Record<string, unknown> = {}) {
    return {
        id: "orders-read",
        method: "GET",
        path: "/api/orders",
        purpose: "entry",
        authorization: {
            mode: "all",
            permissions: [{ action: "read", resource: "api:GET:/api/orders" }],
        },
        ...overrides,
    };
}

describe("menu node input contracts", () => {
    it("normalizes optional metadata and nullable impact fields", () => {
        const created = normalizeMenuNodeCreateInput(page({
            parentId: null,
            icon: "orders",
            status: "deprecated",
            hidden: true,
            i18nKey: "menu.orders",
            meta: { feature: "orders" },
            dataPermissions: [{ action: "read", resource: "db:orders", label: "Own orders" }],
        }) as never, schemes);
        expect(created).toMatchObject({ status: "deprecated", hidden: true, icon: "orders" });

        expect(normalizeMenuNodeUpdateInput({
            title: "Orders v2",
            component: null,
            icon: null,
            hidden: false,
            i18nKey: null,
            meta: null,
        })).toEqual({
            title: "Orders v2",
            component: null,
            icon: null,
            hidden: false,
            i18nKey: null,
            meta: null,
        });

        const impact = normalizeMenuNodeImpactUpdateRequest({
            patch: {
                title: "Orders v3",
                component: null,
                icon: null,
                hidden: false,
                i18nKey: null,
                meta: null,
                path: null,
                name: null,
                code: null,
                url: null,
                permission: null,
                dataPermissions: null,
            },
        }, schemes);
        expect(impact.patch).toMatchObject({ path: null, name: null, code: null, permission: null });
    });

    it("rejects missing, unsupported, malformed, and oversized node values", () => {
        const invalid = [
            {},
            { id: "root", type: "unknown", title: "Root" },
            page({ title: "" }),
            page({ path: "orders" }),
            page({ path: "/orders\u0000" }),
            page({ status: "archived" }),
            page({ hidden: "false" }),
            page({ permission: { action: "read" } }),
            page({ dataPermissions: [{ action: "invoke", resource: "db:orders" }] }),
            page({ dataPermissions: [{ action: "read", resource: "api:GET:/orders" }] }),
        ];
        for (const value of invalid) {
            expectPermissionError(() => normalizeMenuNodeCreateInput(value as never, schemes));
        }

        expectPermissionError(() => normalizeMenuNodeCreateInput(page({ title: "x".repeat(513) }) as never, schemes), "LIMIT_EXCEEDED");
        expectPermissionError(() => normalizeMenuNodeCreateInput(page({ meta: { value: "x".repeat(33_000) } }) as never, schemes), "LIMIT_EXCEEDED");

        let deep: Record<string, unknown> = { value: true };
        for (let index = 0; index < 9; index += 1) deep = { child: deep };
        expectPermissionError(() => normalizeMenuNodeCreateInput(page({ meta: deep }) as never, schemes));
    });

    it("enforces node type-specific required and forbidden fields", () => {
        const invalid = [
            { id: "directory", type: "directory", title: "Directory", url: "https://example.com" },
            { id: "menu", type: "menu", title: "Menu", path: "/menu", permission: { action: "read", resource: "ui:menu:menu" } },
            { id: "page", type: "page", title: "Page", path: "/page", name: "page", permission: { action: "read", resource: "ui:page:page" } },
            { id: "button", type: "button", title: "Button", code: "button", permission: { action: "read", resource: "ui:button:button" }, path: "/button" },
            { id: "external", type: "external", title: "External", permission: { action: "read", resource: "ui:external:external" } },
            { id: "iframe", type: "iframe", title: "Frame", url: "https://example.com", path: "/frame", permission: { action: "read", resource: "ui:iframe:frame" } },
        ];
        for (const value of invalid) {
            expectPermissionError(() => normalizeMenuNodeCreateInput(value as never, schemes));
        }
    });

    it("validates direct path and URL normalization", () => {
        expect(normalizeDeclaredPath(" //orders//?tab=all ", "path")).toBe("/orders");
        expect(normalizeHttpUrl(" https://example.com/orders ", "url")).toBe("https://example.com/orders");
        expectPermissionError(() => normalizeDeclaredPath("relative", "path"));
        expectPermissionError(() => normalizeHttpUrl("not a URL", "url"));
        expectPermissionError(() => normalizeHttpUrl("ftp://example.com", "url"));
    });

    it("rejects empty impact updates and unsafe button rewrites", () => {
        expectPermissionError(() => normalizeMenuNodeImpactUpdateRequest({} as never, schemes));
        expectPermissionError(() => normalizeMenuNodeImpactUpdateRequest({ patch: {} }, schemes));
        expectPermissionError(() => normalizeMenuNodeImpactUpdateRequest({ patch: { code: "__proto__" } }, schemes));
        expectPermissionError(() => normalizeMenuNodeUpdateInput({ hidden: "false" } as never));
    });
});

describe("menu movement, repair, and filters", () => {
    it("normalizes complete move, reorder, remove, repair, and filter inputs", () => {
        expect(normalizeMenuMoveInput({ nodeId: "orders", parentId: null, afterId: "home" })).toEqual({
            nodeId: "orders",
            parentId: null,
            afterId: "home",
        });
        expect(normalizeMenuReorderInput({ parentId: null, orderedNodeIds: ["home", "orders"] })).toEqual({
            parentId: null,
            orderedNodeIds: ["home", "orders"],
        });
        expect(normalizeMenuRemoveInput({ cascade: false })).toEqual({ cascade: false, sourceRewrite: { mode: "reject" } });
        expect(normalizeStaleRepairInput({
            referenceIds: ["parent:orders"],
            resolutions: { "parent:orders": { action: "remove" } },
        })).toMatchObject({ referenceIds: ["parent:orders"] });
        expect(normalizeMenuNodeFilter({
            parentId: null,
            type: ["page", "menu"],
            status: "enabled",
            hidden: false,
            search: "orders",
        })).toEqual({ parentId: null, type: ["menu", "page"], status: "enabled", hidden: false, search: "orders" });
        expect(normalizeMenuNodeFilter({ type: "button" })).toEqual({ type: "button" });
    });

    it("rejects incomplete/self-referential movement and malformed repairs", () => {
        const invalidMoves = [
            {},
            { nodeId: "orders" },
            { nodeId: "orders", parentId: "orders" },
            { nodeId: "orders", parentId: null, beforeId: "orders" },
            { nodeId: "orders", parentId: null, afterId: "orders" },
        ];
        for (const value of invalidMoves) expectPermissionError(() => normalizeMenuMoveInput(value as never));
        expectPermissionError(() => normalizeMenuReorderInput({ parentId: null } as never));
        expectPermissionError(() => normalizeMenuRemoveInput({} as never));
        expectPermissionError(() => normalizeMenuRemoveInput({ cascade: "yes" } as never));
        expectPermissionError(() => normalizeStaleRepairInput({ referenceIds: [] } as never));
        expectPermissionError(() => normalizeStaleRepairInput({
            referenceIds: ["parent:orders"],
            resolutions: { "parent:orders": { action: "remove", replacementId: "root" } },
        } as never));
        expectPermissionError(() => normalizeStaleRepairInput({
            referenceIds: ["parent:orders"],
            resolutions: { "parent:orders": { action: "rebind" } },
        } as never));
    });

    it("rejects unsupported, duplicate, and malformed node filters", () => {
        expectPermissionError(() => normalizeMenuNodeFilter({ type: ["menu", "menu"] }));
        expectPermissionError(() => normalizeMenuNodeFilter({ type: ["unknown"] } as never));
        expectPermissionError(() => normalizeMenuNodeFilter({ type: "unknown" } as never));
        expectPermissionError(() => normalizeMenuNodeFilter({ status: "archived" } as never));
        expectPermissionError(() => normalizeMenuNodeFilter({ search: " " }));
    });
});

describe("API binding and manifest input contracts", () => {
    it("normalizes optional owner, status, description, update, removal, and filter fields", () => {
        const created = normalizeApiBindingCreateInput(binding({
            status: "disabled",
            description: "List orders",
            owners: [{ type: "menu", id: "orders", required: true, availabilityGroup: "orders", availabilityMode: "all" }],
            canonicalOwner: { type: "menu", id: "orders" },
        }) as never, schemes);
        expect(created).toMatchObject({ status: "disabled", description: "List orders" });
        expect(normalizeApiBindingUpdateInput({ purpose: "detail", description: null })).toEqual({ purpose: "detail", description: null });
        expect(normalizeApiBindingRemoveInput({})).toEqual({ sourceRewrite: { mode: "reject" } });
        expect(normalizeApiBindingFilter({
            method: "get",
            path: "//api//orders/",
            status: "enabled",
            purpose: "entry",
            ownerId: "orders",
        })).toEqual({ method: "GET", path: "/api/orders", status: "enabled", purpose: "entry", ownerId: "orders" });
    });

    it("rejects missing required fields and invalid authorization/owner contracts", () => {
        for (const key of ["id", "method", "path", "purpose", "authorization"] as const) {
            const value = binding();
            delete value[key];
            expectPermissionError(() => normalizeApiBindingCreateInput(value as never, schemes));
        }
        const invalid = [
            binding({ method: "GET /orders" }),
            binding({ purpose: "other" }),
            binding({ authorization: { mode: "some", permissions: [] } }),
            binding({ authorization: { mode: "all", permissions: [] } }),
            binding({ authorization: { mode: "all", permissions: [{ action: "read" }] } }),
            binding({ owners: [{ type: "service", id: "orders", required: true }] }),
            binding({ owners: [{ type: "menu", id: "orders", required: true, availabilityGroup: "g", availabilityMode: "some" }] }),
            binding({ owners: [{ type: "menu", id: "orders", required: "yes" }] }),
            binding({ canonicalOwner: { type: "menu" } }),
        ];
        for (const value of invalid) expectPermissionError(() => normalizeApiBindingCreateInput(value as never, schemes));
    });

    it("validates metadata and impact update shapes", () => {
        expectPermissionError(() => normalizeApiBindingUpdateInput({}));
        expectPermissionError(() => normalizeApiBindingUpdateInput({ purpose: "other" } as never));
        expectPermissionError(() => normalizeApiBindingImpactUpdateRequest({} as never, schemes));
        expectPermissionError(() => normalizeApiBindingImpactUpdateRequest({ patch: {} }, schemes));
        expectPermissionError(() => normalizeApiBindingImpactUpdateRequest({ patch: { purpose: "other" } } as never, schemes));
        expectPermissionError(() => normalizeApiBindingImpactUpdateRequest({
            patch: {
                owners: [{ type: "menu", id: "orders", required: true }],
                canonicalOwner: { type: "page", id: "orders" },
            },
        }, schemes));

        const normalized = normalizeApiBindingImpactUpdateRequest({
            patch: {
                description: null,
                method: "post",
                path: "/api/orders",
                authorization: { mode: "any", permissions: [{ action: "create", resource: "api:POST:/api/orders" }] },
                owners: [],
                canonicalOwner: null,
            },
        }, schemes);
        expect(normalized.patch).toMatchObject({ method: "POST", canonicalOwner: null, description: null });
    });

    it("requires replacement inventories and valid manifest mode/order contracts", () => {
        expectPermissionError(() => normalizeApiBindingReplaceInput({} as never, schemes));
        expect(normalizeApiBindingReplaceInput({ bindings: [binding({ id: "z" }), binding({ id: "a" })] } as never, schemes)
            .bindings.map((entry) => entry.id)).toEqual(["a", "z"]);

        expectPermissionError(() => normalizeMenuManifestInput({
            schemaVersion: 2,
            mode: "append",
            nodes: [],
            apiBindings: [],
        } as never, schemes));
        expectPermissionError(() => normalizeMenuManifestInput({
            schemaVersion: 2,
            mode: "merge",
            nodes: [{ id: "root", type: "directory", title: "Root" }],
            apiBindings: [],
        } as never, schemes));
        expectPermissionError(() => normalizeMenuManifestInput({
            schemaVersion: 2,
            mode: "merge",
            nodes: [{ id: "root", type: "directory", title: "Root", order: -1 }],
            apiBindings: [],
        } as never, schemes));
        expectPermissionError(() => normalizeApiBindingFilter({ purpose: "other" } as never));
    });
});
