import { printExample, startExampleCore } from "./_support/host.mjs";

function collectIds(nodes) {
    return nodes.flatMap((node) => [node.id, ...collectIds(node.children)]);
}

const menuConfig = {
    configId: "admin",
    title: "Admin console",
    menus: [{
        id: "orders",
        title: "Orders",
        icon: "shopping-cart",
        views: [{
            id: "orders-list",
            type: "page",
            title: "Orders",
            path: "/orders",
            component: "OrdersPage",
            load: [{
                resource: "api:GET:/api/orders",
                response: {
                    target: "items",
                    preserve: ["total"],
                    fields: [
                        { field: "orderNo", title: "Order number" },
                        { field: "status", title: "Status" },
                        { field: "amount", title: "Amount" },
                    ],
                },
            }],
            actions: [{
                id: "export",
                title: "Export orders",
                resource: "api:POST:/api/orders/export",
                response: [{ field: "downloadUrl", title: "Download URL" }],
            }],
        }],
    }],
};

// docs:menu-admin:start
const runtime = await startExampleCore("menu-admin");
const scope = { tenantId: "acme", appId: "admin" };
const scoped = runtime.core.scope(scope);

try {
    const configPreview = await scoped.menus.config.preview(menuConfig, { actorId: "admin" });
    if (!configPreview.executable) {
        throw new Error(`menu config is not executable: ${configPreview.conflicts.items.map((item) => item.code).join(",")}`);
    }
    const savedConfig = await scoped.menus.config.save(menuConfig, {
        ...configPreview.expected,
        previewToken: configPreview.previewToken,
        actorId: "admin",
        idempotencyKey: "example-menu-config-save",
    });

    await scoped.roles.create({ id: "order-operator", label: "Order operator" });
    const selection = {
        configId: "admin",
        views: ["orders-list"],
        responseFields: [{
            apiResource: "api:GET:/api/orders",
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
            manifestChanged: savedConfig.data.manifestOperations.total > 0,
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
