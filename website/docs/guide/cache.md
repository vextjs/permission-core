# Cache

Permission caching is optional. The default is `cache: { enabled: false }`, so permission decisions read MonSQLize-backed state directly. Enable the semantic cache only when the host can attest that its MonSQLize 3.1 cache backend provides ordered `get`, `set`, `del`, and `delPattern` behavior for every permission-core instance.

## Preconditions

- Configure the cache backend on the host-owned MonSQLize instance. permission-core has no cache-hub option and does not own a second cache client.
- Use a shared backend when multiple application instances must observe the same invalidations.
- Keep authorization database writes and cache operations in the required order: database commit first, invalidation second.
- Treat the configured TTL as the maximum incident window after an invalidation failure, not as a guarantee that stale authorization is acceptable.

## Configuration

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

`ttlMs` defaults to `30000` and accepts `100..86400000`. `consistency` is required when enabled and currently accepts only `ordered-bounded-stale`. Omitting `cache`, or setting `{ enabled: false }`, bypasses the permission cache entirely.

## Consistency and ownership

The cache stores revision-bound effective authorization snapshots and menu projections. Keys include the core namespace, complete scope, user, claims/context fingerprints, family, and selector. A cached view is accepted only when its envelope, TTL, family, and known revision contract are valid.

Management mutations commit state and audit evidence in MonSQLize before invalidating affected scope, RBAC, menu, or user key families. Read, decode, or cache-write failures fall back to the database where that is safe. An invalidation failure is different: health stays degraded through the recorded risk window because another reader may still hold an older entry.

The host owns both MonSQLize and its cache backend. `PermissionCore.close()` detaches permission cache usage but does not close either owner resource.

## Failure runbook

1. Read `await pc.health()` and inspect `cache.readIncidentActive`, `cache.invalidationIncidentActive`, `cache.invalidationRiskUntil`, fallback/failure counters, and `audit.pendingCacheOutcomes`.
2. Confirm MonSQLize health and the configured cache backend independently; `backendState: 'opaque'` means permission-core does not claim backend liveness.
3. For read incidents, expect database fallback and investigate latency/capacity before restoring the backend.
4. For invalidation incidents, stop risky permission expansion if necessary, restore ordered invalidation, and wait until the risk window and pending outcomes clear.
5. Do not bypass revision checks, manually mark an incident healthy, or serve a stale allow as a recovery shortcut.

## Multi-instance checklist

- All instances use the same `collectionPrefix`, resource-scheme contract, configured `tokenSecret`, cache backend, and TTL policy.
- The backend's pattern deletion reaches keys written by every instance.
- Health alerts distinguish read fallback from invalidation risk and include pending audit outcomes.
- Deployment tests cover mutation on instance A followed by a permission read on instance B.

## Rollback

The safe rollback is to deploy `cache: { enabled: false }` consistently and return to database-backed decisions. Drain old instances before considering the cache disabled across the fleet. Do not change cache mode independently on random instances during an active authorization incident.

Continue with [Production Operations](/guide/production-operations) for readiness handling and [Audit and Health](/api/audit-and-health) for the exact health shape.
