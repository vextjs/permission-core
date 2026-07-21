import { printExample, startExampleCore } from "./_support/host.mjs";

function collectIds(nodes) {
    return nodes.flatMap((node) => [node.id, ...collectIds(node.children)]);
}

function changed(summary) {
    return summary.inserted + summary.updated + summary.deleted > 0;
}

const menuChanges = [
    { operation: "config.create", input: { configId: "admin", title: "Admin console" } },
    { operation: "menu.create", input: { id: "orders", title: "Orders", icon: "shopping-cart" } },
    {
        operation: "view.create",
        menuId: "orders",
        input: {
            id: "orders-list",
            type: "page",
            title: "Orders",
            path: "/orders",
            component: "OrdersPage",
        },
    },
    { operation: "loadApi.add", viewId: "orders-list", input: { resource: "api:GET:/api/orders" } },
    {
        operation: "response.set",
        input: {
            owner: { ownerType: "load", viewId: "orders-list", resource: "api:GET:/api/orders" },
            response: {
                target: "items",
                preserve: ["total"],
                fields: [
                    { field: "orderNo", title: "Order number" },
                    { field: "status", title: "Status" },
                    { field: "amount", title: "Amount" },
                ],
            },
        },
    },
    {
        operation: "action.create",
        viewId: "orders-list",
        input: {
            id: "export",
            title: "Export orders",
            resource: "api:POST:/api/orders/export",
        },
    },
];

// docs:menu-admin:start
const runtime = await startExampleCore("menu-admin");
const scope = { tenantId: "acme", appId: "admin" };
const scoped = runtime.core.scope(scope);

try {
    const savedConfig = await scoped.menus.management.applyChanges("admin", menuChanges, {
        actorId: "admin",
        idempotencyKey: "example-menu-config-incremental-save",
    });

    await scoped.roles.create({ id: "order-operator", label: "Order operator" });
    const selection = {
        configId: "admin",
        views: ["orders-list"],
        responseFields: [{
            apiResource: "api:GET:/api/orders",
            target: "items",
            fields: ["orderNo", "status"],
        }],
        include: { loads: true, actions: true, responseFields: "none" },
    };
    const grantPreview = await scoped.roles.menuPermissions.preview(
        "order-operator",
        { operation: "grant", selection },
        { actorId: "admin" },
    );
    if (!grantPreview.executable) {
        throw new Error(`menu grant is not executable: ${grantPreview.conflicts.items.map((item) => item.code).join(",")}`);
    }
    const granted = await scoped.roles.menuPermissions.grant("order-operator", selection, {
        ...grantPreview.expected,
        previewToken: grantPreview.previewToken,
        actorId: "admin",
        idempotencyKey: "example-menu-role-grant",
    });
    await scoped.userRoles.assign("u-menu", "order-operator");

    const subjectMenus = runtime.core.forSubject({ userId: "u-menu", scope }).menus;
    const tree = await subjectMenus.getViewTree({ configId: "admin" });
    const viewState = await subjectMenus.getViewState({ configId: "admin", viewId: "orders-list" });
    const actions = await subjectMenus.getActionMap({ configId: "admin", viewId: "orders-list" });
    const rawOrders = {
        items: [{ orderNo: "O-1001", status: "paid", amount: 88, internalCost: 51 }],
        total: 1,
        debug: true,
    };
    const projected = await subjectMenus.filterResponse("api:GET:/api/orders", rawOrders);
    const directGrant = await scoped.roles.menuPermissions.getDirect("order-operator");

    printExample("menu-admin", {
        config: {
            id: savedConfig.data.config.configId,
            menuCount: savedConfig.data.config.menus.length,
            manifestChanged: changed(savedConfig.data.manifestOperations),
        },
        roleGrant: {
            generatedSources: granted.data.generatedSources,
            generatedResponseFields: granted.data.generatedResponseFields,
            grantCount: directGrant.data.grants.length,
            responseFieldCount: directGrant.data.grants[0]?.responseFields.total,
            auditRecorded: Boolean(savedConfig.auditId && granted.auditId),
        },
        subjectRuntime: {
            viewTreeIds: collectIds(tree.data),
            viewAllowed: viewState.data.allowed,
            exportEnabled: actions.data.export.enabled,
            projectedResponse: projected.data,
        },
    });
} finally {
    await runtime.close();
}
// docs:menu-admin:end
