# Vext Plugin
<!-- docs:inline-parity `permission-core/plugins/vext` `>=20.19.0` `match` `>=18.0.0` `monsqlize@3.1.0` `vextjs@0.3.26` `permission-core` `req.auth` `permissionPlugin(options)` `core.init()` `app.permission` `monsqlize` `resolveMonSQLize` `authPlugin` `authentication` `core` `permissionPlugin()` `resolveMonSQLize(app)` `app.monsqlize` `databasePlugin` `core.close()` `resolveSubject(auth, req)` `SCOPE_CONFLICT` `req.auth.permission` `resolveSubject` `auth` `req` `PermissionSubject | Promise<PermissionSubject>` `app.get/post` `permission` `false/省略` `true` `mode='all'|'any'` `1..32` `requirePermissionContext(req)` `{ subject, can, assert }` `hasPermissionContext(req)` `false` `invoke` `GET:/orders/:id` `any` `all` `routes:ready` `validateRouteManifest` `401` `403` `VEXT_ROUTE_RESTART_REQUIRED` `503` -->

Use `permission-core/plugins/vext` when Vext should own plugin ordering, request integration, route guards, error mapping, and PermissionCore shutdown. The plugin still consumes the host-owned MonSQLize 3.1 instance.

## Goals and Preconditions

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Register the Plugin

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
## Provide Trusted Authentication

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
req.auth = {
  isAuthenticated: true,
  permissionSubject: { userId: 'u-1', scope: { tenantId: 'acme' } },
};

// 或：
req.auth = {
  isAuthenticated: true,
  userId: 'u-1',
  scope: { tenantId: 'acme' },
  claims: { merchantId: 'm-7' },
};
```
## Declare Route Permissions

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
```ts
import { requirePermissionContext } from 'permission-core/plugins/vext';

async function exportHandler(req) {
  const permission = await requirePermissionContext(req);
  await permission.assert('read', 'db:orders');
  return startExport(permission.subject.userId);
}
```
## Failure and Shutdown Boundary

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

Continue with [Authentication Boundary](/guide/authentication-boundary).
