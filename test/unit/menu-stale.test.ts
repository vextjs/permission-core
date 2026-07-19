import { describe, expect, it } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import {
    apiBindingDocumentFromInput,
    collectStructuralStaleReferences,
    MAX_MENU_DEPTH,
    menuNodeDocumentFromInput,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
} from "../../src/menu";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";

describe("structural stale reference model", () => {
    it("detects parent and API-owner faults with stable opaque identities", () => {
        const schemes = new ResourceSchemeRegistry();
        const scope = normalizeScope({ tenantId: "tenant-stale-model" });
        const scopeKey = createScopeKey(scope);
        const node = (
            input: Parameters<typeof normalizeMenuNodeCreateInput>[0],
            order = 0,
        ) => menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput(input, schemes),
            order,
            1,
            1,
        );
        const nodes = [
            node({ id: "root", type: "directory", title: "Root" }),
            node({ id: "orphan", parentId: "missing", type: "directory", title: "Orphan" }),
            node({
                id: "wrong-parent",
                parentId: "root",
                type: "button",
                title: "Wrong",
                code: "wrong.parent",
                permission: { action: "read", resource: "ui:button:wrong.parent" },
            }),
            node({ id: "cycle-a", parentId: "cycle-b", type: "directory", title: "A" }),
            node({ id: "cycle-b", parentId: "cycle-a", type: "directory", title: "B" }),
            ...Array.from({ length: 65 }, (_, index) => node({
                id: `deep-${index}`,
                ...(index === 0 ? {} : { parentId: `deep-${index - 1}` }),
                type: "directory",
                title: `Deep ${index}`,
            })),
        ];
        const binding = apiBindingDocumentFromInput(
            scopeKey,
            scope,
            normalizeApiBindingCreateInput({
                id: "orders-api",
                method: "GET",
                path: "/orders",
                purpose: "entry",
                authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/orders" }] },
                owners: [
                    { type: "menu", id: "missing-owner", required: true },
                    { type: "page", id: "root", required: true },
                ],
            }, schemes),
            1,
            1,
        );

        const first = collectStructuralStaleReferences({ nodes, bindings: [binding] });
        const second = collectStructuralStaleReferences({ nodes, bindings: [binding] });
        expect(first.map((record) => record.reference)).toEqual(second.map((record) => record.reference));
        expect(first.map((record) => record.reference.reason)).toEqual(expect.arrayContaining([
            "parent-missing",
            "parent-type-mismatch",
            "parent-cycle",
            "parent-depth-exceeded",
            "api-owner-missing",
            "api-owner-type-mismatch",
        ]));
        expect(first.map((record) => record.reference.type)).toEqual(
            [...first.map((record) => record.reference.type)].sort(),
        );
        expect(first.every((record) => /^stale_(?:api_owner|parent)_[A-Za-z0-9_-]{43}$/.test(record.reference.id))).toBe(true);
        expect(first.every((record) => Buffer.byteLength(record.reference.id, "utf8") <= 128)).toBe(true);
    });

    it("handles a maximum-size corrupt depth chain with iterative memoized ancestry", () => {
        const schemes = new ResourceSchemeRegistry();
        const scope = normalizeScope({ tenantId: "tenant-stale-max-depth" });
        const scopeKey = createScopeKey(scope);
        const nodes = Array.from({ length: 10_000 }, (_, index) => menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput({
                id: `deep-${String(index).padStart(5, "0")}`,
                ...(index === 0 ? {} : { parentId: `deep-${String(index - 1).padStart(5, "0")}` }),
                type: "directory",
                title: `Deep ${index}`,
            }, schemes),
            0,
            1,
            1,
        ));

        const records = collectStructuralStaleReferences({ nodes, bindings: [] });

        expect(records).toHaveLength(nodes.length - MAX_MENU_DEPTH);
        expect(new Set(records.map((record) => record.reference.reason))).toEqual(new Set(["parent-depth-exceeded"]));
    }, 30_000);
});
