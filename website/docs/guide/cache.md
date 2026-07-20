# Cache
<!-- docs:inline-parity `cache: { enabled: false }` `get` `set` `del` `delPattern` `getCache()` `get/set/del/delPattern` `pc.init()` `PermissionCoreHealth` `backendState: 'opaque'` `cache.enabled` `true` `monsqlize.getCache()` `cache.consistency` `ordered-bounded-stale` `cache.ttlMs` `pc.health()` `pc.close()` `ttlMs` `30000` `100..86400000` `consistency` `cache` `{ enabled: false }` `PermissionCore.close()` `await pc.health()` `cache.readIncidentActive` `cache.invalidationIncidentActive` `cache.invalidationRiskUntil` `audit.pendingCacheOutcomes` `collectionPrefix` `tokenSecret` -->

Permission caching is optional and disabled by default. Enable it only when the host can prove that the MonSQLize cache backend provides ordered `get`, `set`, `del`, and `delPattern` semantics across all instances.

## Preconditions

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Configuration

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
## Consistency and Ownership

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Incident Handling

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Multi-Instance Checklist

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Rollback

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

Continue with [Vext Plugin](/guide/vext-plugin).
