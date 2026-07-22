# Production Operations
<!-- docs:inline-parity `PermissionCore.health()` `v3.0.0` `init()` `actorId` `reason` `requestId` `idempotencyKey` `pc.health()` `PermissionCoreHealth` `ready` `health()` `pc.init()` `indexedContractMismatchScopes` `value=0` `truncated=true` `tokens.crossInstanceStable` `pendingCacheOutcomes` `down` `degraded` `previewToken` `expectedRevisions` `operationId` `auditId` `preview*(input, options?)` `ImpactPreview<Plan>` `MutationResult<T>` `PermissionCoreError` `replayed: true` `IDEMPOTENCY_CONFLICT` `LIMIT_EXCEEDED` `PREVIEW_REQUIRED` `ack-required` `REVISION_CONFLICT` `READ_CONFLICT` `PREVIEW_STALE` `CURSOR_STALE` `pc.close()` `close()` `1000..300000` `30000` `CORE_CLOSE_TIMEOUT` `void` `details` `msq.close()` -->

Production readiness depends on a healthy host MonSQLize 3.1 connection, a compatible schema, bounded authorization state, persisted mutation evidence, and the correct close order.

> **Version status.** This page describes the repository `v3.0.0` candidate. Release decisions should verify [CHANGELOG](https://github.com/vextjs/permission-core/blob/main/CHANGELOG.md), the actual installed package version, and the deployment artifact being promoted.

## Preconditions

- Use a MongoDB deployment that supports the transactions and MonSQLize 3.1 capabilities probed by `init()`.
- Keep every instance on the same collection prefix, resource-scheme definition/version, scope model, cache policy, and configured token secret.
- Call `init()` exactly once before accepting authorization traffic and treat initialization failure as startup failure.
- Replayable management writes should include `actorId`, `reason`, and `requestId`; permission-core derives an internal idempotency key from `requestId` and the current input. Pass `idempotencyKey` explicitly only when integrating an external idempotency protocol.

## Readiness Checklist

Use `PermissionCore.health()` for readiness. A process being reachable is not the same as the authorization service being ready.

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
    "expectedVersion": 3,
    "indexedContractMismatchScopes": { "value": 0, "cap": 1000, "truncated": false }
  },
  "tokens": { "keySource": "configured", "crossInstanceStable": true },
  "audit": {
    "pendingCacheOutcomes": { "value": 0, "cap": 1000, "truncated": false }
  }
}
```
This is a selected raw `PermissionCoreHealth` shape. The local `ready` boolean is computed by the host and is not a health response field. `health()` is read-only and does not try to repair dependencies.

| Field or method | Operational decision |
|---|---|
| `pc.init()` | Run on startup and inspect returned health; failure should block traffic. |
| `pc.health()` | Readiness and diagnostics call; check database/schema/cache/audit, not only status. |
| `indexedContractMismatchScopes` | `value=0` proves no mismatch in the checked range; `truncated=true` is not a complete list. |
| `tokens.crossInstanceStable` | Should be true when multiple instances execute preview/cursor flows. |
| `pendingCacheOutcomes` | Non-zero means a database commit is waiting for cache reconciliation; avoid duplicate business mutations. |

`down` means core is not ready or the database is unavailable. `degraded` means the database is usable but schema mismatch, cache events, or pending cache outcomes need action. Bounded counters can truncate; zero is a conclusion, but a capped non-zero value is not a full inventory.
## Change and Audit Control

Destructive, structural, replacement, and high-impact changes use preview/execute. Execution must submit the original `previewToken` and `expectedRevisions` returned by preview; capacity risks should be confirmed only after the admin UI shows the assessment.

| Phase | Raw return | What the admin backend must do |
|---|---|---|
| `preview*(input, options?)` | `ImpactPreview<Plan>` | Show plan/conflicts/choices/capacity; store token/expected only when executable. |
| Matching execute/grant/remove | `MutationResult<T>` | Submit the same input plus token/expected; record `operationId`, `auditId`, and `cache.status`. |
| revision or preview stale | `PermissionCoreError` | Reload current state and reconfirm user intent; old tokens cannot be replayed. |

Idempotency is scoped by actor and key. The same key with the same normalized request returns the committed result with `replayed: true`; different input fails with `IDEMPOTENCY_CONFLICT`. permission-core persists internal audit evidence and cache-result reconciliation, but it does not expose an unbounded audit-log browser.

## Capacity and Consistency

Treat `LIMIT_EXCEEDED`, `PREVIEW_REQUIRED`, and `ack-required` capacity conclusions as design feedback rather than retry loops. Split overly broad roles or menu grants and inspect affected-user samples or digests. For `REVISION_CONFLICT`, `READ_CONFLICT`, `PREVIEW_STALE`, and `CURSOR_STALE`, reload current state and rebuild the user's intent; never invent revisions.

## Incident Handling

1. Stop new management-change traffic when health is `down`, schema is incompatible, or the authorization truth cannot be read consistently.
2. Record public error code, details discriminator, retryability, operation ID, request ID, core namespace hash, and a tenant-safe scope reference.
3. Recover MonSQLize, MongoDB, cache dependencies, and matching application binaries; do not hand-edit permission collections.
4. Re-run health and the exact failed read or preview. If write outcome is uncertain, retry with the original idempotency key instead of submitting a new intent.
5. Resume traffic only after the required paths are consistent again. Cache `degraded` may support read-only or paused-change mode, but it must not become a blanket allow.

## Rollback and Shutdown

Application code should roll back with its resource-scheme contract and public route manifest. Schema contract mismatch intentionally prevents an old binary from interpreting new authorization state. If data has already been committed under the new contract, prefer forward repair over forcing an old process to run.

Stop new requests first, wait for `pc.close()`, then close the host-owned MonSQLize instance. `close()` waits `1000..300000` ms for permission operations and borrowed transactions, defaulting to `30000`; timeout returns `CORE_CLOSE_TIMEOUT` and must be visible to the process manager.

`pc.close()` resolves `void` on success. It does not return health and does not close MonSQLize; timeout error `details` include timeout, active leases, and borrowed transaction counts. Only call host `msq.close()` after permission-core has closed.

Continue with [Troubleshooting](/guide/troubleshooting).
