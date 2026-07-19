import { describe, expect, it } from "vitest";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../../src/persistence/documents";
import { createSemanticKey } from "../../src/rbac";
import { DetailBudgetAllocator } from "../../src/rbac/result";
import {
    normalizeMenuPermissionSelection,
    planRoleMenuSelection,
} from "../../src/menu";
import {
    menuPermissionGrantResult,
    operationGrantPlans,
    publicRoleMenuRemovals,
} from "../../src/menu/role-menu-mutations";

const scope = Object.freeze({ tenantId: "tenant-role-menu-selection" });
const scopeKey = "scope-role-menu-selection";

function node(
    nodeId: string,
    type: InternalMenuNodeDocument["type"],
    parentId: string | null,
    order: number,
    extra: Partial<InternalMenuNodeDocument> = {},
): InternalMenuNodeDocument {
    return {
        scopeKey,
        scope,
        nodeId,
        parentId,
        type,
        title: nodeId,
        order,
        status: "enabled",
        hidden: false,
        revision: 1,
        manifestItemBytes: 1,
        createdAt: 1,
        updatedAt: 1,
        ...extra,
    };
}

function binding(
    bindingId: string,
    resource: string,
    extra: Partial<InternalApiBindingDocument> = {},
): InternalApiBindingDocument {
    return {
        scopeKey,
        scope,
        bindingId,
        method: "GET",
        path: `/api/${bindingId}`,
        purpose: "entry",
        authorization: { mode: "any", permissions: [{ action: "read", resource }] },
        owners: [{
            type: "page",
            id: "orders",
            required: true,
            availabilityGroup: "orders-read",
            availabilityMode: "any",
        }],
        status: "enabled",
        revision: 1,
        manifestItemBytes: 1,
        createdAt: 1,
        updatedAt: 1,
        ...extra,
    };
}

const nodes = [
    node("root", "directory", null, 0),
    node("orders", "page", "root", 0, {
        permission: { action: "read", resource: "ui:page:orders" },
        dataPermissions: [{ action: "read", resource: "db:orders" }],
    }),
    node("orders-create", "button", "orders", 0, {
        permission: { action: "create", resource: "ui:button:orders.create" },
    }),
] as const;

function selection(overrides: {
    nodeIds?: readonly string[];
    descendants?: boolean;
    buttons?: boolean;
    apis?: "none" | "required" | "all";
    dataPermissions?: boolean;
    bindingIds?: readonly string[];
    permissionsByBinding?: Readonly<Record<string, readonly string[]>>;
} = {}) {
    return normalizeMenuPermissionSelection({
        nodeIds: overrides.nodeIds ?? ["orders"],
        include: {
            descendants: overrides.descendants ?? false,
            buttons: overrides.buttons ?? false,
            apis: overrides.apis ?? "none",
            dataPermissions: overrides.dataPermissions ?? false,
        },
        apiChoices: {
            bindingIds: overrides.bindingIds ?? [],
            permissionsByBinding: overrides.permissionsByBinding ?? {},
        },
    });
}

function groupedBindings(prefix: string, ownerId: string, count: number) {
    return Array.from({ length: count }, (_, index) => {
        const bindingId = `${prefix}-${String(index).padStart(3, "0")}`;
        return binding(bindingId, `api:GET:/api/${bindingId}`, {
            authorization: {
                mode: "all",
                permissions: [{ action: "read", resource: `api:GET:/api/${bindingId}` }],
            },
            owners: [{
                type: "page",
                id: ownerId,
                required: true,
                availabilityGroup: `${ownerId}-read`,
                availabilityMode: "any",
            }],
        });
    });
}

describe("role menu selection planning", () => {
    it("keeps descendants, buttons, and data permissions independently explicit", () => {
        const withoutButtons = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "allow",
            selection: selection({
                nodeIds: ["root"],
                descendants: true,
                buttons: false,
                dataPermissions: true,
            }),
            nodes,
            bindings: [],
        });
        expect(withoutButtons.conflicts).toEqual([]);
        expect(withoutButtons.grants).toHaveLength(1);
        expect(withoutButtons.grants[0]!.contributions.map((item) => [item.contribution, item.assetId])).toEqual([
            ["node", "orders"],
            ["data", "orders"],
        ]);

        const withButtons = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "allow",
            selection: selection({ nodeIds: ["root"], descendants: false, buttons: true }),
            nodes,
            bindings: [],
        });
        expect(withButtons.conflicts).toEqual([]);
        expect(withButtons.grants[0]!.contributions).toHaveLength(1);
        expect(withButtons.grants[0]!.contributions[0]).toMatchObject({
            contribution: "node",
            assetId: "orders-create",
        });
    });

    it("requires both availability-any and authorization-any choices for allow", () => {
        const bindings = [
            binding("orders-primary", "api:GET:/api/orders-primary"),
            binding("orders-replica", "api:GET:/api/orders-replica"),
        ];
        const missingBinding = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "allow",
            selection: selection({ apis: "required" }),
            nodes,
            bindings,
        });
        expect(missingBinding.conflicts.map((item) => item.code)).toContain("MENU_API_CHOICE_REQUIRED");
        expect(missingBinding.choiceRequirements).toHaveLength(1);

        const missingPermission = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "allow",
            selection: selection({ apis: "required", bindingIds: ["orders-primary"] }),
            nodes,
            bindings,
        });
        expect(missingPermission.conflicts.map((item) => item.code)).toContain("MENU_API_PERMISSION_CHOICE_REQUIRED");

        const semanticKey = createSemanticKey("allow", "read", "api:GET:/api/orders-primary");
        const resolved = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "allow",
            selection: selection({
                apis: "required",
                bindingIds: ["orders-primary"],
                permissionsByBinding: { "orders-primary": [semanticKey] },
            }),
            nodes,
            bindings,
        });
        expect(resolved.conflicts).toEqual([]);
        expect(resolved.choiceRequirements.every((item) => item.resolved)).toBe(true);
        expect(resolved.grants[0]!.intent.apiChoices).toEqual({
            bindingIds: ["orders-primary"],
            permissionsByBinding: { "orders-primary": [semanticKey] },
        });
        expect(resolved.grants[0]!.contributions.map((item) => item.contribution).sort()).toEqual(["api", "node"]);
    });

    it("expands every deny branch without manufacturing administrator choices", () => {
        const planned = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "deny",
            selection: selection({ apis: "required" }),
            nodes,
            bindings: [
                binding("orders-primary", "api:GET:/api/orders-primary"),
                binding("orders-replica", "api:GET:/api/orders-replica"),
            ],
        });
        expect(planned.conflicts).toEqual([]);
        expect(planned.choiceRequirements).toEqual([]);
        expect(planned.grants[0]!.contributions.filter((item) => item.contribution === "api")).toHaveLength(2);
    });

    it("rejects choice IDs that are not reachable from the selected anchors", () => {
        const planned = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "allow",
            selection: selection({ apis: "none", bindingIds: ["other-binding"] }),
            nodes,
            bindings: [],
        });
        expect(planned.conflicts).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "other-binding", code: "MENU_API_CHOICE_UNREACHABLE" }),
        ]));
    });

    it("counts the choice envelope and candidates in the shared decision budget", () => {
        const bindings = groupedBindings("orders-candidate", "orders", 100);
        const planned = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "allow",
            selection: selection({ apis: "required", bindingIds: [bindings[0]!.bindingId] }),
            nodes,
            bindings,
        });
        expect(planned.choiceRequirements).toHaveLength(1);
        expect(planned.choiceRequirements[0]!.candidates.total).toBe(100);
        expect(planned.conflicts).toContainEqual(expect.objectContaining({
            id: "menu-choice-detail-limit",
            code: "LIMIT_EXCEEDED",
        }));
    });

    it("reports an explicitly selected inactive availability candidate", () => {
        const planned = planRoleMenuSelection({
            scopeHash: scopeKey,
            roleId: "operator",
            effect: "allow",
            selection: selection({ apis: "required", bindingIds: ["orders-disabled"] }),
            nodes,
            bindings: [binding("orders-disabled", "api:GET:/api/orders-disabled", { status: "disabled" })],
        });
        expect(planned.conflicts).toContainEqual(expect.objectContaining({
            id: "orders-disabled",
            code: "API_BINDING_INACTIVE",
        }));
        expect(planned.conflicts).not.toContainEqual(expect.objectContaining({
            id: "orders-disabled",
            code: "MENU_API_CHOICE_UNREACHABLE",
        }));
    });

    it("shares the decision budget across set assignments", () => {
        const ordersBindings = groupedBindings("orders-set", "orders", 50);
        const invoiceBindings = groupedBindings("invoices-set", "invoices", 50);
        const planned = operationGrantPlans(
            scopeKey,
            "operator",
            {
                operation: "set",
                assignments: [
                    {
                        effect: "allow",
                        selection: selection({ apis: "required", bindingIds: [ordersBindings[0]!.bindingId] }),
                    },
                    {
                        effect: "allow",
                        selection: selection({
                            nodeIds: ["invoices"],
                            apis: "required",
                            bindingIds: [invoiceBindings[0]!.bindingId],
                        }),
                    },
                ],
            },
            [
                ...nodes,
                node("invoices", "page", "root", 1, {
                    permission: { action: "read", resource: "ui:page:invoices" },
                }),
            ],
            [...ordersBindings, ...invoiceBindings],
        );
        expect(planned.choices).toHaveLength(2);
        expect(planned.conflicts).toContainEqual(expect.objectContaining({
            id: "menu-choice-detail-limit",
            code: "LIMIT_EXCEEDED",
        }));
    });

    it("shares one result budget across grant and refreshed grant IDs", () => {
        const result = menuPermissionGrantResult({
            roleId: "operator",
            grantIds: Array.from({ length: 60 }, (_, index) => `grant-${index}`),
            refreshedGrantIds: Array.from({ length: 60 }, (_, index) => `refresh-${index}`),
            generatedSources: 0,
            removedSources: 0,
            generatedSemanticRules: 0,
        });
        expect(result.grantIds).toMatchObject({ total: 60, truncated: false });
        expect(result.refreshedGrantIds).toMatchObject({ total: 60, truncated: true });
        expect(result.grantIds.items).toHaveLength(60);
        expect(result.refreshedGrantIds.items).toHaveLength(40);
    });

    it("shares the preview budget across removal envelopes and nested source IDs", () => {
        const budget = new DetailBudgetAllocator();
        const removals = publicRoleMenuRemovals(
            Array.from({ length: 60 }, (_, index) => ({
                grantId: `grant-${index}`,
                sourceIds: [`source-${index}`],
            })),
            budget,
        );
        const detailBudget = budget.finish({ removals });
        expect(removals).toMatchObject({ total: 60, truncated: false });
        expect(removals.items).toHaveLength(60);
        expect(removals.items.reduce((total, item) => total + item.sourceIds.items.length, 0)).toBe(40);
        expect(detailBudget).toMatchObject({ limit: 100, returned: 100, truncated: true });
    });
});
