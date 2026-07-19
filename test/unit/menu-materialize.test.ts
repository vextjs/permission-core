import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import {
    apiBindingDocumentFromInput,
    apiBindingView,
    materializeApiBindingDocument,
    materializeMenuNodeDocument,
    materializeRoleMenuGrantDocument,
    menuNodeDocumentFromInput,
    menuNodeView,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
    validateMenuGraph,
} from "../../src/menu";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";

const scope = normalizeScope({ tenantId: "tenant-a" });
const scopeKey = createScopeKey(scope);
const schemes = new ResourceSchemeRegistry();

function nodeDocument(
    input: Parameters<typeof normalizeMenuNodeCreateInput>[0],
    order = 0,
    revision = 1,
) {
    return menuNodeDocumentFromInput(
        scopeKey,
        scope,
        normalizeMenuNodeCreateInput(input, schemes),
        order,
        revision,
        100,
    );
}

function bindingDocument(overrides: Record<string, unknown> = {}) {
    const input = normalizeApiBindingCreateInput({
        id: "orders-read",
        method: "GET",
        path: "/api/orders",
        purpose: "entry",
        authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/orders" }] },
        owners: [{ type: "menu", id: "orders", required: true }],
        canonicalOwner: { type: "menu", id: "orders" },
        ...overrides,
    } as never, schemes);
    return apiBindingDocumentFromInput(scopeKey, scope, input, 1, 100);
}

function grantDocument(overrides: Record<string, unknown> = {}) {
    return {
        scopeKey,
        scope,
        roleId: "operator",
        grantId: `grant_${digestCanonical({ roleId: "operator", anchorId: "orders" })}`,
        effect: "allow",
        intent: {
            anchorId: "orders",
            include: { descendants: true, buttons: true, apis: "required", dataPermissions: false },
            apiChoices: { bindingIds: ["orders-read"], permissionsByBinding: {} },
        },
        snapshot: {
            contributionContractDigest: digestCanonical({ contract: 1 }),
            contributionDigest: digestCanonical({ contribution: 1 }),
            contributingAssetCount: 1,
            contributingBindingCount: 1,
            contributingAssetIds: ["orders"],
            contributingBindingIds: ["orders-read"],
        },
        grantRevision: 1,
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    };
}

describe("v2 menu persisted materializers", () => {
    it("returns immutable canonical menu and API public projections", () => {
        const rawNode = nodeDocument({
            id: "orders",
            type: "menu",
            title: "Orders",
            path: "/orders",
            name: "orders",
            permission: { action: "read", resource: "ui:menu:orders" },
        });
        const node = materializeMenuNodeDocument(rawNode, scope, scopeKey, schemes);
        const binding = materializeApiBindingDocument(bindingDocument(), scope, scopeKey, schemes);

        expect(menuNodeView(node)).not.toHaveProperty("manifestItemBytes");
        expect(apiBindingView(binding)).not.toHaveProperty("scopeKey");
        expect(Object.isFrozen(node)).toBe(true);
        expect(Object.isFrozen(binding.owners)).toBe(true);
    });

    it("materializes the single canonical grant intent and snapshot aggregate", () => {
        const grant = materializeRoleMenuGrantDocument(grantDocument(), scope, scopeKey);
        expect(grant).toMatchObject({ roleId: "operator", effect: "allow", grantRevision: 1 });
        expect(grant.snapshot.contributingAssetIds).toEqual(["orders"]);
        expect(Object.isFrozen(grant.intent.apiChoices)).toBe(true);
    });

    it.each([
        ["menu manifest byte drift", () => materializeMenuNodeDocument({
            ...nodeDocument({ id: "root", type: "directory", title: "Root" }),
            manifestItemBytes: 1,
        }, scope, scopeKey, schemes)],
        ["API scope drift", () => materializeApiBindingDocument({ ...bindingDocument(), scopeKey: "x".repeat(43) }, scope, scopeKey, schemes)],
        ["grant snapshot count drift", () => materializeRoleMenuGrantDocument(grantDocument({
            snapshot: { ...grantDocument().snapshot as object, contributingAssetCount: 2 },
        }), scope, scopeKey)],
        ["grant non-canonical choices", () => materializeRoleMenuGrantDocument(grantDocument({
            intent: {
                ...grantDocument().intent as object,
                apiChoices: { bindingIds: ["z", "a"], permissionsByBinding: {} },
            },
        }), scope, scopeKey)],
        ["unexpected grant field", () => materializeRoleMenuGrantDocument(grantDocument({ injected: true }), scope, scopeKey)],
    ])("fails closed for %s", (_name, operation) => {
        expect(operation).toThrowError(PermissionCoreError);
        try {
            operation();
        } catch (error) {
            expect(error).toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        }
    });

    it("rejects Proxy documents without invoking their traps", () => {
        let traps = 0;
        const proxy = new Proxy(grantDocument(), {
            ownKeys() {
                traps += 1;
                return [];
            },
        });
        expect(() => materializeRoleMenuGrantDocument(proxy, scope, scopeKey)).toThrowError(PermissionCoreError);
        expect(traps).toBe(0);
    });

    it("rejects exotic document shapes, invalid timestamps, and non-positive revisions", () => {
        const raw = nodeDocument({ id: "root", type: "directory", title: "Root" });
        const symbol = { ...raw, [Symbol("injected")]: true };
        const hidden = { ...raw };
        Object.defineProperty(hidden, "title", { value: "Root", enumerable: false });
        for (const value of [null, [], new Date(), symbol, hidden]) {
            expect(() => materializeMenuNodeDocument(value, scope, scopeKey, schemes))
                .toThrowError(PermissionCoreError);
        }
        for (const override of [
            { scope: null },
            { createdAt: -1 },
            { updatedAt: 99 },
            { order: -1 },
            { revision: 0 },
        ]) {
            expect(() => materializeMenuNodeDocument({ ...raw, ...override }, scope, scopeKey, schemes))
                .toThrowError(PermissionCoreError);
        }
    });

    it("rejects API and grant normalization drift while preserving optional public fields", () => {
        const binding = bindingDocument();
        for (const override of [
            { method: "get" },
            { revision: 0 },
            { createdAt: -1 },
            { updatedAt: 99 },
        ]) {
            expect(() => materializeApiBindingDocument({ ...binding, ...override }, scope, scopeKey, schemes))
                .toThrowError(PermissionCoreError);
        }
        for (const override of [
            { effect: "audit" },
            { grantRevision: 0 },
            { intent: null },
            { createdAt: -1 },
            { updatedAt: 99 },
        ]) {
            expect(() => materializeRoleMenuGrantDocument(grantDocument(override), scope, scopeKey))
                .toThrowError(PermissionCoreError);
        }

        const fullNode = materializeMenuNodeDocument(nodeDocument({
            id: "orders",
            type: "menu",
            title: "Orders",
            path: "/orders",
            name: "orders",
            component: "OrdersPage",
            icon: "package",
            i18nKey: "menu.orders",
            meta: { layout: "main" },
            permission: { action: "read", resource: "ui:menu:orders" },
            dataPermissions: [{ action: "read", resource: "db:orders" }],
        }), scope, scopeKey, schemes);
        expect(menuNodeView(fullNode)).toMatchObject({
            component: "OrdersPage",
            icon: "package",
            i18nKey: "menu.orders",
        });
        const described = materializeApiBindingDocument(bindingDocument({ description: "Lists orders" }), scope, scopeKey, schemes);
        expect(apiBindingView(described).description).toBe("Lists orders");
    });
});

describe("v2 menu graph invariants", () => {
    it("accepts depth 64 and rejects depth 65", () => {
        const rows = Array.from({ length: 65 }, (_, index) => nodeDocument({
            id: `level-${index + 1}`,
            parentId: index === 0 ? null : `level-${index}`,
            type: "directory",
            title: `Level ${index + 1}`,
        }));
        expect(validateMenuGraph(rows.slice(0, 64)).depths.get("level-64")).toBe(64);
        expect(() => validateMenuGraph(rows)).toThrowError(PermissionCoreError);
    });

    it("allows the same safe button code under different parents", () => {
        const permission = { action: "read" as const, resource: "ui:menu:orders" };
        const rows = [
            nodeDocument({ id: "orders", type: "menu", title: "Orders", path: "/orders", name: "orders", permission }, 0),
            nodeDocument({ id: "reports", type: "menu", title: "Reports", path: "/reports", name: "reports", permission }, 1),
            nodeDocument({ id: "orders-view", parentId: "orders", type: "button", title: "View", code: "view", permission }, 0),
            nodeDocument({ id: "reports-view", parentId: "reports", type: "button", title: "View", code: "view", permission }, 0),
        ];
        expect(validateMenuGraph(rows).nodes.size).toBe(4);
    });
});
