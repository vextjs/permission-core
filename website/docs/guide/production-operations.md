# Production Operations
<!-- docs:inline-parity `PermissionCore.health()` `v2.0.0` `init()` `actorId` `reason` `requestId` `idempotencyKey` `pc.health()` `PermissionCoreHealth` `ready` `health()` `pc.init()` `indexedContractMismatchScopes` `value=0` `truncated=true` `tokens.crossInstanceStable` `pendingCacheOutcomes` `down` `degraded` `previewToken` `expectedRevisions` `operationId` `auditId` `preview*(input, options?)` `ImpactPreview<Plan>` `MutationResult<T>` `PermissionCoreError` `replayed: true` `IDEMPOTENCY_CONFLICT` `LIMIT_EXCEEDED` `PREVIEW_REQUIRED` `ack-required` `REVISION_CONFLICT` `READ_CONFLICT` `PREVIEW_STALE` `CURSOR_STALE` `pc.close()` `close()` `1000..300000` `30000` `CORE_CLOSE_TIMEOUT` `void` `details` `msq.close()` -->

Production readiness depends on a healthy host MonSQLize 3.1 connection, a compatible schema, bounded authorization state, persisted mutation evidence, and the correct close order.

## Preconditions

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Readiness Checklist

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const health = await pc.health();
const ready = health.status === 'up'
  && health.lifecycle === 'ready'
  && health.initialized;
```
```json
{
  "status": "up",
  "lifecycle": "ready",
  "initialized": true,
  "database": { "status": "up" },
  "schema": {
    "expectedVersion": 2,
    "indexedContractMismatchScopes": { "value": 0, "cap": 1000, "truncated": false }
  },
  "tokens": { "keySource": "configured", "crossInstanceStable": true },
  "audit": {
    "pendingCacheOutcomes": { "value": 0, "cap": 1000, "truncated": false }
  }
}
```
## Change and Audit Control

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Capacity and Consistency

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Incident Handling

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Rollback and Shutdown

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

Continue with [Troubleshooting](/guide/troubleshooting).
