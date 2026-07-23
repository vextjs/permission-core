# Vext Plugin

If your app already uses Vext, token authentication, the Vext database plugin, and MonSQLize, use `permission-core/plugins/vext` to connect the authenticated user to route permissions, data permissions, and response-field permissions. For normal endpoints, keep business code close to the way Vext apps are already written: `app.db.collection()`, `app.db.model()`, and service methods. The permission plugin safely enhances those native entries inside protected requests.

One rule matters first: the frontend may send a token, but an authentication plugin must verify that token first; permissionPlugin only reads trusted `req.auth`. Route checks, data permissions, and response projection all use that trusted user.

## Start with the final shape

After integration, the plugin configuration usually looks like this:

```ts
import { permissionPlugin } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: appMonSQLize,
  routes: {
    protect: ['/api/**'],
    public: ['/api/auth/**', '/api/health'],
  },
  data: {
    transparent: true,
    scopeFields: { tenantId: 'tenantId' },
  },
});
```

Business code keeps using normal Vext database access:

```ts
export default class OrderService {
  constructor(private app: VextApp) {}

  async listPaidOrders() {
    const Order = this.app.db.model('Order');
    return Order.find(
      { status: { $in: ['paid', 'shipped'] } },
      {
        projection: ['orderNo', 'status', 'amount'],
        sort: { orderNo: 1 },
        limit: 20,
      },
    );
  }
}
```

You only need three ideas first:

- `routes.protect`: server-side defaults for protected route patterns, so you do not repeat `permission: true` on every route.
- `routes.public`: explicit public exceptions such as login and health checks.
- `data.transparent: true`: inside protected requests, `app.db.collection()` / `app.db.model()` automatically merge tenant, row, and field permissions; background jobs and public routes still use the host's raw DB.

## Integration flow

```text
frontend token
  -> authentication plugin verifies token and writes trusted req.auth
  -> register permissionPlugin
  -> routes.protect protects business routes in batches
  -> grant role api:METHOD:/path
  -> service/handler keeps using app.db.collection(...) or app.db.model(...)
  -> plugin handles 401/403, data permissions, and response projection
```

If you only need route authorization, configure `routes.protect/public` and API grants. If a handler or service reads or writes the database, enable `data.transparent`. If you need to hide response fields, continue to “Response field projection”. Complete options and types live in [Vext Plugin API](/api/vext-plugin); this guide keeps only the current recommended integration path.

## Prerequisites

- Node.js `>=20.19.0`, required by Vext 0.3.26.
- Install `permission-core`, `monsqlize@3.1.0`, and `vextjs@0.3.26`.
- The host already owns a connected MonSQLize 3.1 instance. If it uses the Vext database plugin, it usually already has `app.db` and `app.monsqlize`.
- The authentication plugin runs first, verifies the token, and writes trusted `req.auth`.

If you only need route authorization, neither `data` nor response-field configuration is required. Enable `data.transparent` only when `app.db.collection()` / `app.db.model()` should automatically apply data permissions inside protected requests. Configure fields with `menus.responses.set()` or `menus.config.save()` only when you want automatic response projection. The minimal response-field setup appears in “Response field projection” below.

## 1. Authentication verifies the token first

permission-core does not log users in and does not directly trust frontend tokens. The correct chain is: your authentication plugin verifies the token signature, session, and expiry, then writes the trusted user to `req.auth`. Prefer writing `permissionSubject` directly:

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

## 2. Register permissionPlugin

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

`routes` is optional, but recommended for business API prefixes:

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  routes: {
    protect: ['/api/**'],
    public: ['/api/auth/**', '/api/health'],
  },
});
```

This means `/api/**` is protected by default, while `/api/auth/**` and `/api/health` are explicitly public. Whether authorization is enabled is decided by server configuration, not by frontend headers.

`data` is optional. Without it, route authorization still works. When `transparent` is enabled, `app.db.collection()` and `app.db.model()` automatically become permission-aware inside protected requests. You do not need to write `resource: 'db:orders'` here. `collection('orders')` reads the host `orders` collection by default and derives the permission resource `db:orders` automatically.

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  data: {
    transparent: true,
    scopeFields: { tenantId: 'tenantId' },
  },
});
```

Use a `collections` override only when the physical collection name differs from the permission resource, or when a collection needs its own scope mapping:

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  data: {
    transparent: true,
    scopeFields: { tenantId: 'tenantId' },
    collections: {
      vext_orders: { resource: 'db:orders' },
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

## 3. Route defaults and per-route overrides

Prefer `routes.protect/public` for most business routes. You do not need to repeat `permission: true` on every route:

```ts
app.get('/public', {}, publicHandler);

app.get('/api/orders/:id', {}, async (req, res) => {
  res.json(await loadOrder(req.params.id));
});
```

If `/api/orders/:id` matches `routes.protect: ['/api/**']`, the plugin automatically requires:

```ts
{ action: 'invoke', resource: 'api:GET:/api/orders/:id' }
```

When a request hits `/api/orders/42`, the plugin checks the route template `api:GET:/api/orders/:id`, not the concrete URL `api:GET:/api/orders/42`.

Single routes can still override the default:

```ts
app.get('/api/public-products', { permission: false }, publicHandler);

app.post('/api/orders/export', {
  permission: {
    mode: 'all',
    requirements: [
      { action: 'invoke' },
      { action: 'export' },
    ],
  },
}, exportHandler);
```

## 4. Grant the API permission to a role

After a route matches `routes.protect`, or after a route explicitly sets `permission: true`, grant the corresponding API permission to a role:

```ts
const scoped = app.permission.scope({ tenantId: 'acme' });

await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/api/orders/:id',
});

await scoped.userRoles.assign('u-1', 'order-reader');
```

## 5. Keep using app.db for business CRUD

If an endpoint returns order rows from the database, enable `data.transparent` and keep using Vext's native DB access. Inside protected requests, `app.db.collection()` becomes the permission-aware collection:

```ts
app.get('/api/orders', {}, async (req, res) => {
  const orders = req.app.db.collection('orders');
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

If your project keeps queries in a Vext service, keep using `this.app.db`:

```ts
export default class OrderService {
  constructor(private app: VextApp) {}

  async listPaidOrders() {
    const orders = this.app.db.collection('orders');
    return orders.find({ status: 'paid' }, {
      projection: ['orderNo', 'status', 'amount'],
      sort: { orderNo: 1 },
    });
  }
}
```

The Vext model layer is also supported for basic CRUD:

```ts
export default class OrderService {
  constructor(private app: VextApp) {}

  async listPaidOrdersByModel() {
    const Order = this.app.db.model('Order');
    return Order.find({ status: 'paid' }, {
      projection: ['orderNo', 'status', 'amount'],
      sort: { orderNo: 1 },
    });
  }
}
```

Each call-site part has one job:

| Code | Meaning |
|---|---|
| `req.app.db.collection('orders')` / `this.app.db.collection('orders')` | Opens the guarded `orders` collection inside a protected request; the default resource is `db:orders`. |
| `this.app.db.model('Order')` | Resolves the model `collectionName` and applies data permissions to the underlying collection. R1 transparent facade supports basic CRUD; `raw()`, index management, `aggregate()`, and `watch()` do not silently bypass permission checks. |
| `find(filter, options)` | Runs a bounded Mongo-style query; the plugin combines the caller filter, tenant equality, role row rules, and field permissions before calling MonSQLize. |
| `projection` | Fields the handler wants to read; the actual result is still intersected with field permissions. |
| `sort/limit` | Normal list options; sort fields must also be readable. |

The role needs both route `invoke` and data `read`:

```ts
await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/api/orders',
});
await scoped.roles.allow('order-reader', {
  action: 'read',
  resource: 'db:orders',
});
```

If the current subject scope is `{ tenantId: 'acme' }` and `scopeFields.tenantId` maps to the document field `tenantId`, every query is automatically restricted to `tenantId = 'acme'`. Missing `read + db:orders`, unsafe filters, unreadable fields, or missing scope mapping fail closed.

`app.db.use(...)`, `app.db.pool(...)`, model `raw()`, collection/index management, `aggregate()`, and `watch()` are not transparently allowed inside protected requests. If you need those advanced operations, design their permission resource, rule, and audit boundary explicitly instead of letting them bypass authorization by accident.

## 6. How to read request outcomes

| Scenario | HTTP result | Meaning |
|---|---:|---|
| Public route | `200` | The route does not match `routes.protect`, or it matches `routes.public` / `permission: false`. |
| Missing trusted authentication | `401` | `req.auth` is missing or the subject is invalid. |
| Authenticated but unauthorized | `403` | The user lacks `invoke` on the route resource. |
| Route allowed but data denied | `403` | The handler used the data facade and the user lacks `read/create/update/delete` on the `db:*` resource. |
| Authenticated and authorized | `200` | The handler may run. |
| Route graph changed after startup | `503` | A cold restart is required before serving requests again. |

This is the core stability rule: the plugin refuses requests when the route or permission state is uncertain.

## 7. Response field projection when needed

Field permissions are not written in the handler. First save the fields that this API may return from your management side:

```ts
await scoped.menus.responses.set('admin', {
  owner: {
    ownerType: 'load',
    viewId: 'orders-list',
    resource: 'api:GET:/api/orders',
  },
  response: {
    target: 'items',
    preserve: ['total'],
    fields: [
      { field: 'orderNo', title: 'Order No.' },
      { field: 'status', title: 'Status' },
      { field: 'amount', title: 'Amount' },
    ],
  },
});
```

This means `/api/orders` returns `{ items, total }`, only fields inside `items` are projected, and `total` is preserved. After saving the response fields, grant field access to roles. See [Configure APIs and Response Fields](/guide/api-bindings) for the full flow.

For routes protected by `routes.protect` or a route-level `permission` option, handlers that return through `res.json()` are automatically projected for the default `api:METHOD:/path` resource, and the plugin writes:

```text
Cache-Control: private, no-store
```

Manual projection looks like this:

```ts
app.get('/api/orders/:id', {}, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const payload = await loadOrder(req.params.id);
  const projected = await permission.filterResponse('api:GET:/api/orders/:id', payload);
  res.json(projected.data);
});
```

Protected routes must not use shared cache. If the plugin detects caching on a protected route, it fails startup with `VEXT_ROUTE_PERMISSION_INVALID` to avoid caching one user's projected response for another user.

## 8. Extra permissions when needed

### A route declares multiple requirements

Most endpoints only need to match `routes.protect`. Use object form only when a route needs combined requirements:

```ts
app.post('/api/orders/export', {
  permission: {
    mode: 'all',
    requirements: [
      { action: 'invoke' },
      { action: 'export' },
    ],
  },
}, exportHandler);
```

If `resource` is omitted, the current route `api:` resource is used, so `{ action: 'export' }` means `export + api:POST:/api/orders/export` here. `mode: 'all'` means every requirement must pass; `mode: 'any'` means at least one must pass. A group may contain up to `32` requirements.

This is the right shape for static permissions: the route must satisfy both `invoke` and `export` before the handler runs. Ordinary collection/model reads and writes should still use `app.db`.

### Dynamically check an extra permission in the handler

Read the request permission context only when the extra permission depends on a business condition inside the handler. For example, the same approval endpoint can require `approve-large-order` only for large orders:

```ts
import { requirePermissionContext } from 'permission-core/plugins/vext';

app.post('/api/orders/:id/approve', {}, async (req, res) => {
  const order = await loadOrder(req.params.id);

  if (order.amount >= 10000) {
    const permission = await requirePermissionContext(req);
    await permission.assert('approve-large-order', 'api:POST:/api/orders/:id/approve');
  }

  res.json(await approveOrder(order.id));
});
```

`requirePermissionContext(req)` returns request-scoped `{ subject, can, assert, filterResponse }`. Route default protection already checked `invoke + api:POST:/api/orders/:id/approve`; the handler `assert()` only adds a dynamic condition. Do not use it as the normal way to read `db:orders`, and do not cache this object across requests.

## 9. Advanced integration options

Prefer passing `monsqlize` directly. Use the following options only when the host architecture needs plugin-to-plugin resolution:

| Option | Use it when |
|---|---|
| `monsqlize` | Recommended. You pass the connected host instance directly. |
| `resolveMonSQLize(app)` | You resolve the instance from the app or another plugin during setup. |
| auto-discovered `app.monsqlize` | A host database plugin exposes the instance on app extensions. |
| `databasePlugin` | Another Vext plugin provides the database and Vext must order plugins correctly. |
| `routes.protect` | Protect route patterns from server configuration, for example `['/api/**']`. |
| `routes.public` | Exclude explicit public routes from default protection, such as login and health checks. |
| `subject.resolve(req)` | Your auth plugin's `req.auth` shape is not one of the defaults. |
| `data.transparent` | Recommended main path. Protect `app.db.collection()` / `app.db.model()` inside protected requests. |
| `data.scopeFields` | Required when transparent or explicit data access is enabled; `tenantId` is required. |
| `data.collections` | A physical collection name needs a different logical resource or per-collection scope mapping. |

Three notes:

- `monsqlize`, `resolveMonSQLize(app)`, and auto-discovered `app.monsqlize` are mutually exclusive database sources.
- `databasePlugin` only controls plugin ordering; it does not create a database connection.
- `subject.resolve(req)` must read only trusted auth and host context, never client-reported identity.
- `routes.protect/public` comes from server configuration; do not let frontend request headers decide whether authorization is enabled or bypassed.
- `data.transparent` enhances `app.db` only inside protected request context; non-request code, background jobs, and public routes still use the host's raw DB.

## Stability and shutdown boundaries

- Missing or incompatible MonSQLize, extension conflicts, and invalid route permission metadata block startup.
- Route graph changes after startup return `VEXT_ROUTE_RESTART_REQUIRED` (`503`) until a cold restart.
- Protected routes with shared caching block startup.
- `req.auth.permission` and transparent `app.db` authorization results belong to the current request and must not be cached across requests.
- During Vext shutdown, the plugin drains and closes PermissionCore; the host still owns and closes the host database.

Run the [Vext example](/examples/vext) to see the full `200/401/403/503` flow. See [Vext Plugin API](/api/vext-plugin) for all options and exported types.
