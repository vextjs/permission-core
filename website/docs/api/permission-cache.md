# PermissionCache

`PermissionCache` wraps permission resolution cache behavior. Most applications interact with cache invalidation indirectly through `pc.roles` and `pc.users`; those public managers invalidate their own writes automatically.

Use `PermissionCore.invalidate()` and `PermissionCore.invalidateAll()` when you intentionally change permission data outside the public managers, such as direct adapter writes, external synchronization, or deployment-level cache coordination.

## User invalidation

```typescript
await pc.invalidate('u-1');
```

Use this after changing one user's role bindings outside `pc.users`. You do not need to call it again after `pc.users.assign()`, `pc.users.revoke()`, `pc.users.setUserRoles()`, or `pc.users.clearUserRoles()`.

## Global invalidation

```typescript
await pc.invalidateAll();
```

Use this after changing role rules, role inheritance, or shared policy data outside `pc.roles`. You do not need to call it again after `pc.roles.allow()`, `pc.roles.deny()`, `pc.roles.revokeRule()`, `pc.roles.clearRules()`, `pc.roles.update()`, or `pc.roles.delete()`.

The method only removes permission-core rule keys (`permission-core:rules:*`) from a shared `cache-hub` instance, so MonSQLize query cache entries that use the same cache backend are left intact.

## Production guidance

Use a cache strategy that matches your service topology. If you deploy multiple instances, make sure cache invalidation reaches all relevant instances or use a shared cache backend.
