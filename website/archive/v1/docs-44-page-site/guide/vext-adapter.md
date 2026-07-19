# vext Adapter

`permission-core/adapters/vext` connects permission-core to a real Vext plugin and route guard while keeping `vextjs` an optional peer. Authentication must run first and populate `req.auth`; this adapter performs authorization.

## First successful request

```js
// src/plugins/permission.mjs
import { PermissionCore } from "permission-core";
import { createVextPermissionPlugin } from "permission-core/adapters/vext";

export default createVextPermissionPlugin({
  createCore: () => new PermissionCore({ storage }),
  tenantRequired: true,
});
```

Declare the backend resource on the route. The authentication middleware or plugin must be registered before permission-core.

```js
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/api/users", {
    auth: {
      permissions: [{ action: "invoke", resource: "api:GET:/api/users" }],
    },
  }, async (_req, res) => {
    res.json({ users: [] });
  });
});
```

Grant `invoke api:GET:/api/users` to the authenticated user's tenant role. A permitted request returns the handler response; a denied request returns `403 AUTH_FORBIDDEN` before the handler runs.

The repository contains a real `vextjs/testing#createTestApp` flow:

```bash
npm run example:vext
```

Expected status fields are `allowedStatus: 200`, `deniedStatus: 403`, and `deniedCode: "AUTH_FORBIDDEN"`.

## Subject resolution and tenant safety

Subject resolution order:

1. Custom `resolveSubject(req, auth, context)`.
2. Identity from `req.auth.userId` or `req.auth.subject`.
3. Scope from claims and headers: `tenantId`, `appId`, `moduleId`, `namespace`.
4. `defaultScope` only for fields not supplied by the request and only when `tenantRequired` does not prohibit fallback.

Claims, headers, duplicate header casing, and multi-value headers must agree. Conflicts throw `INVALID_ARGUMENT`; the adapter never silently chooses one tenant. With `tenantRequired: true`, a missing explicit tenant fails even if `defaultScope` exists.

## Resource resolution order

Route resource resolution order:

1. Explicit resource passed to `req.auth.can/assert` by Vext or application code.
2. Custom `routeResource(req, action, context)` when configured.
3. Matching route `auth.permissions` metadata.
4. `docs.extensions["x-permission-resource"]` compatibility metadata.
5. Automatic `api:<METHOD>:<matched-route-path>`.

Multiple resources for the same action are an authorization ambiguity and fail closed. Use explicit permission objects and Vext `mode: "any" | "all"` for multi-permission routes.

## Plugin lifecycle

| Option | Behavior |
|---|---|
| omitted `core` / `createCore` | Plugin creates, initializes, and closes its own core |
| external `core` | Initialized unless `init:false`; not closed unless `ownsCore:true` |
| `menu` + `ownsMenu:true` | Menu manager is initialized and closed before the owned core |
| `closeOnAppClose:false` | Disables adapter close hooks; the application must close owned resources |

Do not set `ownsConnection: true` on multiple storage adapters that share one MonSQLize instance.

## Route manifest import

Route manifests can be imported:

```ts
import { loadVextRouteManifest, normalizeVextRoutes } from "permission-core/adapters/vext";

const payload = await loadVextRouteManifest(".vext/manifest/routes.json");
await menu.importApiManifest({ tenantId: "tenant-a" }, normalizeVextRoutes(payload));
```

`normalizeVextRoutes()` preserves `auth.permissions`, `required`, and `mode:any/all` when those fields exist in the payload. The registry `vextjs@0.3.26` route-manifest writer does not currently emit auth metadata, so do not infer protected APIs from that file alone. Use a collector that includes route options, enrich the payload from the route source, or import an explicit API manifest.

## Version and error notes

- The adapter works with `vextjs@0.3.26` at runtime by consuming route options directly. Its published TypeScript `RouteOptions` does not yet declare `auth`; use JavaScript, a local type augmentation, or a Vext release that contains the native auth types.
- `401 AUTH_REQUIRED` means authentication did not produce an authenticated context.
- `403 AUTH_FORBIDDEN` means the subject resolved correctly but the permission group failed.
- `INVALID_ARGUMENT` for tenant/resource conflicts is a configuration or identity-source error; fix the sources instead of retrying another tenant.
- `guardRoutePermissions:false` disables the adapter guard and should only be used when an equivalent Vext-native guard is proven to run.

Exact adapter options and payload types are exported from `permission-core/adapters/vext`; scoped core APIs are documented under [Scoped Permissions](/api/scoped-permissions).
