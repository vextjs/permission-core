# PermissionCache

`PermissionCache` stores resolved user rule sets by user and permission scope.

## Purpose and import

```typescript
import { PermissionCache } from 'permission-core';
```

Most applications configure cache through `PermissionCore`. Construct `PermissionCache` directly only for custom runtime composition or focused tests.

## Construction and types

`new PermissionCache(options?: PermissionCacheOptions)` accepts `enabled`, `ttl`, `maxEntries`, and a `cache-hub` compatible `cache` instance.

Defaults are `enabled:true`, `ttl:300000` ms, and an internally owned `MemoryCache`. `maxEntries` is passed to the internal cache when provided.

## Signature index

| Method | Result |
|---|---|
| `get(userId, scope?)` | `Promise<PermissionRule[] \| null>` |
| `set(userId, rules, scope?)` | `Promise<void>` |
| `invalidate(userId, scope?)` | `Promise<void>` |
| `invalidateScope(scope?)` | `Promise<void>` |
| `invalidateAll()` | `Promise<void>` |
| `close()` | `Promise<void>` |

## Behavior and defaults

The cache stores merged rules, not final `can()` decisions. Reads and writes clone rule arrays. Disabled cache reads return `null` and writes become no-ops.

Public `pc.users` methods invalidate one user automatically; public `pc.roles` writes invalidate the affected scope. Manual invalidation is for direct storage writes or external synchronization.

## Errors and limits

Scope keys isolate tenants. `invalidateScope()` and `invalidateAll()` use `delPattern` when available and otherwise track/delete known permission keys. They do not clear unrelated MonSQLize query cache entries.

`close()` destroys only an internally created cache. An injected cache remains owned by the application. Backend/cache failures are not converted into authorization denial.

## Minimal example

```typescript
const cache = new PermissionCache({ ttl: 60_000, maxEntries: 1000 });
await cache.set('u-1', rules, { tenantId: 'tenant-a' });
const cached = await cache.get('u-1', { tenantId: 'tenant-a' });
await cache.close();
```

## Related

See [Permission Cache Guide](/guide/cache), [PermissionCore](/api/permission-core), and [Production Deployment](/guide/production-deployment).
