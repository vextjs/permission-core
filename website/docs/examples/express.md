# Express Integration

Use permission-core in Express by building a stable resource string and calling `assert()`.

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
  } catch {
    res.status(403).json({ code: 'PERMISSION_DENIED' });
  }
});
```

Prefer the route template instead of the concrete request URL.
