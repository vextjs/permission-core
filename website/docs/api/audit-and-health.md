# Audit and Health

## Purpose and preconditions

The public operations surface consists of `init()`/`health()` plus audit and revision evidence returned by management mutations. permission-core writes durable internal audit rows transactionally, but intentionally does not expose a general-purpose public audit-log query manager.

## Signatures

```ts
pc.init(): Promise<PermissionCoreHealth>
pc.health(): Promise<PermissionCoreHealth>

interface MutationResult<T> {
  committed: true;
  changed: boolean;
  data: T;
  revision: number;
  revisions: RevisionVector;
  operationId: string;
  auditId: string;
  replayed: boolean;
  cache: { status: 'not-needed' | 'completed' | 'bypassed' | 'degraded'; reason?: string };
  warnings: BoundedDetails<ManagementWarning>;
  detailBudget: ResponseDetailBudget;
}
```

Management options can include `actorId`, `reason`, `requestId`, and `idempotencyKey`. These values become bounded correlation evidence; they do not authorize the mutation.

## Responses and side effects

`PermissionCoreHealth` reports lifecycle/database/schema/token/cache/audit state and a namespace hash. `status: 'degraded'` means the database is available but a schema mismatch, cache incident, or pending cache outcome needs attention. Mutation audit evidence is committed with the state change; post-commit cache outcome may subsequently be completed, bypassed, or reconciled.

```json
{
  "status": "degraded",
  "lifecycle": "ready",
  "database": { "status": "up" },
  "cache": {
    "permissionLayer": "enabled",
    "invalidationIncidentActive": true,
    "invalidationFailures": 1,
    "invalidationRiskUntil": 1780000000000
  },
  "audit": {
    "pendingCacheOutcomes": { "value": 1, "cap": 1000, "truncated": false }
  }
}
```

## Failures and limits

Health counts are bounded to `1000`; `truncated: true` means the exact total is larger. Health may return `down` instead of throwing for an unavailable database, while malformed configuration or failed initialization is also retained in `lastInitError`. Audit IDs are correlation handles, not a supported public lookup API. Do not read internal permission collections directly as an application contract.

## Example

```ts
const result = await scoped.roles.create(
  { id: 'operator', label: 'Operator' },
  { actorId: 'admin-7', reason: 'Initial setup', requestId: 'req-42', idempotencyKey: 'role:operator:v1' },
);
businessAudit.info({ operationId: result.operationId, auditId: result.auditId });
```

```json
{
  "committed": true,
  "operationId": "operation_...",
  "auditId": "audit_...",
  "replayed": false,
  "cache": { "status": "completed" }
}
```

## Related

See [Production Operations](/guide/production-operations), [Cache](/guide/cache), and [Errors](/api/errors).
