# Express Integration

Use permission-core in Express by initializing one shared runtime, resolving authentication first, building a stable route resource, and calling `assert()`.

## Runtime lifecycle

```typescript
const pc = new PermissionCore({ storage });
await pc.init();

process.on('SIGTERM', async () => {
  await pc.close();
  process.exit(0);
});
```

Do not create one `PermissionCore` per request.

## Route guard

```typescript
app.get('/api/orders/:id', async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ code: 'UNAUTHENTICATED' });
      return;
    }

    await pc.assert(userId, 'invoke', 'GET:/api/orders/:id');
    next();
  } catch (error) {
    if (error instanceof PermissionCoreError && error.code === 'PERMISSION_DENIED') {
      res.status(403).json({ code: error.code });
      return;
    }
    next(error);
  }
});
```

Prefer the route template instead of the concrete request URL.

For routers mounted under a prefix, build the resource from the normalized base path plus the matched template. Never include query strings or a concrete `:id` value.

## Service-layer data authorization

```typescript
async function listOrders(req) {
  const userId = req.user.id;
  await pc.assert(userId, 'read', 'db:orders');
  const rows = await orderRepository.findMany();
  const visibleRows = await pc.filterRows(userId, 'read', 'db:orders', rows, req.authzContext);
  return Promise.all(
    visibleRows.map((row) => pc.filterFields(userId, 'read', 'db:orders', row)),
  );
}
```

The route guard decides whether the request may enter. The service/DAO layer applies collection, row, and field rules with business context.

## Failure handling

- Missing identity is `401` from authentication.
- `PERMISSION_DENIED` is `403`.
- Invalid resources are integration errors and should not be disguised as denial.
- Storage and lifecycle errors must reach the service error handler and operational logs.

See [Error Response Mapping](/guide/error-response-mapping) and [Framework Integration](/guide/framework-integration).
