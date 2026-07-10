# Framework Integration

permission-core is framework-neutral. Integrate it by extracting `userId`, building a resource string, and calling `can()` or `assert()`.

## Express-style guard

```typescript
async function requirePermission(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ code: 'UNAUTHENTICATED' });
      return;
    }

    await pc.assert(userId, 'invoke', `${req.method}:${req.route.path}`);
    next();
  } catch (error) {
    res.status(403).json({ code: 'PERMISSION_DENIED' });
  }
}
```

## Route path choice

Prefer the matched route template from your framework. Real URLs with record IDs create unstable permission resources.

Authentication must finish first. Build a `PermissionSubject` from trusted identity and tenant sources; if header, claim, and route context disagree, fail closed rather than choosing one by precedence.

## Service-layer data checks

Keep data checks close to the data operation:

```typescript
await pc.assert(userId, 'read', 'db:transactions');
const visible = await pc.filterRows(userId, 'read', 'db:transactions', rows, context);
```

Apply field filtering after row authorization and before serialization. Do not load unbounded datasets only to filter them in memory; translate `getRowScope()` into a structured database query first.

## Layer responsibilities

| Layer | Responsibility |
|---|---|
| Authentication | Verify token/session and produce trusted identity/tenant context |
| Framework guard | Authorize the normalized route resource |
| Service/DAO | Apply collection, row, and field authorization with business context |
| Frontend | Use menu/button snapshots as UX hints, then handle server denial |

## Vext

Vext applications should normally use `createVextPermissionPlugin()` from `permission-core/adapters/vext`. Run authentication before the plugin middleware, enable `tenantRequired` for tenant routes, and let `guardRoutePermissions` consume native route `auth.permissions`.

```javascript
const plugin = createVextPermissionPlugin({
  core: pc,
  init: false,
  tenantRequired: true,
});
await plugin.setup(app);
```

The adapter supports `any/all` route permission groups and returns `AUTH_REQUIRED`/`AUTH_FORBIDDEN` at the host boundary.

## Lifecycle and failures

Initialize one runtime per application, not per request. Close framework/plugin-owned menu resources before the core and keep exactly one owner for a shared database connection. Pass unexpected validation, storage, and lifecycle errors to the application error handler instead of converting every failure to `403`.

## Next step

See [Express Integration](/examples/express) and [vext Integration](/examples/vext).
