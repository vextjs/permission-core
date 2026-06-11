# PermissionCache

`PermissionCache` wraps permission resolution cache behavior. Most applications interact with it through `PermissionCore.invalidate()` and `PermissionCore.invalidateAll()`.

## User invalidation

```typescript
await pc.invalidate('u-1');
```

Use this after changing one user's role bindings.

## Global invalidation

```typescript
await pc.invalidateAll();
```

Use this after changing role rules, role inheritance, or shared policy data.

## Production guidance

Use a cache strategy that matches your service topology. If you deploy multiple instances, make sure cache invalidation reaches all relevant instances or use a shared cache backend.
