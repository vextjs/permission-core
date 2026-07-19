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

## Production boundary

`createTestApp`, the memory database, and `x-example-user` authentication are fixtures. Production registers `permissionPlugin` in the normal Vext plugin graph, loads authentication first, passes/discovers the host MonSQLize 3.1 instance, and performs a cold restart when routes change.

## Related

See [Vext Plugin](/guide/vext-plugin), [Authentication Boundary](/guide/authentication-boundary), [Vext Plugin API](/api/vext-plugin), and [Troubleshooting](/guide/troubleshooting).
