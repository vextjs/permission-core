import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionCore } from "../../src";
import type { MenuConfigInput, PermissionScope } from "../../src/types";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const PREFIX = `pc_b44_scoped_${randomUUID().replaceAll("-", "")}`;

function scope(label: string): PermissionScope {
    return { tenantId: `tenant-${label}-${randomUUID()}` };
}

function ordersConfig(configId = "admin"): MenuConfigInput {
    return {
        configId,
        title: "Admin console",
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
                    response: [{ field: "downloadUrl", title: "Download URL" }],
                }],
            }],
        }],
    };
}

describe("public scoped menu config managers on MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let core: PermissionCore;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 97 });
        core = new PermissionCore({
            monsqlize: context.monsqlize,
            collectionPrefix: PREFIX,
            tokenSecret: "permission-core-scoped-menu-manager-secret",
        });
        await core.init();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await core?.close();
        await context?.close();
    }, TEST_TIMEOUT);

    it("exposes the public scope facade through high-level menu managers", async () => {
        const scoped = core.scope(scope("surface"));
        expect(Object.isFrozen(scoped)).toBe(true);
        expect(Object.isFrozen(scoped.menus)).toBe(true);
        expect(Object.isFrozen(scoped.menus.config)).toBe(true);
        expect(Object.isFrozen(scoped.menus.management)).toBe(true);
        expect(Object.isFrozen(scoped.menus.configs)).toBe(true);
        expect(Object.keys(scoped)).toEqual(["roles", "userRoles", "menus"]);
        expect(Object.keys(scoped.menus)).toEqual(["config", "management", "configs", "items", "views", "loadApis", "actions", "responses"]);
        expect((scoped as { apiBindings?: unknown }).apiBindings).toBeUndefined();

        const config = ordersConfig();
        const preview = await scoped.menus.config.preview(config, { actorId: "admin" });
        if (!preview.executable) throw new Error("expected config preview to be executable");
        await expect(scoped.menus.config.save(config, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "public-config-save",
        })).resolves.toMatchObject({ changed: true, data: { config: { configId: "admin", revision: 1 } } });
        await expect(scoped.menus.config.get("admin")).resolves.toMatchObject({
            data: { configId: "admin", menus: [expect.objectContaining({ id: "orders" })] },
        });
        await expect(scoped.menus.config.list({ first: 10 })).resolves.toMatchObject({
            items: [expect.objectContaining({ configId: "admin", viewCount: 1, actionCount: 1 })],
        });
    }, TEST_TIMEOUT);

    it("connects menu config selections to role authorization and subject runtime", async () => {
        const targetScope = scope("business");
        const scoped = core.scope(targetScope);
        const config = ordersConfig();
        const savePreview = await scoped.menus.config.preview(config, { actorId: "admin" });
        if (!savePreview.executable) throw new Error("expected config preview to be executable");
        await scoped.menus.config.save(config, {
            ...savePreview.expected,
            previewToken: savePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "business-config-save",
        });

        await scoped.roles.create({ id: "order-operator", label: "Order operator" });
        const selection = {
            configId: "admin",
            views: ["orders-list"],
            include: { loads: true, actions: true, responseFields: "all" as const },
        };
        const grantPreview = await scoped.roles.menuPermissions.preview("order-operator", {
            operation: "grant",
            selection,
        }, { actorId: "admin" });
        if (!grantPreview.executable) throw new Error("expected role menu grant preview to be executable");
        await scoped.roles.menuPermissions.grant("order-operator", selection, {
            ...grantPreview.expected,
            previewToken: grantPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "business-role-grant",
        });
        await scoped.userRoles.assign("u-operator", "order-operator");

        await expect(core.can({ userId: "u-operator", scope: targetScope }, "invoke", "api:GET:/api/orders"))
            .resolves.toBe(true);
        await expect(core.can({ userId: "u-operator", scope: targetScope }, "invoke", "api:POST:/api/orders/export"))
            .resolves.toBe(true);
        const subject = core.forSubject({ userId: "u-operator", scope: targetScope });
        await expect(subject.menus.getViewState({ configId: "admin", viewId: "orders-list" }))
            .resolves.toMatchObject({ data: { allowed: true, reason: "allowed" } });
        await expect(subject.menus.getActionMap({ configId: "admin", viewId: "orders-list" }))
            .resolves.toMatchObject({ data: { export: { enabled: true, reason: "allowed" } } });
        await expect(subject.menus.filterResponse("api:GET:/api/orders", {
            items: [{ orderNo: "O-1", status: "paid", amount: 12, internalCost: 7 }],
            total: 1,
            debug: true,
        })).resolves.toMatchObject({
            data: { items: [{ orderNo: "O-1", status: "paid", amount: 12 }], total: 1 },
        });
    }, TEST_TIMEOUT);
});
