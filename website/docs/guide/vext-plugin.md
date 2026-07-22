# Vext Plugin

If your app already uses Vext, an authentication plugin, and MonSQLize, use `permission-core/plugins/vext` to protect routes with permission-core. The minimum integration has only three moving parts: register the plugin, let authentication write a trusted subject, and add `permission: true` to protected routes.

The stability model is **fail closed**. If startup configuration is uncertain, the app does not start. If routes change after startup, requests return `503`. Missing authentication returns `401`, missing permission returns `403`, and user-specific response projection disables shared caching.

## Minimal mental model

```text
register permissionPlugin
  -> authentication writes req.auth
  -> route sets permission: true
  -> grant role api:METHOD:/path
  -> plugin checks invoke before the handler runs
  -> handler may read authorized data through req.auth.permission.data
```

For normal route authorization, you do not need to understand response projection, database auto-discovery, plugin ordering, or a custom subject resolver first. When an endpoint needs to read business data, enable `data` and let the handler use the guarded request facade instead of raw MonSQLize collections.

## Prerequisites

- Node.js `>=20.19.0`, required by Vext 0.3.26.
- Install `permission-core`, `monsqlize@3.1.0`, and `vextjs@0.3.26`.
- The host already owns a connected MonSQLize 3.1 instance.
- The authentication plugin runs first and writes trusted `req.auth`.

If you only need route authorization, neither `data` nor response-field configuration is required. Enable `data` only when handlers should read authorized data. Configure fields with `menus.responses.set()` or `menus.config.save()` only when you want automatic response projection.

## 1. Register the plugin

The simplest and easiest setup to debug is passing the host database instance directly:

```ts
import { permissionPlugin } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: appMonSQLize,
  core: {
    collectionPrefix: 'permission_core',
    tokenSecret: process.env.PERMISSION_TOKEN_SECRET,
  },
});
```

This does two things:

- During Vext startup, the plugin creates and initializes `PermissionCore`, then exposes `app.permission`.
- During Vext shutdown, the plugin closes only the PermissionCore it created, not the host MonSQLize instance.

`data` is optional. Without it, route authorization still works. With it, `req.auth.permission.data.collection('orders')` is available. `exposeAs: 'monsqlize'` only adds the friendly alias `req.monsqlize`; it is not a full MonSQLize instance and only exposes guarded collection facades.

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  data: {
    exposeAs: 'monsqlize',
    scopeFields: { tenantId: 'tenantId' },
    collections: {
      orders: { resource: 'db:orders' },
    },
  },
});
```

`authPlugin` defaults to `authentication`. Configure it only when your auth plugin uses another name:

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  authPlugin: 'my-auth',
});
```

## 2. Provide a trusted user from authentication

The permission plugin does not log users in. It reads the `req.auth` object already written by your authentication plugin. Prefer writing `permissionSubject` directly:

```ts
req.auth = {
  isAuthenticated: true,
  permissionSubject: {
    userId: 'u-1',
    scope: { tenantId: 'acme' },
    claims: { merchantId: 'm-7' },
  },
};
```

The shorthand shape is also accepted:

```ts
req.auth = {
  isAuthenticated: true,
  userId: 'u-1',
  scope: { tenantId: 'acme' },
  claims: { merchantId: 'm-7' },
};
```

Security boundary: `userId`, `scope`, and `claims` must come from trusted authentication. Do not trust tenant or user values self-reported in headers, request bodies, or URL parameters.

## 3. Protect a route

For normal protected endpoints, add `permission: true`:

```ts
app.get('/public', {}, publicHandler);

app.get('/orders/:id', { permission: true }, async (req, res) => {
  res.json(await loadOrder(req.params.id));
});
```

`permission: true` automatically requires:

```ts
{ action: 'invoke', resource: 'api:GET:/orders/:id' }
```

Then grant that route resource to a role:

```ts
const scoped = app.permission.scope({ tenantId: 'acme' });

await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/orders/:id',
});

await scoped.userRoles.assign('u-1', 'order-reader');
```

When a request hits `/orders/42`, the plugin checks the route template `api:GET:/orders/:id`, not the concrete URL `api:GET:/orders/42`.

## 4. Read authorized data in a handler

If an endpoint returns order rows from the database, do not call a raw MonSQLize collection from the handler. After enabling the `data` option above, use the request-scoped data facade:

```ts
app.get('/orders', { permission: true }, async (req, res) => {
  const orders = req.monsqlize.collection('orders');
  const items = await orders.find(
    { status: { $in: ['paid', 'shipped'] } },
    {
      projection: ['orderNo', 'status', 'amount'],
      sort: { orderNo: 1 },
      limit: 20,
    },
  );
  res.json({ items, total: items.length });
});
```

Each call-site part has one job:

| Code | Meaning |
|---|---|
| `req.monsqlize.collection('orders')` | Opens the guarded collection named `orders`; the default resource is `db:orders`, or override it with `data.collections.orders.resource`. |
| `find(filter, options)` | Runs a bounded Mongo-style query; the plugin combines the caller filter, tenant equality, role row rules, and field permissions before calling MonSQLize. |
| `projection` | Fields the handler wants to read; the actual result is still intersected with field permissions. |
| `sort/limit` | Normal list options; sort fields must also be readable. |

The role needs both route `invoke` and data `read`:

```ts
await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/orders',
});
await scoped.roles.allow('order-reader', {
  action: 'read',
  resource: 'db:orders',
});
```

If the current subject scope is `{ tenantId: 'acme' }` and `scopeFields.tenantId` maps to the document field `tenantId`, every query is automatically restricted to `tenantId = 'acme'`. Missing `read + db:orders`, unsafe filters, unreadable fields, or missing scope mapping fail closed.

## How to read request outcomes

| Scenario | HTTP result | Meaning |
|---|---:|---|
| Public route | `200` | The route has no `permission` option. |
| Missing trusted authentication | `401` | `req.auth` is missing or the subject is invalid. |
| Authenticated but unauthorized | `403` | The user lacks `invoke` on the route resource. |
| Route allowed but data denied | `403` | The handler used the data facade and the user lacks `read/create/update/delete` on the `db:*` resource. |
| Authenticated and authorized | `200` | The handler may run. |
| Route graph changed after startup | `503` | A cold restart is required before serving requests again. |

This is the core stability rule: the plugin refuses requests when the route or permission state is uncertain.

## Common extensions

### The handler needs an extra business permission

If the route already passed `permission: true`, ordinary collection reads and writes should keep using `req.monsqlize`. Read the request permission context only when the handler needs an extra non-CRUD business action, such as exporting a report, approving an order, or starting a recalculation job:

```ts
import { requirePermissionContext } from 'permission-core/plugins/vext';

app.post('/orders/export', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  await permission.assert('export', 'api:POST:/orders/export');
  res.json(await startExport(permission.subject.userId));
});
```

`requirePermissionContext(req)` returns request-scoped `{ subject, can, assert, filterResponse }`. In this example, `permission: true` already checked `invoke + api:POST:/orders/export`; the explicit `assert('export', ...)` adds a second business decision for the same route. Do not use it as the normal way to read `db:orders`, and do not cache this object across requests.

### A route declares multiple requirements

Most endpoints only need `permission: true`. Use object form only when a route needs combined requirements:

```ts
app.post('/orders/export', {
  permission: {
    mode: 'all',
    requirements: [
      { action: 'invoke' },
      { action: 'export' },
    ],
  },
}, exportHandler);
```

If `resource` is omitted, the current route `api:` resource is used, so `{ action: 'export' }` means `export + api:POST:/orders/export` here. `mode: 'all'` means every requirement must pass; `mode: 'any'` means at least one must pass. A group may contain up to `32` requirements.

### Response field projection

For routes protected with `permission: true`, handlers that return through `res.json()` are automatically projected for the default `api:METHOD:/path` resource, and the plugin writes:

```text
Cache-Control: private, no-store
```

Manual projection looks like this:

```ts
app.get('/orders/:id', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const payload = await loadOrder(req.params.id);
  const projected = await permission.filterResponse('api:GET:/orders/:id', payload);
  res.json(projected.data);
});
```

Protected routes must not use shared cache. If the plugin detects caching on a protected route, it fails startup with `VEXT_ROUTE_PERMISSION_INVALID` to avoid caching one user's projected response for another user.

## Advanced integration options

Prefer passing `monsqlize` directly. Use the following options only when the host architecture needs plugin-to-plugin resolution:

| Option | Use it when |
|---|---|
| `monsqlize` | Recommended. You pass the connected host instance directly. |
| `resolveMonSQLize(app)` | You resolve the instance from the app or another plugin during setup. |
| auto-discovered `app.monsqlize` | A host database plugin exposes the instance on app extensions. |
| `databasePlugin` | Another Vext plugin provides the database and Vext must order plugins correctly. |
| `subject.resolve(req)` | Your auth plugin's `req.auth` shape is not one of the defaults. |
| `data.scopeFields` | Handlers should read/write business data through the request facade; `tenantId` is required. |
| `data.collections` | A physical collection name needs a different logical resource or per-collection scope mapping. |
| `data.exposeAs` | Use `'monsqlize'` to expose `req.monsqlize`; use `false` or omit it when you only want `req.auth.permission.data`. |

Three notes:

- `monsqlize`, `resolveMonSQLize(app)`, and auto-discovered `app.monsqlize` are mutually exclusive database sources.
- `databasePlugin` only controls plugin ordering; it does not create a database connection.
- `subject.resolve(req)` must read only trusted auth and host context, never client-reported identity.
- `req.monsqlize` is not full MonSQLize; it only provides `collection(name)` and returns permission-core `AuthorizedCollection` facades.

## Stability and shutdown boundaries

- Missing or incompatible MonSQLize, extension conflicts, and invalid route permission metadata block startup.
- Route graph changes after startup return `VEXT_ROUTE_RESTART_REQUIRED` (`503`) until a cold restart.
- Protected routes with shared caching block startup.
- `req.auth.permission` and `req.monsqlize` belong to the current request and must not be cached across requests.
- During Vext shutdown, the plugin drains and closes PermissionCore; the host still owns and closes the host database.

Run the [Vext example](/examples/vext) to see the full `200/401/403/503` flow. See [Vext Plugin API](/api/vext-plugin) for all options and exported types.
