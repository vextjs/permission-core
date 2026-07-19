# Production Operations

Production readiness depends on a healthy host-owned MonSQLize 3.1 connection, compatible permission schema, bounded authorization state, durable mutation evidence, and a clean shutdown order. A process being reachable is not enough; gate readiness on `PermissionCore.health()`.

## Preconditions

- Use a MongoDB deployment that supports transactions and the MonSQLize 3.1 capabilities probed by `init()`.
- Give every instance the same collection prefix, resource-scheme definitions/versions, scope model, cache policy, and configured token secret.
- Run one `init()` before accepting permission traffic and retain its failure as a startup failure.
- Supply `actorId`, `reason`, `requestId`, and an operation-specific `idempotencyKey` for administrative writes where replay is possible.

## Readiness checklist

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

`down` means the core is not ready or the database is unavailable. `degraded` means the database is up but schema mismatches, cache incidents, or pending cache outcomes require action. The bounded counts can be truncated; zero is conclusive, while a capped non-zero count is not a complete inventory.

## Mutation and audit controls

Use preview/execute for destructive, structural, replacement, and high-impact changes. Execute with the exact `previewToken` and `expectedRevisions` returned by preview; acknowledge capacity risk only after reviewing the assessment. A committed response returns `operationId`, `auditId`, revision vector, replay status, cache outcome, and warnings.

Idempotency is scoped to the actor and key. Reusing the same key with the same normalized request returns the committed result with `replayed: true`; different input fails with `IDEMPOTENCY_CONFLICT`. permission-core maintains durable internal audit evidence and cache-outcome reconciliation, but it does not expose an unrestricted public audit-log browser. Persist returned IDs in the host's business/audit log for correlation.

## Capacity and consistency

Treat `LIMIT_EXCEEDED`, `PREVIEW_REQUIRED`, and an `ack-required` capacity disposition as design feedback, not retry loops. Split overly broad roles or menu grants and review affected-user samples/digests. Handle `REVISION_CONFLICT`, `READ_CONFLICT`, `PREVIEW_STALE`, and `CURSOR_STALE` by re-reading current state and rebuilding the user's intent; never manufacture revisions.

## Failure runbook

1. Stop new administrative mutation traffic when health is `down`, schema state is incompatible, or authorization truth cannot be read consistently.
2. Record the public error code, details discriminator, retryable flag, operation ID, request ID, core namespace hash, and tenant-safe scope correlation.
3. Restore MonSQLize/database/cache dependencies and the matching application version; do not edit permission collections by hand.
4. Re-run health and the exact failed read/preview. For uncertain writes, use the original idempotency key before submitting any new intent.
5. Resume traffic only when the required path is coherent; `degraded` cache state may justify read-only or change-free operation, not a blanket allow.

## Rollback and shutdown

Roll back application code together with its resource-scheme contract and public route manifest. A schema contract mismatch deliberately prevents an older binary from interpreting newer authorization state. Use a forward repair when data is already committed under a newer contract rather than forcing the old process to run.

On shutdown, stop new requests, await `pc.close()`, then close the host-owned MonSQLize instance. `close()` waits `1000..300000` ms (default `30000`) for permission operations and borrowed transactions; timeout is `CORE_CLOSE_TIMEOUT` and must remain visible to the process supervisor.

Use [Troubleshooting](/guide/troubleshooting) for symptom-oriented recovery and [Errors](/api/errors) for HTTP mapping guidance.
