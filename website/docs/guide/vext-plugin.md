# Vext Plugin

Use `permission-core/plugins/vext` when Vext should own plugin ordering, request integration, route guards, error mapping, and PermissionCore shutdown. The plugin still consumes a host-owned MonSQLize 3.1 instance; it is not a database adapter and does not implement login.

## Goal and prerequisites

- Use Node.js `>=20.19.0`. This is Vext 0.3.26's engine requirement; the permission-core root and `match` entries still support Node.js `>=18.0.0`.
- Install exact peers `monsqlize@3.1.0` and `vextjs@0.3.26`.
- Load the host database and authentication plugins before `permission-core`.
- Ensure authentication writes trusted `req.auth` state; request headers or bodies are not permission subjects by themselves.
- Import the integration from the package's documented `permission-core/plugins/vext` subpath.

## Register the plugin

The explicit and easiest-to-audit path passes the host instance directly:

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

Alternatively, provide `resolveMonSQLize(app)`, or let the plugin discover an own `app.monsqlize` data property. Automatic discovery intentionally requires the same MonSQLize 3.1 constructor identity. Set `databasePlugin` when discovery depends on another Vext plugin so Vext can order it; `authPlugin` defaults to `authentication`.

The three database paths are mutually exclusive. The plugin calls `core.init()`, extends `app.permission`, installs request middleware and hooks, and registers `core.close()` with Vext. The host database remains open after the permission plugin closes.

## Supply trusted authentication

The default resolver accepts exactly one authenticated shape:

```ts
req.auth = {
  isAuthenticated: true,
  permissionSubject: { userId: 'u-1', scope: { tenantId: 'acme' } },
};

// Or:
req.auth = {
  isAuthenticated: true,
  userId: 'u-1',
  scope: { tenantId: 'acme' },
  claims: { merchantId: 'm-7' },
};
```

Use `resolveSubject(auth, req)` when the authentication plugin uses a different shape. If canonical user/scope fields are also present, the resolver must return the same owner or the request fails with `SCOPE_CONFLICT`. `req.auth.permission` is created lazily only when a protected route or application code requests it.

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

Missing or `false` means public. `true` means `invoke` on the matched route template, such as `GET:/orders/:id`. A single object declares one requirement; `any`/`all` accepts `1..32` requirements. The plugin builds a route manifest at `routes:ready`, exposes its API-binding candidates to `validateRouteManifest`, and commits the initial contract before listen.

## Failure and close boundary

- Missing authentication is `401`; permission denial is `403`.
- Missing/incompatible MonSQLize, extension conflicts, and invalid initial route metadata fail startup.
- Any route reload after the committed initial manifest returns `VEXT_ROUTE_RESTART_REQUIRED` (`503`) until a cold restart. The plugin does not silently accept a changed authorization contract.
- `req.auth.permission` is request-owned and cannot be reused after its request ends.
- On Vext close, permission-core drains first; the database plugin or host closes MonSQLize afterward.

Run the [Vext example](/examples/vext), then consult the [Vext Plugin API](/api/vext-plugin) for every option and exported type.
