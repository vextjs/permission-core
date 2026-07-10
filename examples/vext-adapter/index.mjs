import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { PermissionCore } from "permission-core";
import { createTestApp } from "vextjs/testing";
import {
  createVextPermissionPlugin,
  normalizeVextRoutes,
} from "permission-core/adapters/vext";

const pc = new PermissionCore();
await pc.init();

const tenant = pc.scope({ tenantId: "tenant-a" });
await tenant.roles.create("api-reader", { label: "API Reader" });
await tenant.roles.allow("api-reader", "invoke", "api:GET:/api/users");
await tenant.users.assign("user-1", "api-reader");

const plugin = createVextPermissionPlugin({ core: pc, init: false, tenantRequired: true });
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");
const testApp = await createTestApp({
  rootDir,
  services: false,
  middlewares: false,
  setupPlugins: async (app) => {
    app.use(async (req, _res, next) => {
      req.auth = {
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

const allowed = await testApp.request.get("/api/users").set("x-tenant-id", "tenant-a");
const denied = await testApp.request.delete("/api/users/user-1").set("x-tenant-id", "tenant-a");

const manifest = normalizeVextRoutes({
  routes: [
    {
      method: "GET",
      path: "/api/users",
      operationId: "listUsers",
      docsSummary: "List users",
      tags: ["users"],
      hidden: false,
      auth: {
        permissions: [{ action: "invoke", resource: "api:GET:/api/users" }],
      },
    },
  ],
});

console.log(JSON.stringify({
  allowedStatus: allowed.status,
  deniedStatus: denied.status,
  deniedCode: denied.body.code,
  apiBinding: manifest.bindings[0],
}, null, 2));

await testApp.close();
await pc.close();
