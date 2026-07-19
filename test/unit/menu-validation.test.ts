import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import {
    normalizeApiBindingCreateInput,
    normalizeApiBindingImpactUpdateRequest,
    normalizeApiBindingReplaceInput,
    normalizeDeclaredPath,
    normalizeMenuManifestInput,
    normalizeMenuGrantIntent,
    normalizeMenuMoveInput,
    normalizeMenuNodeCreateInput,
    normalizeMenuNodeImpactUpdateRequest,
    normalizeMenuNodeUpdateInput,
    normalizeMenuRemoveInput,
    normalizeMenuReorderInput,
    normalizeSourceRewriteDecision,
    normalizeStaleRepairInput,
    normalizeApiBindingFilter,
    normalizePersistedMenuGrantSnapshot,
} from "../../src/menu";

const schemes = new ResourceSchemeRegistry();

describe("v2 menu input validation", () => {
    it("normalizes every menu node type with explicit defaults", () => {
        const nodes = [
            { id: "root", type: "directory", title: "Root" },
            { id: "orders", type: "menu", title: "Orders", path: "/orders/", name: "orders", permission: { action: "read", resource: "ui:menu:orders" } },
            { id: "orders-page", type: "page", title: "Orders", path: "/orders/list", name: "orders-list", component: "OrdersPage", permission: { action: "read", resource: "ui:page:orders" } },
            { id: "orders-create", type: "button", title: "Create", code: "orders.create", permission: { action: "create", resource: "ui:button:orders.create" } },
            { id: "help", type: "external", title: "Help", url: "https://example.com/help", permission: { action: "read", resource: "ui:external:help" } },
            { id: "report", type: "iframe", title: "Report", path: "/report", name: "report", url: "https://example.com/report", permission: { action: "read", resource: "ui:iframe:report" } },
        ] as const;
        const normalized = nodes.map((node) => normalizeMenuNodeCreateInput(node, schemes));
        expect(normalized.map((node) => node.type)).toEqual(["directory", "menu", "page", "button", "external", "iframe"]);
        expect(normalized[1]).toMatchObject({ path: "/orders", parentId: null, status: "enabled", hidden: false });
        expect(Object.isFrozen(normalized[1])).toBe(true);
    });

    it("rejects type-field drift, missing permission, unsafe code, and non-http URL", () => {
        const invalid = [
            { id: "d", type: "directory", title: "D", path: "/d" },
            { id: "m", type: "menu", title: "M", path: "/m", name: "m" },
            { id: "p", type: "page", title: "P", path: "/p", name: "p", component: "P", code: "x", permission: { action: "read", resource: "ui:page:p" } },
            { id: "b", type: "button", title: "B", code: "__proto__", permission: { action: "read", resource: "ui:button:b" } },
            { id: "x", type: "external", title: "X", url: "javascript:alert(1)", permission: { action: "read", resource: "ui:external:x" } },
        ];
        for (const value of invalid) {
            expect(() => normalizeMenuNodeCreateInput(value as never, schemes)).toThrowError(PermissionCoreError);
        }
    });

    it("accepts bounded database permission templates and rejects API/custom escape paths", () => {
        const menu = normalizeMenuNodeCreateInput({
            id: "orders",
            type: "menu",
            title: "Orders",
            path: "/orders",
            name: "orders",
            permission: { action: "read", resource: "ui:menu:orders" },
            dataPermissions: [
                { action: "read", resource: "db:orders", where: { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" } },
                { action: "update", resource: "db:orders:field:status" },
            ],
        }, schemes);
        expect(menu.dataPermissions).toHaveLength(2);
        expect(() => normalizeMenuNodeCreateInput({
            ...menu,
            dataPermissions: [{ action: "read", resource: "api:GET:/orders" }],
        } as never, schemes)).toThrowError(PermissionCoreError);
    });

    it("normalizes API route authorization separately from owner availability", () => {
        const binding = normalizeApiBindingCreateInput({
            id: "orders-read",
            method: " get ",
            path: "//api//orders/?page=1",
            purpose: "entry",
            authorization: {
                mode: "any",
                permissions: [
                    { action: "read", resource: "api:GET:/api/orders" },
                    { action: "read", resource: "api:GET:/api/orders" },
                ],
            },
            owners: [
                { type: "menu", id: "orders", required: true, availabilityGroup: "orders-read", availabilityMode: "any" },
                { type: "button", id: "orders.refresh", required: false },
            ],
            canonicalOwner: { type: "menu", id: "orders" },
        }, schemes);
        expect(binding).toMatchObject({ method: "GET", path: "/api/orders", status: "enabled" });
        expect(binding.authorization.permissions).toHaveLength(1);
        expect(binding.owners).toHaveLength(2);
    });

    it("rejects malformed owner groups, duplicate owners, and missing canonical owners", () => {
        const base = {
            id: "orders-read",
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/orders" }] },
        } as const;
        const invalid = [
            { ...base, owners: [{ type: "menu", id: "orders", required: false, availabilityGroup: "g", availabilityMode: "any" }] },
            { ...base, owners: [{ type: "menu", id: "orders", required: true, availabilityGroup: "g" }] },
            { ...base, owners: [{ type: "menu", id: "orders", required: true }, { type: "menu", id: "orders", required: true }] },
            { ...base, owners: [], canonicalOwner: { type: "menu", id: "orders" } },
        ];
        for (const value of invalid) {
            expect(() => normalizeApiBindingCreateInput(value as never, schemes)).toThrowError(PermissionCoreError);
        }
    });

    it("rejects malformed API filters and nested canonical-owner objects before traps", () => {
        expect(() => normalizeApiBindingFilter({ method: "GET /orders" })).toThrowError(PermissionCoreError);
        let traps = 0;
        const canonicalOwner = new Proxy({ type: "menu", id: "orders" }, {
            ownKeys() {
                traps += 1;
                return [];
            },
        });
        expect(() => normalizeApiBindingCreateInput({
            id: "orders-read",
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/orders" }] },
            owners: [{ type: "menu", id: "orders", required: true }],
            canonicalOwner,
        } as never, schemes)).toThrowError(PermissionCoreError);
        expect(traps).toBe(0);
    });

    it("does not inspect Proxy traps and validates canonical declared paths", () => {
        let traps = 0;
        const proxy = new Proxy({ id: "x", type: "directory", title: "X" }, {
            ownKeys() {
                traps += 1;
                return [];
            },
        });
        expect(() => normalizeMenuNodeCreateInput(proxy as never, schemes)).toThrowError(PermissionCoreError);
        expect(traps).toBe(0);
        expect(normalizeDeclaredPath("//orders///:id/?tab=a", "path")).toBe("/orders/:id");
    });

    it("normalizes stable menu grant intent and persisted snapshot identities", () => {
        const semanticKey = digestCanonical({ effect: "allow", action: "read", resource: "api:GET:/orders" });
        const intent = normalizeMenuGrantIntent({
            anchorId: "orders",
            include: { descendants: true, buttons: false, apis: "required", dataPermissions: false },
            apiChoices: {
                bindingIds: ["orders-read", "orders-read"],
                permissionsByBinding: { "orders-read": [semanticKey, semanticKey] },
            },
        });
        const snapshot = normalizePersistedMenuGrantSnapshot({
            contributionContractDigest: digestCanonical({ contract: 1 }),
            contributionDigest: digestCanonical({ contributions: 1 }),
            contributingAssetCount: 1,
            contributingBindingCount: 1,
            contributingAssetIds: ["orders"],
            contributingBindingIds: ["orders-read"],
        });

        expect(intent.apiChoices.bindingIds).toEqual(["orders-read"]);
        expect(intent.apiChoices.permissionsByBinding["orders-read"]).toEqual([semanticKey]);
        expect(snapshot).toMatchObject({ contributingAssetCount: 1, contributingBindingCount: 1 });
        expect(Object.isFrozen(intent.apiChoices.permissionsByBinding)).toBe(true);
    });

    it("rejects incomplete grant choices and snapshot count drift", () => {
        expect(() => normalizeMenuGrantIntent({
            anchorId: "orders",
            include: { descendants: false, buttons: false, apis: "none" },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        })).toThrowError(PermissionCoreError);
        expect(() => normalizePersistedMenuGrantSnapshot({
            contributionContractDigest: digestCanonical([]),
            contributionDigest: digestCanonical([]),
            contributingAssetCount: 2,
            contributingBindingCount: 0,
            contributingAssetIds: ["orders"],
            contributingBindingIds: [],
        })).toThrowError(PermissionCoreError);
    });

    it("normalizes metadata and impact patches with explicit null and reject semantics", () => {
        expect(normalizeMenuNodeUpdateInput({ title: "Updated", icon: null })).toEqual({ title: "Updated", icon: null });
        const request = normalizeMenuNodeImpactUpdateRequest({
            patch: { path: "/orders-v2", permission: { action: "read", resource: "ui:page:orders-v2" } },
        }, schemes);
        expect(request).toMatchObject({
            patch: { path: "/orders-v2" },
            sourceRewrite: { mode: "reject" },
        });
        expect(() => normalizeMenuNodeUpdateInput({})).toThrowError(PermissionCoreError);
        expect(() => normalizeMenuNodeImpactUpdateRequest({ patch: {} }, schemes)).toThrowError(PermissionCoreError);
    });

    it("keeps move order semantic and requires exact stale resolution keys", () => {
        expect(normalizeMenuMoveInput({ nodeId: "child", parentId: "root", beforeId: "sibling" })).toEqual({
            nodeId: "child",
            parentId: "root",
            beforeId: "sibling",
        });
        expect(normalizeMenuReorderInput({ parentId: "root", orderedNodeIds: ["b", "a"] }).orderedNodeIds).toEqual(["b", "a"]);
        expect(() => normalizeMenuMoveInput({ nodeId: "child", parentId: "root", beforeId: "a", afterId: "b" })).toThrowError(PermissionCoreError);
        expect(() => normalizeMenuReorderInput({ parentId: "root", orderedNodeIds: ["a", "a"] })).toThrowError(PermissionCoreError);
        expect(normalizeStaleRepairInput({
            referenceIds: ["parent:child"],
            resolutions: { "parent:child": { action: "rebind", replacementId: "root" } },
        })).toMatchObject({ resolutions: { "parent:child": { action: "rebind", replacementId: "root" } } });
        expect(() => normalizeStaleRepairInput({
            referenceIds: ["parent:child"],
            resolutions: { extra: { action: "remove" } },
        })).toThrowError(PermissionCoreError);
        expect(() => normalizeStaleRepairInput({
            referenceIds: ["parent:child"],
            resolutions: {
                "parent:child": {
                    action: "rebind",
                    replacementId: "root",
                    rule: { effect: "allow", action: "read", resource: "ui:page:orders" },
                },
            },
        } as never)).toThrowError(PermissionCoreError);
        expect(() => normalizeStaleRepairInput({
            referenceIds: ["parent:child"],
            resolutions: { "parent:child": { action: "remove" } },
            sourceRewrite: { mode: "reject" },
        } as never)).toThrowError(PermissionCoreError);
    });

    it("enforces source rewrite resolution shape and defaults destructive requests to reject", () => {
        const semanticKey = digestCanonical({ replacement: true });
        expect(normalizeSourceRewriteDecision({
            mode: "apply",
            resolutions: {
                "source-one": { action: "replace", replacementSemanticKey: semanticKey },
                "source-two": { action: "revoke" },
            },
        })).toMatchObject({ mode: "apply" });
        expect(normalizeMenuRemoveInput({ cascade: true })).toEqual({ cascade: true, sourceRewrite: { mode: "reject" } });
        expect(() => normalizeSourceRewriteDecision({ mode: "reject", resolutions: {} } as never)).toThrowError(PermissionCoreError);
        expect(() => normalizeSourceRewriteDecision({
            mode: "apply",
            resolutions: { source: { action: "revoke", replacementSemanticKey: semanticKey } },
        } as never)).toThrowError(PermissionCoreError);
    });

    it("normalizes API impact and full replacement inventories without conflating any/all layers", () => {
        const request = normalizeApiBindingImpactUpdateRequest({
            patch: {
                method: "post",
                authorization: { mode: "any", permissions: [{ action: "create", resource: "api:POST:/orders" }] },
                owners: [{ type: "page", id: "orders", required: true, availabilityGroup: "orders-api", availabilityMode: "all" }],
                canonicalOwner: { type: "page", id: "orders" },
            },
        }, schemes);
        expect(request.patch).toMatchObject({ method: "POST", authorization: { mode: "any" } });
        const replace = normalizeApiBindingReplaceInput({
            bindings: [{
                id: "orders-create",
                method: "POST",
                path: "/orders",
                purpose: "operation",
                authorization: { mode: "all", permissions: [{ action: "create", resource: "api:POST:/orders" }] },
            }],
        }, schemes);
        expect(replace.sourceRewrite).toEqual({ mode: "reject" });
        expect(normalizeApiBindingReplaceInput({
            bindings: [replace.bindings[0]!, replace.bindings[0]!],
        }, schemes).bindings).toHaveLength(2);
    });

    it("requires schemaVersion 2 and complete manifest inventories", () => {
        const manifest = normalizeMenuManifestInput({
            schemaVersion: 2,
            mode: "replace",
            nodes: [{ id: "root", type: "directory", title: "Root", order: 0 }],
            apiBindings: [],
        }, schemes);
        expect(manifest).toMatchObject({ schemaVersion: 2, mode: "replace", sourceRewrite: { mode: "reject" } });
        expect(normalizeMenuManifestInput({
            schemaVersion: 2,
            mode: "replace",
            nodes: [manifest.nodes[0]!, manifest.nodes[0]!],
            apiBindings: [],
        }, schemes).nodes).toHaveLength(2);
        expect(() => normalizeMenuManifestInput({
            schemaVersion: 1,
            mode: "replace",
            nodes: [],
            apiBindings: [],
        } as never, schemes)).toThrowError(PermissionCoreError);
        expect(() => normalizeMenuManifestInput({ schemaVersion: 2, mode: "replace", nodes: [] } as never, schemes)).toThrowError(PermissionCoreError);
    });
});
