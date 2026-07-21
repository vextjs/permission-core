import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionCore } from "../../src";
import type { MenuConfigInput, PermissionScope } from "../../src/types";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const PREFIX = `pc_b4_config_${randomUUID().replaceAll("-", "")}`;

interface RawCollection {
    find(query?: unknown): { toArray(): Promise<Record<string, unknown>[]> };
}

function scope(label: string): PermissionScope {
    return { tenantId: `tenant-${label}-${randomUUID()}` };
}

function ordersConfig(configId = "admin", title = "Admin"): MenuConfigInput {
    return {
        configId,
        title,
        menus: [{
            id: "orders",
            title: "Orders",
            icon: "shopping-cart",
            views: [{
                id: "orders-list",
                type: "page",
                title: "Orders",
                path: `/admin/${configId}/orders`,
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
                    title: "Export",
                    resource: "api:POST:/api/orders/export",
                    response: [
                        { field: "downloadUrl", title: "Download URL" },
                    ],
                }],
            }],
        }],
    };
}

describe("menu config manager on MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let core: PermissionCore;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 79 });
        core = new PermissionCore({
            monsqlize: context.monsqlize,
            collectionPrefix: PREFIX,
            tokenSecret: "permission-core-menu-config-manager-secret",
        });
        await core.init();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await core?.close();
        await context?.close();
    }, TEST_TIMEOUT);

    it("previews, saves, reads, and lists a high-level menu config", async () => {
        const targetScope = scope("save");
        const scoped = core.scope(targetScope);
        const config = ordersConfig();

        const preview = await scoped.menus.config.preview(config, { actorId: "admin" });
        if (!preview.executable) throw new Error("expected menu config preview to be executable");
        expect(preview.plan).toMatchObject({
            configId: "admin",
            operation: "save",
            manifestOperations: { total: expect.any(Number) },
            affectedRoles: { total: 0 },
            affectedUsers: { total: 0 },
        });

        const saved = await scoped.menus.config.save(config, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "save-admin-config",
        });
        expect(saved).toMatchObject({
            changed: true,
            data: {
                config: { configId: "admin", revision: 1 },
                retainedGrantCount: 0,
                revokedGrantCount: 0,
            },
        });
        expect(saved.data.manifestOperations.inserted).toBeGreaterThan(0);

        await expect(scoped.menus.config.get("admin")).resolves.toMatchObject({
            data: {
                configId: "admin",
                menus: [expect.objectContaining({
                    id: "orders",
                    views: [expect.objectContaining({
                        id: "orders-list",
                        load: [expect.objectContaining({
                            resource: "api:GET:/api/orders",
                            response: expect.objectContaining({
                                target: "items",
                                preserve: ["total"],
                                fields: [
                                    expect.objectContaining({ field: "orderNo", fieldId: expect.any(String) }),
                                    expect.objectContaining({ field: "status", fieldId: expect.any(String) }),
                                    expect.objectContaining({ field: "amount", fieldId: expect.any(String) }),
                                ],
                            }),
                        })],
                    })],
                })],
            },
        });
        await expect(scoped.menus.config.list({ first: 10 })).resolves.toMatchObject({
            items: [expect.objectContaining({
                configId: "admin",
                menuCount: 1,
                viewCount: 1,
                actionCount: 1,
                responseFieldCount: 4,
                revision: 1,
            })],
        });

        const rawConfigs = await (context.monsqlize.collection(`${PREFIX}_menu_configs`).raw() as RawCollection)
            .find({})
            .toArray();
        expect(rawConfigs).toHaveLength(1);
        expect(rawConfigs[0]).toMatchObject({
            configId: "admin",
            menuCount: 1,
            viewCount: 1,
            actionCount: 1,
            responseFieldCount: 4,
        });
        await expect(scoped.menus.config.save(config, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "save-admin-config",
        })).resolves.toMatchObject({ replayed: true });
    }, TEST_TIMEOUT);

    it("rejects stale preview tokens after the same config changes", async () => {
        const targetScope = scope("stale");
        const scoped = core.scope(targetScope);
        const first = ordersConfig("ops", "Ops");
        const stalePreview = await scoped.menus.config.preview(first, { actorId: "admin" });
        if (!stalePreview.executable) throw new Error("expected stale setup preview to be executable");
        const freshConfig = ordersConfig("ops", "Operations");
        const freshPreview = await scoped.menus.config.preview(freshConfig, { actorId: "admin" });
        if (!freshPreview.executable) throw new Error("expected fresh preview to be executable");
        await scoped.menus.config.save(freshConfig, {
            ...freshPreview.expected,
            previewToken: freshPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "save-fresh-ops",
        });

        await expect(scoped.menus.config.save(first, {
            ...stalePreview.expected,
            previewToken: stalePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "save-stale-ops",
        })).rejects.toMatchObject({ code: expect.stringMatching(/^(PREVIEW_STALE|REVISION_CONFLICT)$/u) });
    }, TEST_TIMEOUT);

    it("removes configs and applies multi-config changes atomically", async () => {
        const targetScope = scope("changes");
        const scoped = core.scope(targetScope);
        const admin = ordersConfig("admin", "Admin");
        const audit = ordersConfig("audit", "Audit");
        const applyPreview = await scoped.menus.config.previewChanges([
            { operation: "save", config: admin },
            { operation: "save", config: audit },
        ], { actorId: "admin" });
        if (!applyPreview.executable) throw new Error("expected apply preview to be executable");
        const applied = await scoped.menus.config.applyChanges([
            { operation: "save", config: audit },
            { operation: "save", config: admin },
        ], {
            ...applyPreview.expected,
            previewToken: applyPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "apply-two-configs",
        });
        expect(applied).toMatchObject({
            changed: true,
            data: { changes: { total: 2 }, manifestOperations: { inserted: expect.any(Number) } },
        });
        await expect(scoped.menus.config.list({ first: 10 })).resolves.toMatchObject({
            items: [
                expect.objectContaining({ configId: "admin" }),
                expect.objectContaining({ configId: "audit" }),
            ],
        });

        const removePreview = await scoped.menus.config.previewRemove("audit", { actorId: "admin" });
        if (!removePreview.executable) throw new Error("expected remove preview to be executable");
        const removed = await scoped.menus.config.remove("audit", {
            ...removePreview.expected,
            previewToken: removePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "remove-audit-config",
        });
        expect(removed).toMatchObject({
            changed: true,
            data: { configId: "audit", revokedGrantCount: 0 },
        });
        await expect(scoped.menus.config.get("audit")).rejects.toMatchObject({ code: "MENU_NOT_FOUND" });
        await expect(scoped.menus.config.list({ first: 10 })).resolves.toMatchObject({
            items: [expect.objectContaining({ configId: "admin" })],
        });
    }, TEST_TIMEOUT);

    it("creates empty configs and builds menus incrementally from user-facing managers", async () => {
        const targetScope = scope("incremental");
        const scoped = core.scope(targetScope);

        await expect(scoped.menus.config.preview({ configId: "empty-bulk", menus: [] }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        const emptyPreview = await scoped.menus.configs.previewCreate({ configId: "admin", title: "Admin" }, { actorId: "admin" });
        if (!emptyPreview.executable) throw new Error("expected empty config preview to be executable");
        await scoped.menus.configs.create({ configId: "admin", title: "Admin" }, {
            ...emptyPreview.expected,
            previewToken: emptyPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "create-empty-admin-config",
        });
        await expect(scoped.menus.config.get("admin")).resolves.toMatchObject({
            data: { configId: "admin", menus: [] },
        });
        await expect(core.forSubject({ userId: "u-empty-menu", scope: targetScope }).menus.getViewTree({ configId: "admin" }))
            .resolves.toMatchObject({ data: [] });

        const changes = [
            { operation: "menu.create", input: { id: "orders", title: "Orders" } },
            { operation: "view.create", menuId: "orders", input: { id: "orders-list", type: "page", title: "Orders", path: "/admin/orders", component: "OrdersPage" } },
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
                        ],
                    },
                },
            },
            { operation: "action.create", viewId: "orders-list", input: { id: "export", title: "Export", resource: "api:POST:/api/orders/export" } },
        ] as const;
        const preview = await scoped.menus.management.previewChanges("admin", changes, { actorId: "admin" });
        if (!preview.executable) throw new Error(`incremental conflicts: ${preview.conflicts.items.map((item) => item.code).join(",")}`);
        await scoped.menus.management.applyChanges("admin", changes, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "incremental-admin-menu",
        });
        await expect(scoped.menus.config.get("admin")).resolves.toMatchObject({
            data: {
                menus: [expect.objectContaining({
                    id: "orders",
                    views: [expect.objectContaining({
                        id: "orders-list",
                        load: [expect.objectContaining({
                            resource: "api:GET:/api/orders",
                            response: expect.objectContaining({ target: "items" }),
                        })],
                    })],
                })],
            },
        });

        await scoped.roles.create({ id: "default-reader", label: "Default reader" });
        const defaultSelection = { configId: "admin", views: ["orders-list"] };
        const defaultPreview = await scoped.roles.menuPermissions.preview("default-reader", {
            operation: "grant",
            selection: defaultSelection,
        }, { actorId: "admin" });
        if (!defaultPreview.executable) throw new Error("expected default grant preview to be executable");
        await scoped.roles.menuPermissions.grant("default-reader", defaultSelection, {
            ...defaultPreview.expected,
            previewToken: defaultPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "grant-default-reader",
        });
        await scoped.userRoles.assign("u-default-reader", "default-reader");
        await expect(scoped.roles.menuPermissions.getDirect("default-reader"))
            .resolves.toMatchObject({ data: { grants: [expect.objectContaining({ responseFields: expect.objectContaining({ total: 0 }) })] } });
        await expect(core.can({ userId: "u-default-reader", scope: targetScope }, "invoke", "api:GET:/api/orders"))
            .resolves.toBe(true);
        await expect(core.forSubject({ userId: "u-default-reader", scope: targetScope }).menus.filterResponse("api:GET:/api/orders", {
            items: [{ orderNo: "O-1", status: "paid", internalCost: 7 }],
            total: 1,
        })).resolves.toMatchObject({ data: { items: [{}], total: 1 } });

        await scoped.roles.create({ id: "field-reader", label: "Field reader" });
        const fieldSelection = {
            configId: "admin",
            views: ["orders-list"],
            responseFields: [{ apiResource: "api:GET:/api/orders", target: "items", fields: ["orderNo"] }],
        } as const;
        const fieldPreview = await scoped.roles.menuPermissions.preview("field-reader", {
            operation: "grant",
            selection: fieldSelection,
        }, { actorId: "admin" });
        if (!fieldPreview.executable) throw new Error("expected field grant preview to be executable");
        await scoped.roles.menuPermissions.grant("field-reader", fieldSelection, {
            ...fieldPreview.expected,
            previewToken: fieldPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "grant-field-reader",
        });
        await scoped.userRoles.assign("u-field-reader", "field-reader");
        await expect(core.forSubject({ userId: "u-field-reader", scope: targetScope }).menus.filterResponse("api:GET:/api/orders", {
            items: [{ orderNo: "O-1", status: "paid", internalCost: 7 }],
            total: 1,
        })).resolves.toMatchObject({ data: { items: [{ orderNo: "O-1" }], total: 1 } });
    }, TEST_TIMEOUT);

    it("grants role menu permissions from business config selections and exposes response fields", async () => {
        const targetScope = scope("business-grant");
        const scoped = core.scope(targetScope);
        const config = ordersConfig("admin", "Admin");
        const savePreview = await scoped.menus.config.preview(config, { actorId: "admin" });
        if (!savePreview.executable) throw new Error("expected business grant config preview to be executable");
        await scoped.menus.config.save(config, {
            ...savePreview.expected,
            previewToken: savePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "save-business-grant-config",
        });
        await scoped.roles.create({ id: "view-only", label: "View only" });
        await scoped.roles.create({ id: "order-reader", label: "Order reader" });

        const viewOnlySelection = {
            configId: "admin",
            views: ["orders-list"],
            include: { loads: false, actions: false, responseFields: "all" as const },
        };
        const viewOnlyPreview = await scoped.roles.menuPermissions.preview("view-only", {
            operation: "grant",
            selection: viewOnlySelection,
        }, { actorId: "admin" });
        if (!viewOnlyPreview.executable) throw new Error(`view-only conflicts: ${viewOnlyPreview.conflicts.items.map((item) => item.code).join(",")}`);
        await scoped.roles.menuPermissions.grant("view-only", viewOnlySelection, {
            ...viewOnlyPreview.expected,
            previewToken: viewOnlyPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "grant-view-only",
        });
        await scoped.userRoles.assign("u-view-only", "view-only");
        await expect(core.can({ userId: "u-view-only", scope: targetScope }, "invoke", "api:GET:/api/orders"))
            .resolves.toBe(false);
        await expect(scoped.roles.menuPermissions.getDirect("view-only"))
            .resolves.toMatchObject({
                data: {
                    grants: [expect.objectContaining({
                        responseFields: expect.objectContaining({ total: 0 }),
                    })],
                },
            });

        const selection = {
            configId: "admin",
            views: ["orders-list"],
            include: { loads: true, actions: false, responseFields: "all" as const },
        };
        const grantPreview = await scoped.roles.menuPermissions.preview("order-reader", {
            operation: "grant",
            selection,
        }, { actorId: "admin" });
        if (!grantPreview.executable) throw new Error(`business grant conflicts: ${grantPreview.conflicts.items.map((item) => item.code).join(",")}`);
        expect(grantPreview.plan).toMatchObject({
            roleId: "order-reader",
            operation: "grant",
            grants: {
                total: 1,
                items: [expect.objectContaining({
                    effect: "allow",
                    configId: "admin",
                    selectedResponseFields: expect.objectContaining({ total: 3 }),
                })],
            },
        });

        const granted = await scoped.roles.menuPermissions.grant("order-reader", selection, {
            ...grantPreview.expected,
            previewToken: grantPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "grant-business-menu",
        });
        expect(granted).toMatchObject({
            changed: true,
            data: {
                roleId: "order-reader",
                generatedResponseFields: 3,
                grantIds: { total: 1 },
            },
        });
        await scoped.userRoles.assign("u-menu-business", "order-reader");
        await expect(core.can({ userId: "u-menu-business", scope: targetScope }, "invoke", "api:GET:/api/orders"))
            .resolves.toBe(true);
        await expect(core.can({ userId: "u-menu-business", scope: targetScope }, "invoke", "api:POST:/api/orders/export"))
            .resolves.toBe(false);

        const direct = await scoped.roles.menuPermissions.getDirect("order-reader");
        expect(direct.data.grants).toHaveLength(1);
        expect(direct.data.grants[0]).toMatchObject({
            configId: "admin",
            responseFields: {
                total: 3,
                items: [
                    expect.objectContaining({ field: "amount" }),
                    expect.objectContaining({ field: "orderNo" }),
                    expect.objectContaining({ field: "status" }),
                ],
            },
        });
        await expect(scoped.roles.menuPermissions.listDirect("order-reader", { configId: "admin", first: 10 }))
            .resolves.toMatchObject({
                items: [expect.objectContaining({
                    configId: "admin",
                    responseFields: expect.objectContaining({ total: 3 }),
                })],
            });
        await expect(scoped.roles.menuPermissions.getEffective("order-reader"))
            .resolves.toMatchObject({
                data: {
                    roleId: "order-reader",
                    grants: {
                        total: 1,
                        items: [expect.objectContaining({ configId: "admin" })],
                    },
                },
            });

        const tree = await scoped.roles.menuPermissions.getAuthorizationTree("order-reader", { configId: "admin" });
        const flatten = (nodes: typeof tree.data.nodes): readonly { id: string; kind: string; state: string; title: string }[] =>
            nodes.flatMap((node) => [{ id: node.id, kind: node.kind, state: node.state, title: node.title }, ...flatten(node.children)]);
        expect(flatten(tree.data.nodes)).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "api:GET:/api/orders", kind: "load", state: "direct-allow" }),
            expect.objectContaining({ kind: "response-field", title: "Order number", state: "direct-allow" }),
            expect.objectContaining({ kind: "action", title: "Export", state: "none" }),
        ]));

        const viewOnlySubject = core.forSubject({ userId: "u-view-only", scope: targetScope });
        await expect(viewOnlySubject.menus.getViewState({ configId: "admin", viewId: "orders-list" }))
            .resolves.toMatchObject({
                data: {
                    allowed: false,
                    reason: "load-unavailable",
                    navigationReachable: false,
                },
            });
        await expect(viewOnlySubject.menus.getViewTree({ configId: "admin" }))
            .resolves.toMatchObject({
                data: [expect.objectContaining({
                    id: "orders",
                    enabled: true,
                    children: [expect.objectContaining({
                        id: "orders-list",
                        enabled: false,
                        reason: "load-unavailable",
                    })],
                })],
            });
        await expect(viewOnlySubject.menus.filterResponse("api:GET:/api/orders", {
            items: [{ orderNo: "O-1", status: "paid", amount: 12, internalCost: 7 }],
            total: 1,
            debug: true,
        })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

        await scoped.roles.allow("order-reader", { action: "invoke", resource: "api:GET:/api/unknown" });
        const subject = core.forSubject({ userId: "u-menu-business", scope: targetScope });
        await expect(subject.menus.getViewState({ path: "/admin/admin/orders" }))
            .resolves.toMatchObject({
                data: {
                    allowed: true,
                    configId: "admin",
                    viewId: "orders-list",
                    reason: "allowed",
                    navigationReachable: true,
                    navigationReason: "reachable",
                },
            });
        await expect(subject.menus.getViewTree({ configId: "admin" }))
            .resolves.toMatchObject({
                data: [expect.objectContaining({
                    id: "orders",
                    enabled: true,
                    reason: "allowed",
                    children: [expect.objectContaining({
                        id: "orders-list",
                        enabled: true,
                        reason: "allowed",
                    })],
                })],
            });
        await expect(subject.menus.getActionMap({ configId: "admin", viewId: "orders-list" }))
            .resolves.toMatchObject({
                data: {
                    export: {
                        visible: false,
                        enabled: false,
                        reason: "permission-denied",
                        resource: "api:POST:/api/orders/export",
                    },
                },
            });
        await expect(subject.menus.filterResponse("api:GET:/api/orders", {
            items: [{ orderNo: "O-1", status: "paid", amount: 12, internalCost: 7 }],
            total: 1,
            debug: true,
        })).resolves.toMatchObject({
            data: {
                items: [{ orderNo: "O-1", status: "paid", amount: 12 }],
                total: 1,
            },
        });
        await expect(subject.menus.filterResponse("api:GET:/api/unknown", {
            raw: true,
        })).resolves.toMatchObject({
            data: { raw: true },
        });
    }, TEST_TIMEOUT);
});
