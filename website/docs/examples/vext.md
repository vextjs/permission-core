# Vext Integration
<!-- docs:inline-parity `examples/vext/index.mjs` `docs:vext:start` `docs:vext:end` `examples/vext/app/src/routes/index.mjs` `200` `401` `403` `503` `permissionCoreClosedByPlugin` `hostDatabaseStillConnected` `true` `permission: true` `api:GET:/orders/:id` `api:GET:/orders-data` `db:orders` `invoke` `read` `req.auth` `req.auth.permission.data` `req.monsqlize.collection` `createTestApp` `permissionPlugin.setup` `permissionPlugin(...)` `.setup` `server:beforeListen` `app.permission` `createTestApp()` `permissionPlugin(options)` `.setup(app)` `void` `scope` `roles.create` `route-reader` `roles.allow` `userRoles.assign` `u-vext` `/orders/42` `/orders-data` `app.permission.scope(scope)` `pc.scope()` `request.get` `allowedBody` `requestDataBody` `requestDataAllowed` `testApp.request.get(path)` `.set()` `status` `allowed.body.data` `dataAllowed.body.data` `routes:ready` `routeReloadRequiresRestart` `VEXT_ROUTE_RESTART_REQUIRED` `hooks.emit('routes:ready', ...)` `request.get('/public')` `testApp.close` `monsqlize.health` `PermissionCore.close()` `testApp.close()` `monsqlize.health()` `printExample()` `responses` `lifecycle` `x-example-user` `permissionPlugin` -->

## Scenario

This example loads the native Vext plugin, protects route templates, reads tenant-scoped data through `req.monsqlize`, exercises public/unauthenticated/denied/allowed requests, proves that route reload requires restart, and verifies that plugin shutdown does not close the host database.

## Run

```bash
npm run example:vext
```

The canonical source is the `docs:vext:start` to `docs:vext:end` block in `examples/vext/index.mjs`, plus `examples/vext/app/src/routes/index.mjs`.

## First Check the Result

A successful run confirms status codes `200`, `401`, `403`, `200`, data route `200`, and restart-required `503`. It also shows `requestDataBody.items` contains only the current tenant's authorized fields, and both `permissionCoreClosedByPlugin` and `hostDatabaseStillConnected` are `true`.

## Source walkthrough

```js
const testApp = await createTestApp({
  rootDir: resolve('examples/vext/app'),
  plugins: false,
  services: false,
  middlewares: false,
  routes: true,
  setupPlugins: async (app) => {
    // Fixture only: production uses a real authentication plugin.
    app.use(async (req, _res, next) => {
      const userId = req.headers['x-example-user'];
      if (userId) {
        Object.defineProperty(req, 'auth', {
          value: { isAuthenticated: true, userId, scope },
          enumerable: true,
        });
      }
      await next();
    });
    await permissionPlugin({
      monsqlize: database.monsqlize,
      core: { collectionPrefix: 'pc_vext_example' },
      data: {
        exposeAs: 'monsqlize',
        scopeFields: { tenantId: 'tenantId' },
        collections: {
          vext_orders: { resource: 'db:orders' },
        },
      },
    }).setup(app);
  },
});
await testApp.app.hooks.emit('server:beforeListen', {
  host: '127.0.0.1', port: 0, adapter: testApp.app.adapter,
});

const scoped = testApp.app.permission.scope(scope);
await scoped.roles.create({ id: 'route-reader', label: 'Route reader' });
await scoped.roles.allow('route-reader', {
  action: 'invoke', resource: 'api:GET:/orders/:id',
});
await scoped.roles.allow('route-reader', {
  action: 'invoke', resource: 'api:GET:/orders-data',
});
await scoped.roles.allow('route-reader', {
  action: 'read', resource: 'db:orders',
});
await scoped.userRoles.assign('u-vext', 'route-reader');
await database.monsqlize.collection('vext_orders').raw().insertMany([
  { tenantId: scope.tenantId, orderNo: 'O-1', status: 'paid', amount: 12 },
  { tenantId: 'other-tenant', orderNo: 'O-2', status: 'paid', amount: 99 },
]);

const publicResponse = await testApp.request.get('/public');
const missingAuth = await testApp.request.get('/orders/42');
const denied = await testApp.request.get('/orders/42')
  .set('x-example-user', 'u-denied');
const allowed = await testApp.request.get('/orders/42')
  .set('x-example-user', 'u-vext');
const dataAllowed = await testApp.request.get('/orders-data')
  .set('x-example-user', 'u-vext');

await testApp.app.hooks.emit('routes:ready', { count: 0, routes: [] });
const restartRequired = await testApp.request.get('/public');
await testApp.close();
const hostDatabase = await database.monsqlize.health();
```

The protected route or companion source used by this scenario is:

```js
app.get('/public', {}, publicHandler);
app.get('/orders/:id', { permission: true }, async (req, res) => {
  res.json({ orderId: req.params.id, userId: req.auth.permission.subject.userId });
});
app.get('/orders-data', { permission: true }, async (req, res) => {
  const items = await req.monsqlize.collection('vext_orders').find({}, {
    projection: ['orderNo', 'status', 'amount'],
    sort: { orderNo: 1 },
  });
  res.json({ items, total: items.length });
});
```

`permission: true` derives `invoke` checks for the route templates. The data facade checks `read` on `db:orders`, injects the current `tenantId`, applies field permissions, and then calls the host MonSQLize collection. The header middleware is a fixture-only authentication source; production uses the real authentication plugin.

### 1. Bootstrap the Vext test host and plugin

<!-- docs:operation id=vext-bootstrap calls=createTestApp,permissionPlugin.setup,server:beforeListen outputs=responses.public -->

**Purpose and target.** This operation explains `createTestApp`, `permissionPlugin.setup`, `server:beforeListen` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `responses.public`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [vext-plugin](/api/vext-plugin) for exact signatures, response wrappers, and public error codes.

### 2. Seed the route permission policy

<!-- docs:operation id=vext-policy calls=scope,roles.create,roles.allow,userRoles.assign outputs=responses.permissionDenied,responses.permissionAllowed -->

**Purpose and target.** This operation explains `scope`, `roles.create`, `roles.allow`, `userRoles.assign` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `responses.permissionDenied`, `responses.permissionAllowed`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [roles](/api/roles), [user-roles](/api/user-roles), [vext-plugin](/api/vext-plugin) for exact signatures, response wrappers, and public error codes.

### 3. Exercise public, authentication, and permission outcomes

<!-- docs:operation id=vext-requests calls=request.get outputs=responses,allowedBody -->

**Purpose and target.** This operation explains `request.get` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `responses`, `allowedBody`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [vext-plugin](/api/vext-plugin) for exact signatures, response wrappers, and public error codes.

### 4. Read protected data through the request facade

<!-- docs:operation id=vext-request-data calls=req.monsqlize.collection outputs=requestDataBody -->

**Purpose and target.** This operation explains `req.monsqlize.collection` as the low-friction data path for a protected Vext handler. It reads the `vext_orders` collection through permission-core rather than through raw MonSQLize.

**State, arguments, and result.** The plugin option maps `vext_orders` to `db:orders` and maps `subject.scope.tenantId` to the document field `tenantId`. The role has `read` on `db:orders`, so `/orders-data` returns `200` and `requestDataBody` contains only authorized rows and fields.

In the source block, `data.collections.vext_orders.resource` is the configuration key, `scopeFields.tenantId` is the tenant mapping, and `req.monsqlize.collection('vext_orders')` is the handler call before `find()`. The grant is `read + db:orders`; the `data` option is what makes the request facade available.

**Failure and next step.** Missing route `invoke`, missing `read` on the data resource, an unsafe filter, or a missing scope mapping fails closed. Fix the role rule or plugin data configuration instead of falling back to raw collection access.

**API reference.** See [vext-plugin](/api/vext-plugin) for the request facade and [authorized-collection](/api/authorized-collection) for collection method details.

### 5. Reject hot route reload

<!-- docs:operation id=vext-reload calls=routes:ready,request.get outputs=responses.routeReloadRequiresRestart -->

**Purpose and target.** This operation explains `routes:ready`, `request.get` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `responses.routeReloadRequiresRestart`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [vext-plugin](/api/vext-plugin) for exact signatures, response wrappers, and public error codes.

### 6. Close only plugin-owned state

<!-- docs:operation id=vext-close calls=testApp.close,monsqlize.health outputs=lifecycle -->

**Purpose and target.** This operation explains `testApp.close`, `monsqlize.health` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `lifecycle`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [vext-plugin](/api/vext-plugin), [core-and-contexts](/api/core-and-contexts) for exact signatures, response wrappers, and public error codes.


## Expected output

The following JSON is the **Example summary output** generated by `printExample()`. It combines selected fields from several API calls and is not the raw response of one method.

```json
{
  "example": "vext",
  "ok": true,
  "responses": {
    "public": 200,
    "missingAuthentication": 401,
    "permissionDenied": 403,
    "permissionAllowed": 200,
    "requestDataAllowed": 200,
    "routeReloadRequiresRestart": 503
  },
  "allowedBody": { "orderId": "42", "userId": "u-vext" },
  "requestDataBody": {
    "items": [{ "orderNo": "O-1", "status": "paid", "amount": 12 }],
    "total": 1
  },
  "lifecycle": {
    "permissionCoreClosedByPlugin": true,
    "hostDatabaseStillConnected": true
  }
}
```

<!-- docs:output group=responses producer=vext-requests -->

**`responses` provenance.** This output group is produced by the vext-requests walkthrough and should be read together with `request.get`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=allowedBody producer=vext-requests -->

**`allowedBody` provenance.** This output group is produced by the vext-requests walkthrough and should be read together with `request.get`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=requestDataBody producer=vext-request-data -->

**`requestDataBody` provenance.** This output group is produced by the `vext-request-data` walkthrough and should be read together with `req.monsqlize.collection`. It is the projected handler response for the protected data route, not raw database output.

<!-- docs:output group=lifecycle producer=vext-close -->

**`lifecycle` provenance.** This output group is produced by the vext-close walkthrough and should be read together with `testApp.close`. It is a selected, documented example field rather than a new API response shape.


## Production boundary

`createTestApp`, the in-memory database, and `x-example-user` are fixtures. Production registers `permissionPlugin` in the normal Vext plugin graph, lets the real authentication plugin provide `req.auth`, and performs a cold restart after route graph changes. Keep raw MonSQLize access in infrastructure code; handlers that serve user data should prefer the request data facade.

## Related

See [Vext Plugin](/guide/vext-plugin), [Authentication Boundary](/guide/authentication-boundary), [Vext Plugin API](/api/vext-plugin), and [Troubleshooting](/guide/troubleshooting).
