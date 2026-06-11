# Permission Cache

permission-core caches resolved user permission sets. Cache invalidation should be part of your management workflow.

## Why cache permissions?

Permission checks can combine user-role bindings, role rules, inherited roles, deny priority, and wildcards. Caching avoids resolving the same user graph on every request.

## Invalidate one user

```typescript
await pc.invalidate('u-1');
```

Call this after changing the roles assigned to one user.

## Invalidate everyone

```typescript
await pc.invalidateAll();
```

Call this after changing a role rule, parent role, or shared permission definition that can affect many users.

## Production note

The recommended production stack uses `cache-hub`. Choose a backend and TTL that match your deployment topology. Multi-instance services should use a shared cache or a cache invalidation strategy that reaches every instance.
