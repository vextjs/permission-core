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
        const compiled = compileMenuConfigInput(config);
        const target = aggregateCompiledMenuConfigs([compiled]);
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

    it("compiles optional metadata, disabled states, action opens, and iframe api owners", () => {
        const config: MenuConfigInput = {
            configId: "operations",
            title: "Operations console",
            meta: { area: "ops" },
            menus: [{
                id: "operations",
                title: "Operations",
                enabled: false,
                icon: "dashboard",
                i18nKey: "menu.operations",
                meta: { group: "ops" },
                views: [
                    {
                        id: "orders-list",
                        type: "page",
                        title: "Orders",
                        path: "/orders",
                        component: "OrdersPage",
                        enabled: false,
                        i18nKey: "view.orders",
                        meta: { page: "orders" },
                        load: [{
                            resource: "api:GET:/api/orders",
                            meta: { source: "initial" },
                            response: {
                                target: "items",
                                fields: [
                                    { field: "orderNo", title: "Order No.", i18nKey: "field.orderNo", meta: { sensitive: false } },
                                ],
                            },
                        }],
                        actions: [{
                            title: "Open detail",
                            resource: "ui:button:orders.detail",
                            opens: "order-detail",
                            enabled: false,
                            i18nKey: "action.orders.detail",
                            meta: { placement: "row" },
                        }],
                    },
                    {
                        id: "order-detail",
                        type: "dialog",
                        title: "Order detail",
                        component: "OrderDetailDialog",
                        load: [{ resource: "api:GET:/api/orders/:id" }],
                    },
                    {
                        id: "operations-report",
                        type: "iframe",
                        title: "Report",
                        path: "/operations/report",
                        url: "https://example.com/report",
                        load: [{ resource: "api:GET:/api/reports/orders" }],
                    },
                ],
            }],
        };
        const compiled = compileMenuConfigInput(config);
        const target = aggregateCompiledMenuConfigs([compiled]);

        const menuNode = target.manifest.nodes.find((node) => node.type === "directory")!;
        const ordersNode = target.manifest.nodes.find((node) => node.type === "page" && node.path === "/orders")!;
        const actionNode = target.manifest.nodes.find((node) => node.type === "button")!;
        const iframeNode = target.manifest.nodes.find((node) => node.type === "iframe")!;
        const iframeOwnerNode = target.manifest.nodes.find((node) => node.meta?.permissionCoreApiOwner === true)!;
        const actionRef = [...compiled.actionIndex.values()].find((item) => item.resource === "ui:button:orders.detail")!;
        const response = target.responseCatalog.get("api:GET:/api/orders")!;

        expect(menuNode).toMatchObject({
            status: "disabled",
            icon: "dashboard",
            i18nKey: "menu.operations",
            meta: { group: "ops" },
        });
        expect(ordersNode).toMatchObject({
            status: "disabled",
            i18nKey: "view.orders",
            meta: { page: "orders", permissionCoreViewType: "page" },
        });
        expect(actionNode).toMatchObject({
            status: "disabled",
            i18nKey: "action.orders.detail",
            meta: { placement: "row" },
        });
        expect(actionRef.opens).toBe("order-detail");
        expect(iframeNode).toMatchObject({
            type: "iframe",
            path: "/operations/report",
            url: "https://example.com/report",
        });
        expect(iframeOwnerNode).toMatchObject({
            type: "page",
            hidden: true,
            component: "PermissionCoreApiOwner",
        });
        expect(response.fields[0]).toMatchObject({
            field: "orderNo",
            title: "Order No.",
            i18nKey: "field.orderNo",
            meta: { sensitive: false },
        });
    });

    it("rejects malformed high-level config shapes before compiling sources", () => {
        const valid = ordersConfig("invalid-shapes");
        const cases: unknown[] = [
            {},
            { configId: "missing-menus" },
            { configId: "bad-meta", meta: { big: "x".repeat(33 * 1024) }, menus: [] },
            { configId: "empty-menu", menus: [{ id: "orders", title: "Orders" }] },
            {
                configId: "children-and-views",
                menus: [{
                    id: "orders",
                    title: "Orders",
                    children: [{ id: "child", title: "Child", views: [{ id: "child-view", type: "page", title: "Child", path: "/child", component: "ChildPage" }] }],
                    views: [{ id: "orders-list", type: "page", title: "Orders", path: "/orders", component: "OrdersPage" }],
                }],
            },
            {
                ...valid,
                menus: [{ id: "orders", title: "Orders", views: [{ id: "orders-list", type: "page", title: "Orders", component: "OrdersPage" }] }],
            },
            {
                ...valid,
                menus: [{ id: "orders", title: "Orders", views: [{ id: "orders-list", type: "external", title: "Orders", url: "https://example.com", component: "OrdersPage" }] }],
            },
            {
                ...valid,
                menus: [{ id: "orders", title: "Orders", views: [{ id: "orders-list", type: "iframe", title: "Orders", url: "https://example.com" }] }],
            },
            {
                ...valid,
                menus: [{ id: "orders", title: "Orders", views: [{ id: "orders-list", type: "dialog", title: "Orders", path: "/orders", component: "OrdersDialog" }] }],
            },
            {
                ...valid,
                menus: [{
                    id: "orders",
                    title: "Orders",
                    views: [{
                        id: "orders-list",
                        type: "page",
                        title: "Orders",
                        path: "/orders",
                        component: "OrdersPage",
                        load: [
                            { resource: "api:GET:/api/orders" },
                            { resource: "api:GET:/api/orders" },
                        ],
                    }],
                }],
            },
            {
                ...valid,
                menus: [{
                    id: "orders",
                    title: "Orders",
                    views: [{
                        id: "orders-list",
                        type: "page",
                        title: "Orders",
                        path: "/orders",
                        component: "OrdersPage",
                        actions: [{ title: "Toggle", resource: "ui:button:orders.toggle", response: [{ field: "ok", title: "OK" }] }],
                    }],
                }],
            },
            {
                ...valid,
                menus: [{
                    id: "orders",
                    title: "Orders",
                    views: [{
                        id: "orders-list",
                        type: "page",
                        title: "Orders",
                        path: "/orders",
                        component: "OrdersPage",
                        load: [{ resource: "api:GET:/api/orders", response: { target: "items" } }],
                    }],
                }],
            },
            {
                ...valid,
                menus: [{
                    id: "orders",
                    title: "Orders",
                    views: [{
                        id: "orders-list",
                        type: "page",
                        title: "Orders",
                        path: "/orders",
                        component: "OrdersPage",
                        load: [{ resource: "api:GET:/api/orders", response: [
                            { field: "orderNo", title: "Order number" },
                            { field: "orderNo", title: "Order number duplicate" },
                        ] }],
                    }],
                }],
            },
        ];

        for (const value of cases) {
            expectPermissionError(() => compileMenuConfigInput(value as MenuConfigInput), "INVALID_ARGUMENT");
        }
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
