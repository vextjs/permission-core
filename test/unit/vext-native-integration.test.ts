import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { createTestApp } from "vextjs/testing";

import { PermissionCore } from "../../src";
import { createVextPermissionPlugin } from "../../src/adapters/vext";

describe("vext native integration", () => {
    it("loads the plugin in a real Vext app and enforces tenant-scoped checks", async () => {
        const core = new PermissionCore();
        await core.init();
        const scoped = core.scope({ tenantId: "tenant-a" });
        await scoped.roles.create("api-reader", { label: "API Reader" });
        await scoped.roles.allow("api-reader", "invoke", "api:GET:/allowed");
        await scoped.users.assign("user-1", "api-reader");
        const plugin = createVextPermissionPlugin({ core, init: false, tenantRequired: true });

        const testApp = await createTestApp({
            rootDir: path.resolve("test/fixtures/vext-permission-app"),
            services: false,
            middlewares: false,
            setupPlugins: async (app) => {
                app.use(async (req, _res, next) => {
                    (req as unknown as { auth: unknown }).auth = {
                        isAuthenticated: true,
                        userId: "user-1",
                        roles: [],
                        scopes: [],
                        claims: {},
                    };
                    await next();
                });
                await plugin.setup(app);
            },
        });

        const allowed = await testApp.request.get("/allowed").set("x-tenant-id", "tenant-a");
        const denied = await testApp.request.get("/denied").set("x-tenant-id", "tenant-a");
        const anyMode = await testApp.request.get("/any").set("x-tenant-id", "tenant-a");
        const allMode = await testApp.request.get("/all").set("x-tenant-id", "tenant-a");
        const publicRoute = await testApp.request.get("/public");
        expect(allowed).toMatchObject({ status: 200, body: { data: { guarded: true } } });
        expect(denied).toMatchObject({ status: 403, body: { code: "AUTH_FORBIDDEN", message: "Forbidden" } });
        expect(anyMode).toMatchObject({ status: 200, body: { data: { mode: "any" } } });
        expect(allMode).toMatchObject({ status: 403, body: { code: "AUTH_FORBIDDEN" } });
        expect(publicRoute).toMatchObject({ status: 200, body: { data: { public: true } } });

        await testApp.close();
        await expect(core.canSubject({ tenantId: "tenant-a", userId: "user-1" }, "invoke", "api:GET:/allowed"))
            .resolves.toBe(true);
        await core.close();
    });
});
