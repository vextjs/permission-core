# Errors

## Purpose and preconditions

All domain failures use `PermissionCoreError`, exported from `permission-core`. Branch on `code` and `details.kind`, not message text. A boolean denial from `can()` is not an exception; `assert()` turns the same denial into `PERMISSION_DENIED`.

## Signatures

```ts
class PermissionCoreError extends Error {
  readonly code: PermissionCoreErrorCode;
  readonly details?: PermissionCoreErrorDetails;
  readonly retryable: boolean;
  readonly committed?: boolean;
  readonly operationId?: string;
}
```

Detail discriminators are `validation`, `limit-exceeded`, `data-value-unsupported`, `close-timeout`, `revision-conflict`, `read-conflict`, `preview-stale`, `cursor-stale`, `preview-required`, `capacity-risk-ack-required`, `persisted-state-invalid`, `unexpected-post-image-field`, `schema-version-mismatch`, `schema-contract-mismatch`, `database-failure`, `audit-lookup`, and `reconcile-superseded`.

## Responses and side effects

The Vext plugin maps errors to this public JSON shape and preserves request/operation correlation:

```json
{
  "code": "PERMISSION_DENIED",
  "message": "The subject is not allowed to invoke this route.",
  "retryable": false,
  "requestId": "req-42"
}
```

For status `500`, the plugin replaces the public message with `Internal Server Error`. `details`, `committed`, and `operationId` are included only when available.

## Failures and limits

| Vext status | Codes |
|---|---|
| 400 | `INVALID_ARGUMENT`, `INVALID_ACTION`, `INVALID_RESOURCE`, `INVALID_FILTER`, `INVALID_POLICY`, `POLICY_CONTEXT_MISSING`, `INVALID_CURSOR`, `MENU_HIERARCHY_INVALID`, `DATA_OPERATION_UNSUPPORTED`, `DATA_BULK_SCOPE_MUTATION_UNSAFE`; caller-input `LIMIT_EXCEEDED`/`DATA_VALUE_UNSUPPORTED` |
| 401 | `VEXT_AUTH_REQUIRED`, `INVALID_SUBJECT`, `SCOPE_CONFLICT` |
| 403 | `PERMISSION_DENIED`, `FIELD_PERMISSION_DENIED` |
| 404 | `ROLE_NOT_FOUND`, `MENU_NOT_FOUND`, `API_BINDING_NOT_FOUND`, `AUDIT_ENTRY_NOT_FOUND` |
| 409 | `REVISION_CONFLICT`, `CURSOR_STALE`, `IDEMPOTENCY_CONFLICT`, `PREVIEW_REQUIRED`, `PREVIEW_STALE`, `ROLE_ALREADY_EXISTS`, `ROLE_IN_USE`, `CIRCULAR_INHERITANCE`, `MENU_ALREADY_EXISTS`, `DEPENDENCY_EXISTS`, `API_BINDING_ALREADY_EXISTS`, `STALE_REFERENCE` |
| 503 | `NOT_INITIALIZED`, `CORE_CLOSED`, `CORE_CLOSE_TIMEOUT`, `SCHEMA_VERSION_MISMATCH`, `SCHEMA_CONTRACT_MISMATCH`, `PERSISTED_STATE_INVALID`, `DATABASE_UNAVAILABLE`, `READ_CONFLICT`, `VEXT_ROUTE_RESTART_REQUIRED`; persisted/budget `LIMIT_EXCEEDED`/`DATA_VALUE_UNSUPPORTED`; retryable `DATABASE_ERROR`/`TRANSACTION_FAILED` |
| 500 | `INVALID_CONFIGURATION`, `MONSQLIZE_CONTRACT_UNSUPPORTED`, `SCOPE_FIELD_MAPPING_REQUIRED`, `VEXT_MONSQLIZE_REQUIRED`, `VEXT_MONSQLIZE_INCOMPATIBLE`, `VEXT_APP_EXTENSION_CONFLICT`, `VEXT_AUTH_EXTENSION_CONFLICT`, `VEXT_ROUTE_PERMISSION_INVALID`, `INDEX_CONFLICT`; non-retryable `DATABASE_ERROR`/`TRANSACTION_FAILED` |

Do not retry solely from the status. Re-read on revision/preview/cursor conflicts; repair configuration/schema/persisted state; use the same idempotency key for uncertain writes. `committed: true` means the state change happened even if a later operational step failed.

## Example

```ts
import { PermissionCoreError } from 'permission-core';

try {
  await subject.assert('delete', 'db:orders');
} catch (error) {
  if (error instanceof PermissionCoreError && error.code === 'PERMISSION_DENIED') {
    return { status: 403, code: error.code };
  }
  throw error;
}
```

```json
{ "status": 403, "code": "PERMISSION_DENIED" }
```

## Related

See [Troubleshooting](/guide/troubleshooting), [Production Operations](/guide/production-operations), and [Vext Plugin API](/api/vext-plugin).
