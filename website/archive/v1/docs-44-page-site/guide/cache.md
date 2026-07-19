# Permission Cache

permission-core caches resolved user permission sets. Public manager APIs invalidate this cache for their own writes; manual invalidation is mainly for direct storage writes, external synchronization, or deployment-level cache coordination.

## Why cache permissions?

Permission checks can combine user-role bindings, role rules, inherited roles, deny priority, and wildcards. Caching avoids resolving the same user graph on every request.

## Invalidate one user

```typescript
await pc.invalidate('u-1');
```

Call this after changing one user's role bindings outside `pc.users`, such as through a direct adapter write or an external sync job. You do not need to call it again after `pc.users.assign()`, `pc.users.revoke()`, `pc.users.setUserRoles()`, or `pc.users.clearUserRoles()`.

## Invalidate everyone

```typescript
await pc.invalidateAll();
```

Call this after changing a role rule, parent role, or shared permission definition outside `pc.roles`. You do not need to call it again after `pc.roles.allow()`, `pc.roles.deny()`, `pc.roles.revokeRule()`, `pc.roles.clearRules()`, `pc.roles.update()`, or `pc.roles.delete()`.

When `PermissionCore` shares the cache returned by `msq.getCache()`, this only removes `permission-core:rules:*` entries. It does not clear unrelated MonSQLize query cache entries from the same backend.

## Production note

The recommended production stack uses `cache-hub`. Choose a backend and TTL that match your deployment topology. Multi-instance services should use a shared cache or a cache invalidation strategy that reaches every instance.
