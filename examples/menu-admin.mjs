import { printExample, startExampleCore } from "./_support/host.mjs";

function collectIds(nodes) {
    return nodes.flatMap((node) => [node.id, ...collectIds(node.children)]);
}

// docs:menu-admin:start
const runtime = await startExampleCore("menu-admin");
const scope = { tenantId: "acme", appId: "admin" };
const scoped = runtime.core.scope(scope);

try {
    const root = await scoped.menus.create({
        id: "operations",
        type: "directory",
        title: "Operations",
    }, { actorId: "admin" });
    const page = await scoped.menus.create({
        id: "orders",
        parentId: "operations",
        type: "page",
        title: "Orders",
        path: "/orders",
        name: "orders",
        component: "OrdersPage",
        permission: { action: "read", resource: "ui:page:orders" },
        dataPermissions: [{ action: "read", resource: "db:orders", label: "Read orders" }],
    }, { actorId: "admin" });
    const button = await scoped.menus.create({
        id: "orders-export",
        parentId: "orders",
        type: "button",
        title: "Export orders",
        code: "orders.export",
        permission: { action: "invoke", resource: "ui:button:orders.export" },
    }, { actorId: "admin" });
    const binding = await scoped.apiBindings.create({
        id: "orders-export-api",
        method: "POST",
        path: "/api/orders/export",
        purpose: "importExport",
        authorization: {
            mode: "all",
            permissions: [{ action: "invoke", resource: "api:POST:/api/orders/export" }],
        },
        owners: [{ type: "button", id: "orders-export", required: true }],
        canonicalOwner: { type: "button", id: "orders-export" },
    }, { actorId: "admin" });

    await scoped.roles.create({ id: "order-operator", label: "Order operator" });
    await scoped.userRoles.assign("u-menu", "order-operator");
    const selection = {
        nodeIds: ["orders"],
        include: { descendants: true, buttons: true, apis: "required", dataPermissions: true },
        apiChoices: { bindingIds: [], permissionsByBinding: {} },
    };
    const preview = await scoped.roles.menuPermissions.preview(
        "order-operator",
        { operation: "grant", selection },
        { actorId: "admin" },
    );
    if (!preview.executable) {
        throw new Error(`menu grant is not executable: ${preview.conflicts.items.map((item) => item.code).join(",")}`);
    }
    const granted = await scoped.roles.menuPermissions.grant("order-operator", selection, {
        ...preview.expected,
        previewToken: preview.previewToken,
        actorId: "admin",
    });

    const updated = await scoped.menus.update("orders", { title: "Order management" }, {
        expectedRevision: page.data.revision,
        actorId: "admin",
    });
    const subjectMenus = runtime.core.forSubject({ userId: "u-menu", scope }).menus;
    const visible = await subjectMenus.getVisibleTree();
    const buttons = await subjectMenus.getButtonMap("orders");
    const route = await subjectMenus.getRouteState("/orders");
    const manifest = await scoped.menus.manifest.export();
    const directGrant = await scoped.roles.menuPermissions.getDirect("order-operator");

    printExample("menu-admin", {
        created: {
            nodes: [root.data.id, page.data.id, button.data.id],
            apiBinding: binding.data.id,
        },
        update: { title: updated.data.title, revision: updated.data.revision },
        roleGrant: {
            generatedSources: granted.data.generatedSources,
            grantCount: directGrant.data.grants.length,
            sourceStatus: directGrant.data.grants[0]?.sourceStatus,
            auditRecorded: [root, page, button, binding, granted, updated]
                .every((result) => typeof result.auditId === "string" && result.auditId.length > 0),
        },
        subjectRuntime: {
            visibleNodeIds: collectIds(visible.data),
            exportButton: buttons.data["orders.export"],
            route: {
                allowed: route.data.allowed,
                reason: route.data.reason,
                navigationReachable: route.data.navigationReachable,
            },
        },
        manifest: {
            schemaVersion: manifest.data.schemaVersion,
            nodeCount: manifest.data.nodes.length,
            apiBindingCount: manifest.data.apiBindings.length,
        },
    });
} finally {
    await runtime.close();
}
// docs:menu-admin:end
