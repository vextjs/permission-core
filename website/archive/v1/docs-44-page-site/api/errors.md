# Error Codes

permission-core exposes a stable error class and enum for authorization, validation, lifecycle, and storage failures.

## Purpose and import

```typescript
import {
  PermissionCoreError,
  PermissionCoreErrorCode,
  isPermissionCoreError,
} from 'permission-core';
```

Use the stable code for application mapping and keep internal causes in logs rather than public responses.

## Construction and types

`new PermissionCoreError(code, message, data?)` extends `Error` and exposes readonly `code` and optional `data`. `isPermissionCoreError(value)` is the public type guard.

`PermissionCoreErrorCode` contains nine string values: permission denied, missing/duplicate role, circular inheritance, invalid resource/action/argument, storage error, and not initialized.

## Signature index

| API | Signature |
|---|---|
| Error | `PermissionCoreError(code, message, data?)` |
| Type guard | `isPermissionCoreError(value): value is PermissionCoreError` |
| Enum | `PermissionCoreErrorCode` |

Stable codes are `PERMISSION_DENIED`, `ROLE_NOT_FOUND`, `ROLE_ALREADY_EXISTS`, `CIRCULAR_INHERITANCE`, `INVALID_RESOURCE_PATH`, `INVALID_ACTION`, `INVALID_ARGUMENT`, `STORAGE_ERROR`, and `NOT_INITIALIZED`.

## Behavior and defaults

Core assertions use `PERMISSION_DENIED`; managers use role/conflict codes; validators use invalid-input codes; adapters wrap persistence failures as `STORAGE_ERROR`. Calls before runtime readiness use `NOT_INITIALIZED`.

Authentication failure is normally produced by the application. The Vext boundary maps it to `AUTH_REQUIRED`, while Vext route denial becomes `AUTH_FORBIDDEN`.

## Errors and limits

Do not convert every unknown error to `403`; doing so hides storage and lifecycle failures. Public APIs should preserve a stable application code and request ID without exposing rule contents, stack traces, connection strings, or private payloads.

The enum is not an HTTP mapping. Applications choose status codes and localized messages. Tests should prove that expected codes are mapped and unknown failures are rethrown.

## Minimal example

```typescript
try {
  await pc.assert(userId, 'invoke', resource);
} catch (error) {
  if (isPermissionCoreError(error) && error.code === PermissionCoreErrorCode.PERMISSION_DENIED) {
    return reply.status(403).send({ code: error.code });
  }
  throw error;
}
```

## Related

See [Error Response Mapping](/guide/error-response-mapping), [PermissionCore](/api/permission-core), and [vext Adapter API](/api/vext-adapter).
