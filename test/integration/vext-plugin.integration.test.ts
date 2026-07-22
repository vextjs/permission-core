import { resolve } from "node:path";
import { createTestApp } from "vextjs/testing";
import type {
    TestApp,
    VextHookPayloadMap,
    VextRequest,
} from "vextjs";
import { describe, expect, it } from "vitest";
import { permissionPlugin } from "../../src/plugins/vext";
import type { MenuBusinessPermissionSelection, MenuConfigInput } from "../../src/types";
import { startRealMongo } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const METRICS = Symbol.for("permission-core.vext.integration.metrics");
const MISSING_AUTH_PLUGIN = Symbol.for("permission-core.vext.missing-auth-fixture.plugin");
const SCOPE = Object.freeze({ tenantId: "vext-host" });

interface FixtureMetrics {
    middleware: number;
    handler: number;
}

interface RawCollection {
    insertMany(documents: readonly Record<string, unknown>[]): Promise<unknown>;
}

interface InternalTestHooks {
    emit<K extends "routes:ready" | "server:beforeListen">(
        name: K,
        payload: VextHookPayloadMap[K],
    ): Promise<unknown>;
}

function resetMetrics() {
    (globalThis as Record<symbol, unknown>)[METRICS] = {
        middleware: 0,
        handler: 0,
    } satisfies FixtureMetrics;
}

function metrics() {
    return (globalThis as Record<symbol, unknown>)[METRICS] as FixtureMetrics;
}

function vextOrdersConfig(): MenuConfigInput {
    return {
        configId: "vext-admin",
        title: "Vext Admin",
        menus: [{
            id: "orders",
            title: "Orders",
            views: [
                {
                    id: "orders-with-fields",
                    type: "page",
                    title: "Orders",
                    path: "/vext/orders",
                    component: "OrdersPage",
                    load: [{
                        resource: "api:GET:/orders-with-fields",
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
                },
                {
                    id: "orders-data",
                    type: "page",
                    title: "Order data",
                    path: "/vext/orders-data",
                    component: "OrdersDataPage",
                    load: [{
                        resource: "api:GET:/orders-data",
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
                },
            ],
        }],
    };
}

function installTestAuth(req: VextRequest) {
    const mode = req.headers["x-test-auth"];
    if (mode === undefined) return;
    const auth = mode === "valid"
        ? { isAuthenticated: true, userId: req.headers["x-user-id"] ?? "u-vext", scope: SCOPE }
        : mode === "invalid"
            ? { isAuthenticated: true, userId: "u-vext" }
            : { isAuthenticated: false };
    Object.defineProperty(req, "auth", {
        value: auth,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

describe("permissionPlugin with a real Vext host", () => {
    it("enforces the complete route lifecycle and preserves host database ownership", async () => {
        const mongo = await startRealMongo();
        let testApp: TestApp | undefined;
        let appClosed = false;

        try {
            testApp = await createTestApp({
                rootDir: resolve("test/fixtures/vext-plugin-app"),
                plugins: false,
                services: false,
                middlewares: true,
                routes: true,
                config: { middlewares: ["marker"] },
                setupPlugins: async (app) => {
                    app.use(async (req, _res, next) => {
                        installTestAuth(req);
                        await next();
                    });
                    await permissionPlugin({
                        monsqlize: mongo.monsqlize,
                        core: { collectionPrefix: "pc_vext_host" },
                        data: {
                            exposeAs: "monsqlize",
                            scopeFields: { tenantId: "tenantId" },
                            collections: {
                                vext_orders: { resource: "db:orders" },
                            },
                        },
                    }).setup(app);
                },
            });

            await (testApp.app.hooks as unknown as InternalTestHooks).emit("server:beforeListen", {
                host: "127.0.0.1",
                port: 0,
                adapter: testApp.app.adapter,
            });

            const scoped = testApp.app.permission.scope(SCOPE);
            await scoped.roles.create({ id: "route-reader", label: "Route reader" });
            await scoped.roles.allow("route-reader", { action: "invoke", resource: "api:GET:/orders/:id" });
            await scoped.roles.allow("route-reader", { action: "invoke", resource: "api:GET:/capabilities/one" });
            await scoped.roles.allow("route-reader", { action: "read", resource: "db:orders" });
            await (mongo.monsqlize.collection("vext_orders").raw() as RawCollection).insertMany([
                { tenantId: SCOPE.tenantId, orderNo: "O-1", status: "paid", amount: 12, internalCost: 7 },
                { tenantId: "other-tenant", orderNo: "O-2", status: "paid", amount: 99, internalCost: 1 },
            ]);
            const responseConfigPreview = await scoped.menus.config.preview(vextOrdersConfig(), { actorId: "admin" });
            if (!responseConfigPreview.executable) throw new Error("expected Vext response config preview to be executable");
            await scoped.menus.config.save(vextOrdersConfig(), {
                ...responseConfigPreview.expected,
                previewToken: responseConfigPreview.previewToken,
                actorId: "admin",
                idempotencyKey: "save-vext-response-config",
            });
            const responseGrantSelection: MenuBusinessPermissionSelection = {
                configId: "vext-admin",
                views: ["orders-with-fields", "orders-data"],
                responseFields: [{
                    apiResource: "api:GET:/orders-with-fields",
                    fields: ["orderNo", "status"],
                }, {
                    apiResource: "api:GET:/orders-data",
                    fields: ["orderNo", "status"],
                }],
                include: { loads: true, actions: false, responseFields: "none" as const },
            };
            const responseGrantPreview = await scoped.roles.menuPermissions.preview("route-reader", {
                operation: "grant",
                selection: responseGrantSelection,
            }, { actorId: "admin" });
            if (!responseGrantPreview.executable) throw new Error("expected Vext response grant preview to be executable");
            await scoped.roles.menuPermissions.grant("route-reader", responseGrantSelection, {
                ...responseGrantPreview.expected,
                previewToken: responseGrantPreview.previewToken,
                actorId: "admin",
                idempotencyKey: "grant-vext-response-fields",
            });
            await scoped.userRoles.assign("u-vext", "route-reader");
            await scoped.roles.create({ id: "duplicate-role", label: "Duplicate role" });

            resetMetrics();
            const publicResponse = await testApp.request.get("/public");
            expect(publicResponse.status).toBe(200);
            expect(publicResponse.body).toMatchObject({ data: { public: true } });

            const missingAuth = await testApp.request.get("/guard/not-a-uuid");
            expect(missingAuth.status).toBe(401);
            expect(missingAuth.body).toMatchObject({ code: "VEXT_AUTH_REQUIRED" });
            expect(metrics()).toEqual({ middleware: 0, handler: 0 });

            const invalidSubject = await testApp.request.get("/orders/42").set("x-test-auth", "invalid");
            expect(invalidSubject.status).toBe(401);
            expect(invalidSubject.body).toMatchObject({ code: "INVALID_SUBJECT" });

            const denied = await testApp.request.get("/guard/not-a-uuid").set("x-test-auth", "valid");
            expect(denied.status).toBe(403);
            expect(denied.body).toMatchObject({ code: "PERMISSION_DENIED" });
            expect(metrics()).toEqual({ middleware: 0, handler: 0 });

            const allowed = await testApp.request.get("/orders/42").set("x-test-auth", "valid");
            expect(allowed.status).toBe(200);
            expect(allowed.body).toMatchObject({
                data: {
                    orderId: "42",
                    subject: { userId: "u-vext", scope: SCOPE },
                },
            });
            const projected = await testApp.request.get("/orders-with-fields").set("x-test-auth", "valid");
            expect(projected.status).toBe(200);
            expect(projected.headers["cache-control"]).toBe("private, no-store");
            expect(projected.body).toMatchObject({
                data: {
                    items: [{ orderNo: "O-1", status: "paid" }],
                    total: 1,
                },
            });
            expect(projected.body.data.items[0]).not.toHaveProperty("amount");
            expect(projected.body.data.items[0]).not.toHaveProperty("internalCost");
            expect(projected.body.data).not.toHaveProperty("debug");
            const dataAuthorized = await testApp.request.get("/orders-data").set("x-test-auth", "valid");
            expect(dataAuthorized.status).toBe(200);
            expect(dataAuthorized.headers["cache-control"]).toBe("private, no-store");
            expect(dataAuthorized.body).toMatchObject({
                data: {
                    items: [{ orderNo: "O-1", status: "paid" }],
                    total: 1,
                },
            });
            expect(dataAuthorized.body.data.items).toHaveLength(1);
            expect(dataAuthorized.body.data.items[0]).not.toHaveProperty("amount");
            expect(dataAuthorized.body.data.items[0]).not.toHaveProperty("internalCost");
            expect(dataAuthorized.body.data).not.toHaveProperty("debug");

            const anyAllowed = await testApp.request.get("/permissions/any").set("x-test-auth", "valid");
            expect(anyAllowed.status).toBe(200);
            const allDenied = await testApp.request.get("/permissions/all").set("x-test-auth", "valid");
            expect(allDenied.status).toBe(403);
            await scoped.roles.allow("route-reader", { action: "invoke", resource: "api:GET:/capabilities/two" });
            const allAllowed = await testApp.request.get("/permissions/all").set("x-test-auth", "valid");
            expect(allAllowed.status).toBe(200);

            const conflict = await testApp.request.get("/errors/conflict");
            expect(conflict.status).toBe(409);
            expect(conflict.body).toMatchObject({ code: "ROLE_ALREADY_EXISTS" });

            const unexpected = await testApp.request.get("/errors/unexpected");
            expect(unexpected.status).toBe(500);
            expect(unexpected.text).not.toContain("private-vext-handler-detail");

            await (testApp.app.hooks as unknown as InternalTestHooks).emit("routes:ready", {
                count: 0,
                routes: [],
            });
            const reloadBlocked = await testApp.request.get("/public");
            expect(reloadBlocked.status).toBe(503);
            expect(reloadBlocked.body).toMatchObject({ code: "VEXT_ROUTE_RESTART_REQUIRED" });

            await testApp.close();
            appClosed = true;
            await expect(mongo.monsqlize.health()).resolves.toMatchObject({ status: "up", connected: true });
        } finally {
            if (testApp && !appClosed) {
                await testApp.close().catch(() => undefined);
            }
            await mongo.close();
            delete (globalThis as Record<symbol, unknown>)[METRICS];
        }
    }, TEST_TIMEOUT);

    it("rejects a missing authentication dependency through the real plugin loader", async () => {
        (globalThis as Record<symbol, unknown>)[MISSING_AUTH_PLUGIN] = permissionPlugin({
            monsqlize: {} as never,
        });
        try {
            await expect(createTestApp({
                rootDir: resolve("test/fixtures/vext-plugin-missing-auth"),
                plugins: true,
                services: false,
                routes: false,
                middlewares: false,
            })).rejects.toThrow(/authentication/u);
        } finally {
            delete (globalThis as Record<symbol, unknown>)[MISSING_AUTH_PLUGIN];
        }
    });
});
