# Errors
<!-- docs:inline-parity `permission-core` `PermissionCoreError` `code` `details.kind` `can()` `assert()` `PERMISSION_DENIED` `validation` `limit-exceeded` `data-value-unsupported` `close-timeout` `revision-conflict` `read-conflict` `preview-stale` `cursor-stale` `preview-required` `capacity-risk-ack-required` `persisted-state-invalid` `unexpected-post-image-field` `schema-version-mismatch` `schema-contract-mismatch` `database-failure` `audit-lookup` `reconcile-superseded` `PermissionCoreErrorCode` `retryable` `boolean` `committed` `true` `operationId` `message` `cause` `error instanceof PermissionCoreError` `error.code/details.kind` `false` `500` `Internal Server Error` `details` `INVALID_ARGUMENT` `INVALID_ACTION` `INVALID_RESOURCE` `INVALID_FILTER` `INVALID_POLICY` `POLICY_CONTEXT_MISSING` `INVALID_CURSOR` `MENU_HIERARCHY_INVALID` `DATA_OPERATION_UNSUPPORTED` `DATA_BULK_SCOPE_MUTATION_UNSAFE` `LIMIT_EXCEEDED` `DATA_VALUE_UNSUPPORTED` `VEXT_AUTH_REQUIRED` `INVALID_SUBJECT` `SCOPE_CONFLICT` `FIELD_PERMISSION_DENIED` `ROLE_NOT_FOUND` `MENU_NOT_FOUND` `API_BINDING_NOT_FOUND` `AUDIT_ENTRY_NOT_FOUND` `REVISION_CONFLICT` `CURSOR_STALE` `IDEMPOTENCY_CONFLICT` `PREVIEW_REQUIRED` `PREVIEW_STALE` `ROLE_ALREADY_EXISTS` `ROLE_IN_USE` `CIRCULAR_INHERITANCE` `MENU_ALREADY_EXISTS` `DEPENDENCY_EXISTS` `API_BINDING_ALREADY_EXISTS` `STALE_REFERENCE` `NOT_INITIALIZED` `CORE_CLOSED` `CORE_CLOSE_TIMEOUT` `SCHEMA_VERSION_MISMATCH` `SCHEMA_CONTRACT_MISMATCH` `PERSISTED_STATE_INVALID` `DATABASE_UNAVAILABLE` `READ_CONFLICT` `VEXT_ROUTE_RESTART_REQUIRED` `DATABASE_ERROR` `TRANSACTION_FAILED` `INVALID_CONFIGURATION` `MONSQLIZE_CONTRACT_UNSUPPORTED` `SCOPE_FIELD_MAPPING_REQUIRED` `VEXT_MONSQLIZE_REQUIRED` `VEXT_MONSQLIZE_INCOMPATIBLE` `VEXT_APP_EXTENSION_CONFLICT` `VEXT_AUTH_EXTENSION_CONFLICT` `VEXT_ROUTE_PERMISSION_INVALID` `INDEX_CONFLICT` `committed: true` `subject.assert()` `void` `REVISION_CONFLICT/CURSOR_STALE/PREVIEW_STALE` `DATABASE_UNAVAILABLE/READ_CONFLICT` `retryable=true` `INVALID_*` -->

`PermissionCoreError` is the structured failure surface. Callers should branch on `code` and `details.kind`, not on localized message text.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
class PermissionCoreError extends Error {
  readonly code: PermissionCoreErrorCode;
  readonly details?: PermissionCoreErrorDetails;
  readonly retryable: boolean;
  readonly committed?: boolean;
  readonly operationId?: string;
}
```
## Error Object Details

Every error carries a stable public code and a discriminated details object. Logs and HTTP mappers should keep these structured fields.

<!-- docs:params owner=PermissionCoreError locale=en -->
<span id="permission-core-error-class"></span>
### `PermissionCoreError`
<!-- docs:method name=PermissionCoreError locale=en -->

- **Purpose**: Use `PermissionCoreError` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "code": "PERMISSION_DENIED",
  "message": "The subject is not allowed to invoke this route.",
  "retryable": false,
  "requestId": "req-42"
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

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

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Resource Schemes](/api/resource-schemes).
