# Vext Plugin

Use `permission-core/plugins/vext` when Vext should own plugin ordering, request integration, route guards, error mapping, and PermissionCore shutdown. The plugin consumes a host-owned MonSQLize 3.1 instance; it is not a database adapter and it does not perform login.

## Goals and prerequisites

- Node.js `>=20.19.0`, required by Vext 0.3.26.
- Install `permission-core`, `monsqlize@3.1.0`, and `vextjs@0.3.26`.
- The authentication plugin runs first and writes trusted `req.auth`.
- For automatic response-field projection, save the matching `api:` resource and fields with `menus.responses.set()` or `menus.config.save()`.

## Register the plugin

The easiest path to audit is passing the host database instance directly:

```ts
import { permissionPlugin } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: appMonSQLize,
  authPlugin: 'authentication',
  core: {
    collectionPrefix: 'permission_core',
    tokenSecret: process.env.PERMISSION_TOKEN_SECRET,
  },
});
```

`permissionPlugin(options)` synchronously returns a Vext plugin descriptor. The actual `core.init()`, middleware installation, and `app.permission` extension happen during Vext setup. On shutdown, the plugin closes only the PermissionCore it created, not the host MonSQLize instance.

There are three mutually exclusive database sources:

| Source | Use it when |
|---|---|
| `monsqlize` | You pass the connected host instance directly. |
| `resolveMonSQLize(app)` | You resolve the instance from the app or another plugin during setup. |
| auto-discovered `app.monsqlize` | A host database plugin exposes the instance on app extensions. |

Set `databasePlugin` when another Vext plugin provides the database, so Vext orders plugins correctly. `authPlugin` defaults to `authentication`.

## Provide trusted authentication

The default resolver accepts two auth shapes:

```ts
req.auth = {
  isAuthenticated: true,
  permissionSubject: { userId: 'u-1', scope: { tenantId: 'acme' } },
};

req.auth = {
  isAuthenticated: true,
  userId: 'u-1',
  scope: { tenantId: 'acme' },
  claims: { merchantId: 'm-7' },
};
```

If your authentication plugin uses another shape, configure `resolveSubject(auth, req)`. The resolver should read only trusted auth and host context; never trust tenant or user values self-reported in headers or request bodies.

## Declare route permissions

```ts
app.get('/public', {}, publicHandler);
app.get('/orders/:id', { permission: true }, orderHandler);
app.post('/orders/export', {
  permission: {
    mode: 'all',
    requirements: [
      { action: 'invoke' },
      { action: 'read', resource: 'db:orders' },
    ],
  },
}, exportHandler);
```

`permission: true` automatically requires `invoke + api:GET:/orders/:id` for the route resource. Object form can declare custom requirements; omitted `resource` uses the current route `api:` resource. `any/all` groups accept up to `32` requirements.

Handlers that need extra business checks can use the request permission context:

```ts
import { requirePermissionContext } from 'permission-core/plugins/vext';

async function exportHandler(req) {
  const permission = await requirePermissionContext(req);
  await permission.assert('read', 'db:orders');
  return startExport(permission.subject.userId);
}
```

`requirePermissionContext(req)` returns request-scoped `{ subject, can, assert, filterResponse }`. Use `hasPermissionContext(req)` only when you need a side-effect-free existence/type check.

## Response field projection

For routes protected with `permission: true`, handlers that return through `res.json()` are automatically projected for the default `api:METHOD:/path` resource, and the plugin sets `Cache-Control: private, no-store`.

Manual projection looks like this:

```ts
app.get('/orders/:id', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const payload = await loadOrder(req.params.id);
  const projected = await permission.filterResponse('api:GET:/orders/:id', payload);
  return res.json(projected.data);
});
```

Cache boundaries matter: protected routes must not use shared cache. If the plugin detects caching on a protected route, it fails closed with `VEXT_ROUTE_PERMISSION_INVALID`.

## Failure and shutdown boundaries

- Missing authentication returns `401`; authenticated but unauthorized requests return `403`.
- Missing/incompatible MonSQLize, extension conflicts, and invalid route permission metadata block startup.
- Route graph changes after startup return `VEXT_ROUTE_RESTART_REQUIRED` (`503`) until a cold restart.
- `req.auth.permission` belongs to one request and must not be cached across requests.
- During Vext shutdown, the plugin drains PermissionCore first; the host still closes the host database.

Run the [Vext example](/examples/vext), then see [Vext Plugin API](/api/vext-plugin) for all options and exported types.
