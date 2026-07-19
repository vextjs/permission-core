# Vext Integration

## Scenario

This example loads the native Vext plugin, protects a route template, exercises public/unauthenticated/denied/allowed requests, proves route reload requires restart, and verifies that plugin shutdown does not close the host database.

## Run

```bash
npm run example:vext
```

The canonical sources are `examples/vext/index.mjs` (`docs:vext:start` to `docs:vext:end`) and `examples/vext/app/src/routes/index.mjs`.

## Source walkthrough

```js
await permissionPlugin({ monsqlize: database.monsqlize }).setup(app);

app.get('/public', {}, publicHandler);
app.get('/orders/:id', { permission: true }, async (req, res) => {
  res.json({ orderId: req.params.id, userId: req.auth.permission.subject.userId });
});
```

`permission: true` derives `invoke` on `GET:/orders/:id`. The test-only header middleware supplies a reproducible `req.auth`; production uses a real authentication plugin.

### 1. Bootstrap the Vext test host and plugin

<!-- docs:operation id=vext-bootstrap calls=createTestApp,permissionPlugin.setup,server:beforeListen outputs=responses.public -->

**Purpose and target.** `createTestApp` boots the fixture host, `permissionPlugin.setup` (the `.setup` returned by `permissionPlugin(...)`) installs permission-core into Vext, and `server:beforeListen` completes startup probes before requests are accepted.

**State, arguments, and result.** The plugin receives the host's connected MonSQLize instance and a collection prefix, then exposes `app.permission`. The public route remains unprotected; its later 200 response proves the host and route graph are usable after bootstrap.

**Failure and next step.** Missing/incompatible MonSQLize, failed PermissionCore initialization, or invalid route metadata prevents readiness. Fix host configuration and restart; do not serve protected routes with a partially initialized plugin.

**API reference.** See [Vext Plugin API](/api/vext-plugin) for plugin options, setup hooks, resolved host state, and startup errors.

### 2. Seed the route permission policy

<!-- docs:operation id=vext-policy calls=scope,roles.create,roles.allow,userRoles.assign outputs=responses.permissionDenied,responses.permissionAllowed -->

**Purpose and target.** `scope` selects the Vext host's tenant context; `roles.create` creates `route-reader`, `roles.allow` permits `invoke` on the normalized template `GET:/orders/:id`, and `userRoles.assign` adds the role to `u-vext`.

**State, arguments, and result.** The permission resource matches the template derived from `permission: true`, not the concrete `/orders/42` URL. This durable state is why `u-vext` receives 200 while another authenticated user receives 403.

**Failure and next step.** A different action/resource template, wrong scope, or missing assignment produces default deny. Compare the route manifest with the stored rule and subject scope, then correct the backend policy rather than weakening the route.

**API reference.** See [Roles](/api/roles), [User Roles](/api/user-roles), and [Vext Plugin API](/api/vext-plugin).

### 3. Exercise public, authentication, and permission outcomes

<!-- docs:operation id=vext-requests calls=request.get outputs=responses,allowedBody -->

**Purpose and target.** Four `request.get` calls cover a public route, a protected route without authentication, the same route with an unprivileged identity, and the route with `u-vext`.

**State, arguments, and result.** The fixture header middleware creates `req.auth` only for supplied test users. The plugin distinguishes 401 missing authentication from 403 authenticated-but-denied; the allowed handler reads the trusted permission subject and produces `allowedBody`.

**Failure and next step.** A 401 means authentication did not supply trusted identity; a 403 means authorization denied the concrete route. Diagnose those layers separately and preserve the status boundary instead of turning both into a generic success or redirect.

**API reference.** See [Vext Plugin](/guide/vext-plugin) for the request lifecycle and [Vext Plugin API](/api/vext-plugin) for request context helpers and error mapping.

### 4. Reject hot route reload

<!-- docs:operation id=vext-reload calls=routes:ready,request.get outputs=responses.routeReloadRequiresRestart -->

**Purpose and target.** Emitting `routes:ready` after startup simulates a route graph change, then `request.get` verifies that permission-core no longer serves against a stale manifest.

**State, arguments, and result.** The plugin marks the route graph restart-required and returns 503 on the following request. `routeReloadRequiresRestart` records that operational fail-closed response.

**Failure and next step.** Do not ignore the 503 or continue with old route permissions. Perform a cold process restart so startup rebuilds and validates the complete route manifest.

**API reference.** See [Vext Plugin API](/api/vext-plugin) and [Troubleshooting](/guide/troubleshooting) for `VEXT_ROUTE_RESTART_REQUIRED` handling.

### 5. Close only plugin-owned state

<!-- docs:operation id=vext-close calls=testApp.close,monsqlize.health outputs=lifecycle -->

**Purpose and target.** `testApp.close` lets the plugin close the PermissionCore instance it created; a subsequent `monsqlize.health` call proves the host-owned database remains connected.

**State, arguments, and result.** Ownership is asymmetric: plugin shutdown drains permission work, while the host retains responsibility for its shared database. The two lifecycle booleans report both sides of that contract.

**Failure and next step.** If shutdown fails, stop accepting requests, complete PermissionCore drain/close handling, and let the host close MonSQLize only at the host lifecycle boundary. Never let the plugin silently dispose a shared connection.

**API reference.** See [Vext Plugin API](/api/vext-plugin) for teardown ownership and [Core and Contexts](/api/core-and-contexts) for `PermissionCore.close()`.

## Expected output

```json
{
  "example": "vext",
  "ok": true,
  "responses": {
    "public": 200,
    "missingAuthentication": 401,
    "permissionDenied": 403,
    "permissionAllowed": 200,
    "routeReloadRequiresRestart": 503
  },
  "allowedBody": { "orderId": "42", "userId": "u-vext" },
  "lifecycle": {
    "permissionCoreClosedByPlugin": true,
    "hostDatabaseStillConnected": true
  }
}
```

<!-- docs:output group=responses producer=vext-requests -->

**`responses` provenance.** Each status is read from one real fixture `request.get` response. The reload status is produced by the separate route-change probe, so the five values cover public, authentication, authorization, success, and restart-required boundaries.

<!-- docs:output group=allowedBody producer=vext-requests -->

**`allowedBody` provenance.** Only the allowed `request.get` reaches the protected-route handler and emits this body. Its route parameter and subject user ID prove that authorization completed before business code used trusted request context.

<!-- docs:output group=lifecycle producer=vext-close -->

**`lifecycle` provenance.** `testApp.close` establishes the PermissionCore side; the post-close `monsqlize.health` response establishes that the host database is still up and connected.

## Production boundary

`createTestApp`, the memory database, and `x-example-user` authentication are fixtures. Production registers `permissionPlugin` in the normal Vext plugin graph, loads authentication first, passes/discovers the host MonSQLize 3.1 instance, and performs a cold restart when routes change.

## Related

See [Vext Plugin](/guide/vext-plugin), [Authentication Boundary](/guide/authentication-boundary), [Vext Plugin API](/api/vext-plugin), and [Troubleshooting](/guide/troubleshooting).
