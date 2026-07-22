# Audit and Health
<!-- docs:inline-parity `init()` `health()` `actorId` `reason` `requestId` `idempotencyKey` `pc.init()` `Promise<PermissionCoreHealth>` `data` `lastInitError` `pc.health()` `status` `status/lifecycle/initialized` `up` `degraded` `down` `namespace` `database` `unknown` `schema` `truncated` `tokens` `cache` `backendState='opaque'` `audit.pendingCacheOutcomes` `PermissionCoreHealth` `status: 'degraded'` `committed` `operationId` `1000` `truncated: true` `roles.create()` `MutationResult<Role>` `result.data` `operationId/auditId` `replayed` `true` `cache.status` `committed/changed` -->

`init()` and `health()` expose the readiness evidence that operators need before accepting permission traffic or diagnosing degraded state.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want To Do

| Goal | Entry point |
|---|---|
| Initialize or check whether the core is usable | [`pc.init()`](#audit-init), [`pc.health()`](#audit-health) |
| Check whether tokens and cursors are stable across instances | Read `health.tokens` |
| Correlate audit evidence for a management write | Read `operationId`, `auditId`, and `revisions` from mutation results |
| Handle degraded or down state | [Failures and limits](#failures-and-limits) |

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

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
## Method and Field Details

The methods below are the public health and audit surface. They are intentionally small so operators can use them from readiness probes and incident tooling.

<span id="audit-init"></span>
### `pc.init()`
<!-- docs:method name=init locale=en -->

- **Purpose**: Use `init` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="audit-health"></span>
### `pc.health()`
<!-- docs:method name=health locale=en -->

- **Purpose**: Use `health` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<!-- docs:params owner=PermissionCoreHealth locale=en -->
<!-- docs:params owner=MutationAuditOptions locale=en -->
## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

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

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
const result = await scoped.roles.create(
  { id: 'operator', label: 'Operator' },
  { actorId: 'admin-7', reason: 'Initial setup', requestId: 'req-42' },
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

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Errors](/api/errors).
