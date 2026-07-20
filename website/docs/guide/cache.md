# Cache
<!-- docs:inline-parity `cache: { enabled: false }` `get` `set` `del` `delPattern` `getCache()` `get/set/del/delPattern` `pc.init()` `PermissionCoreHealth` `backendState: 'opaque'` `cache.enabled` `true` `monsqlize.getCache()` `cache.consistency` `ordered-bounded-stale` `cache.ttlMs` `pc.health()` `pc.close()` `ttlMs` `30000` `100..86400000` `consistency` `cache` `{ enabled: false }` `PermissionCore.close()` `await pc.health()` `cache.readIncidentActive` `cache.invalidationIncidentActive` `cache.invalidationRiskUntil` `audit.pendingCacheOutcomes` `collectionPrefix` `tokenSecret` -->

Permission caching is optional and disabled by default. Enable it only when the host can prove that the MonSQLize cache backend provides ordered `get`, `set`, `del`, and `delPattern` semantics across all instances.

## Preconditions

- Configure the cache backend on the host-owned MonSQLize instance. permission-core has no cache-hub option and does not own a second cache client.
- Use a shared backend when multiple application instances must observe the same invalidation events.
- Keep the fixed order for authorization writes: commit the database state first, then invalidate affected cache keys.
- Treat `ttlMs` as the maximum risk window after an invalidation failure, not as permission to serve stale authorization forever.

## Configuration

First configure the backend returned by `monsqlize.getCache()` on MonSQLize 3.1. For single-process development you can use MonSQLize's built-in memory cache:

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: {
    maxEntries: 10_000,
    defaultTtl: 30_000,
  },
});
await msq.connect();
```
The memory backend is only a single-process semantic cache. In multi-instance deployments, use a shared backend such as the MonSQLize Redis cache adapter so every PermissionCore instance reads and invalidates the same key space:
```ts
const sharedCache = MonSQLize.createRedisCacheAdapter(
  'redis://127.0.0.1:6379',
);
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: sharedCache,
});
await msq.connect();
```
Both examples configure the MonSQLize-owned cache backend. permission-core does not directly depend on or configure cache-hub, and it does not create a Redis client. If the host uses a multi-level MonSQLize cache, it must prove that pattern invalidation reaches every L1; otherwise keep permission caching disabled or use a directly shared backend for the permission layer.

Then explicitly enable permission-core semantic caching:
```ts
const pc = new PermissionCore({
  monsqlize: msq,
  cache: {
    enabled: true,
    consistency: 'ordered-bounded-stale',
    ttlMs: 30_000,
  },
});

const health = await pc.init();
```
This JSON is a selected `cache` slice from the raw `PermissionCoreHealth` returned by `pc.init()`, not a cache configuration echo. `backendState: 'opaque'` means permission-core does not inspect the host cache's internal health; it does not prove the backend is healthy.

| Config or call | Argument or return | Purpose |
|---|---|---|
| `cache.enabled` | Must be `true` | Lets core call `monsqlize.getCache()` during init and validate required methods. |
| `cache.consistency` | Must be `ordered-bounded-stale` when enabled | The caller attests commit-after-invalidation order and a bounded stale window. |
| `cache.ttlMs` | Default `30000`; range `100..86400000` | TTL for permission semantic entries, not ordinary MonSQLize business-query cache TTL. |
| `pc.init()` | No arguments | Initializes persistence and cache capability, then returns current health. |
| `pc.health()` | No arguments | Re-reads health without changing cache state. |
| `pc.close()` | No arguments | Drains core work; it does not close host MonSQLize or the cache backend. |

Omitting `cache` or passing `{ enabled: false }` bypasses permission caching entirely.
```json
{
  "status": "up",
  "cache": {
    "permissionLayer": "enabled",
    "consistencyAssurance": "caller-attested",
    "backendState": "opaque",
    "readIncidentActive": false,
    "invalidationIncidentActive": false,
    "hits": 0,
    "misses": 0,
    "readFallbacks": 0,
    "invalidationFailures": 0
  }
}
```
## Consistency and Ownership

The cache stores revision-bound effective authorization snapshots and menu projections. Cache keys include the core namespace, complete scope, user, claims/context fingerprint, read family, and selector. A cached view is accepted only when envelope shape, TTL, data family, and known revision contract all match.

Management changes commit state and audit evidence in MonSQLize first, then invalidate the affected scope, RBAC, menu, or user key families. Cache read, decode, or write failures can fall back to the database when safe. Invalidation failure is different: health stays degraded during the recorded risk window because other readers may still hold old entries.

MonSQLize and its cache backend remain host-owned. `PermissionCore.close()` only stops permission-layer cache usage; it never closes those host resources.

## Incident Handling

1. Read `await pc.health()` and inspect `cache.readIncidentActive`, `cache.invalidationIncidentActive`, `cache.invalidationRiskUntil`, fallback/failure counters, and `audit.pendingCacheOutcomes`.
2. Independently check MonSQLize health and the configured cache backend; `backendState: 'opaque'` means permission-core is not claiming backend liveness.
3. During read incidents, expect database fallback and check database latency and capacity before restoring traffic.
4. During invalidation incidents, pause high-risk permission expansion when necessary, restore ordered invalidation, and wait for the risk window plus pending outcomes to clear.
5. Do not bypass revision checks, manually mark health as recovered, or use stale allow results as a shortcut.

## Multi-Instance Checklist

- Every instance uses the same `collectionPrefix`, resource scheme contract, configured `tokenSecret`, cache backend, and TTL policy.
- Pattern deletion reaches keys written by every instance.
- Health alerts distinguish read fallback from invalidation risk and include pending audit outcomes.
- Deployment tests cover instance A changing permission state and instance B reading it afterward.

## Rollback

The safe rollback is to deploy `cache: { enabled: false }` consistently across the whole instance group and return to direct database reads. Do not claim the cluster is cache-free until old instances have drained. During an authorization incident, avoid randomly toggling cache mode on individual instances.

Continue with [Vext Plugin](/guide/vext-plugin).
