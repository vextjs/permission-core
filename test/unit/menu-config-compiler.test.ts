import { describe, expect, it } from "vitest";
import {
    aggregateCompiledMenuConfigs,
    compileMenuConfigInput,
    normalizeMenuConfigInput,
} from "../../src/menu";
import type { MenuConfigInput } from "../../src";

function expectPermissionError(callback: () => unknown, code: string, field?: string) {
    let thrown: unknown;
    try {
        callback();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toMatchObject({
        code,
        ...(field === undefined ? {} : { details: { field } }),
    });
}

function ordersConfig(configId = "main"): MenuConfigInput {
    return {
        configId,
        title: "Main console",
        menus: [{
            id: "orders",
            title: "Orders",
            views: [{
                id: "orders-list",
                type: "page",
                title: "Order list",
                path: "/orders",
                component: "OrdersPage",
                load: [{
                    resource: "api:get:/api/orders",
                    response: {
                        target: "items",
                        preserve: ["pageSize", "total", "page"],
                        fields: [
                            { field: "orderNo", title: "Order No." },
                            { field: "status", title: "Status" },
                            { field: "customer.name", title: "Customer" },
                        ],
                    },
                }],
                actions: [
                    { title: "Export", resource: "api:POST:/api/orders/export" },
                    { title: "Archive", resource: "ui:button:orders.archive" },
                ],
            }],
        }],
    };
}

describe("menu config compiler", () => {
    it("normalizes the high-level config and solidifies defaults for snapshots", () => {
        const snapshot = normalizeMenuConfigInput(ordersConfig(), { revision: 7, createdAt: 100, updatedAt: 120 });
        const view = snapshot.menus[0]!.views[0]!;

        expect(snapshot).toMatchObject({
            configId: "main",
            title: "Main console",
            revision: 7,
            createdAt: 100,
            updatedAt: 120,
        });
        expect(snapshot.aggregateDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(view.navigation).toBe(true);
        expect(view.enabled).toBe(true);
        expect(view.load[0]).toMatchObject({
            resource: "api:GET:/api/orders",
            response: {
                target: "items",
                preserve: ["page", "pageSize", "total"],
            },
        });
        expect(view.load[0]!.response!.fields.map((field) => field.field)).toEqual(["orderNo", "status", "customer.name"]);
        expect(view.load[0]!.response!.fields.every((field) => /^[A-Za-z0-9_-]{43}$/u.test(field.fieldId.slice("mc-field-".length))))
            .toBe(true);
    });

    it("compiles a config into a private v2 replace manifest and response catalog", () => {
        const compiled = compileMenuConfigInput(ordersConfig());
        const target = aggregateCompiledMenuConfigs([compiled]);
        const binding = target.manifest.apiBindings.find((item) => item.path === "/api/orders")!;
        const actionBinding = target.manifest.apiBindings.find((item) => item.path === "/api/orders/export")!;
        const response = target.responseCatalog.get("api:GET:/api/orders");

        expect(target.manifest.schemaVersion).toBe(2);
        expect(target.manifest.mode).toBe("replace");
        expect(target.manifest.nodes.some((node) => node.id.startsWith("mc-m-") && node.type === "directory")).toBe(true);
        expect(target.manifest.nodes.some((node) => node.id.startsWith("mc-v-") && node.type === "page" && node.path === "/orders")).toBe(true);
        expect(target.manifest.nodes.some((node) => node.id.startsWith("mc-a-") && node.type === "button")).toBe(true);
        expect(binding).toMatchObject({
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/orders" }] },
        });
        expect(binding.canonicalOwner).toEqual(binding.owners![0] && { type: binding.owners![0].type, id: binding.owners![0].id });
        expect(actionBinding.purpose).toBe("operation");
        expect(response?.target).toBe("items");
        expect(response?.preserve).toEqual(["page", "pageSize", "total"]);
        expect(response?.fields.map((field) => field.field)).toEqual(["customer.name", "orderNo", "status"]);
        expect(target.metrics).toMatchObject({
            menuConfigCount: 1,
            apiBindingCount: 2,
            responseFieldCount: 3,
            responseFieldOwnerCount: 3,
        });
    });

    it("merges shared endpoints by canonical method/path and keeps operation purpose dominant", () => {
        const second: MenuConfigInput = {
            configId: "sales",
            menus: [{
                id: "sales",
                title: "Sales",
                views: [{
                    id: "sales-orders",
                    type: "page",
                    title: "Sales orders",
                    path: "/sales/orders",
                    component: "SalesOrdersPage",
                    actions: [{
                        title: "Refresh",
                        resource: "api:GET:/api/orders",
                        response: {
                            target: "items",
                            preserve: ["total", "page", "pageSize"],
                            fields: [
                                { field: "orderNo", title: "Order No." },
                                { field: "amount", title: "Amount" },
                            ],
                        },
                    }],
                }],
            }],
        };
        const target = aggregateCompiledMenuConfigs([
            compileMenuConfigInput(ordersConfig()),
            compileMenuConfigInput(second),
        ]);
        const binding = target.manifest.apiBindings.find((item) => item.path === "/api/orders")!;
        const response = target.responseCatalog.get("api:GET:/api/orders")!;

        expect(target.manifest.apiBindings.filter((item) => item.path === "/api/orders")).toHaveLength(1);
        expect(binding.purpose).toBe("operation");
        expect(binding.owners).toHaveLength(2);
        expect(response.fields.map((field) => field.field)).toEqual(["amount", "customer.name", "orderNo", "status"]);
        expect(response.fields.find((field) => field.field === "orderNo")!.owners).toHaveLength(2);
    });

    it("allows distinct response targets for the same endpoint and rejects incompatible same-target definitions", () => {
        const distinctTarget = ordersConfig("other");
        distinctTarget.menus[0]!.views![0]!.path = "/other/orders";
        distinctTarget.menus[0]!.views![0]!.load = [{
            resource: "api:GET:/api/orders",
            response: [{ field: "orderNo", title: "Order No." }],
        }];

        const target = aggregateCompiledMenuConfigs([
            compileMenuConfigInput(ordersConfig()),
            compileMenuConfigInput(distinctTarget),
        ]);
        expect(target.responseDefinitions.filter((response) => response.apiResource === "api:GET:/api/orders"))
            .toHaveLength(2);

        const incompatible = ordersConfig("other-conflict");
        incompatible.menus[0]!.views![0]!.path = "/other-conflict/orders";
        incompatible.menus[0]!.views![0]!.load![0]!.response = {
            target: "items",
            preserve: ["total"],
            fields: [{ field: "orderNo", title: "Order number changed" }],
        };
        expectPermissionError(() => aggregateCompiledMenuConfigs([
            compileMenuConfigInput(ordersConfig()),
            compileMenuConfigInput(incompatible),
        ]), "INVALID_ARGUMENT");
    });

    it("compiles auxiliary views to hidden private pages and rejects manual navigation", () => {
        const config: MenuConfigInput = {
            configId: "dialogs",
            menus: [{
                id: "orders",
                title: "Orders",
                views: [{
                    id: "order-detail",
                    type: "dialog",
                    title: "Order detail",
                    component: "OrderDetailDialog",
                    load: [{ resource: "api:GET:/api/orders/:id" }],
                }],
            }],
        };
        const target = aggregateCompiledMenuConfigs([compileMenuConfigInput(config)]);
        const dialogNode = target.manifest.nodes.find((node) => node.id.startsWith("mc-v-"))!;

        expect(dialogNode).toMatchObject({
            type: "page",
            hidden: true,
            component: "OrderDetailDialog",
        });
        expect(dialogNode.path).toMatch(/^\/_permission-core\/aux\//u);

        expectPermissionError(() => normalizeMenuConfigInput({
            ...config,
            menus: [{
                id: "orders",
                title: "Orders",
                views: [{
                    id: "order-detail",
                    type: "dialog",
                    title: "Order detail",
                    component: "OrderDetailDialog",
                    navigation: true,
                }],
            }],
        }), "INVALID_ARGUMENT");
    });

    it("rejects duplicate identities and same-view resource collisions", () => {
        expectPermissionError(() => normalizeMenuConfigInput({
            configId: "bad",
            menus: [{
                id: "orders",
                title: "Orders",
                views: [{
                    id: "orders-list",
                    type: "page",
                    title: "Order list",
                    path: "/orders",
                    component: "OrdersPage",
                    load: [{ resource: "api:GET:/api/orders" }],
                    actions: [{ title: "Duplicate", resource: "api:GET:/api/orders" }],
                }],
            }],
        }), "INVALID_ARGUMENT");

        expectPermissionError(() => normalizeMenuConfigInput({
            configId: "bad",
            menus: [
                { id: "orders", title: "Orders", views: [{ id: "a", type: "page", title: "A", path: "/a", component: "A" }] },
                { id: "orders", title: "Orders 2", views: [{ id: "b", type: "page", title: "B", path: "/b", component: "B" }] },
            ],
        }), "INVALID_ARGUMENT");

        expectPermissionError(() => normalizeMenuConfigInput({
            configId: "bad",
            menus: [{
                id: "orders",
                title: "Orders",
                views: [{
                    id: "orders-list",
                    type: "page",
                    title: "Order list",
                    path: "/orders",
                    component: "OrdersPage",
                    actions: [{ title: "Open detail", resource: "ui:button:orders.detail", opens: "missing-detail" }],
                }],
            }],
        }), "INVALID_ARGUMENT", "config.menus.views.actions.opens");
    });

    it("rejects duplicate compiled paths across configs", () => {
        const other = ordersConfig("other");
        expectPermissionError(() => aggregateCompiledMenuConfigs([
            compileMenuConfigInput(ordersConfig()),
            compileMenuConfigInput(other),
        ]), "INVALID_ARGUMENT", "configs");
    });
});
