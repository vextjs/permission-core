import { resolve } from "node:path";
import { createTestApp } from "vextjs/testing";
import { permissionPlugin } from "permission-core/plugins/vext";
import { printExample, startExampleDatabase } from "../_support/host.mjs";

// docs:vext:start
const database = await startExampleDatabase("vext");
const scope = Object.freeze({ tenantId: "vext-host" });
let testApp;
let appClosed = false;

try {
    // createTestApp and the header auth below are test fixtures. A production Vext
    // app loads permissionPlugin from src/plugins and supplies its real auth plugin.
    testApp = await createTestApp({
        rootDir: resolve("examples/vext/app"),
        plugins: false,
        services: false,
        middlewares: false,
        routes: true,
        setupPlugins: async (app) => {
            app.use(async (req, _res, next) => {
                const userId = req.headers["x-example-user"];
                if (userId) {
                    Object.defineProperty(req, "auth", {
                        value: { isAuthenticated: true, userId, scope },
                        enumerable: true,
                        configurable: true,
                    });
                }
                await next();
            });
            await permissionPlugin({
                monsqlize: database.monsqlize,
                core: { collectionPrefix: "pc_vext_example" },
            }).setup(app);
        },
    });
    await testApp.app.hooks.emit("server:beforeListen", {
        host: "127.0.0.1",
        port: 0,
        adapter: testApp.app.adapter,
    });

    const scoped = testApp.app.permission.scope(scope);
    await scoped.roles.create({ id: "route-reader", label: "Route reader" });
    await scoped.roles.allow("route-reader", { action: "invoke", resource: "GET:/orders/:id" });
    await scoped.userRoles.assign("u-vext", "route-reader");

    const publicResponse = await testApp.request.get("/public");
    const missingAuth = await testApp.request.get("/orders/42");
    const denied = await testApp.request.get("/orders/42").set("x-example-user", "u-denied");
    const allowed = await testApp.request.get("/orders/42").set("x-example-user", "u-vext");

    await testApp.app.hooks.emit("routes:ready", { count: 0, routes: [] });
    const restartRequired = await testApp.request.get("/public");
    await testApp.close();
    appClosed = true;
    const hostDatabase = await database.monsqlize.health();

    printExample("vext", {
        responses: {
            public: publicResponse.status,
            missingAuthentication: missingAuth.status,
            permissionDenied: denied.status,
            permissionAllowed: allowed.status,
            routeReloadRequiresRestart: restartRequired.status,
        },
        allowedBody: allowed.body.data,
        lifecycle: {
            permissionCoreClosedByPlugin: true,
            hostDatabaseStillConnected: hostDatabase.status === "up" && hostDatabase.connected,
        },
    });
} finally {
    if (testApp && !appClosed) await testApp.close().catch(() => undefined);
    await database.close();
}
// docs:vext:end
