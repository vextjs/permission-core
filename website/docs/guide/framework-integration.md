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

## Service-layer data checks

Keep data checks close to the data operation:

```typescript
await pc.assert(userId, 'read', 'db:transactions');
const visible = await pc.filterRows(userId, 'read', 'db:transactions', rows, context);
```

## Next step

See [Express Integration](/examples/express) and [vext Integration](/examples/vext).
