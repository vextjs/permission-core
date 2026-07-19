# Error Response Mapping

Map permission-core errors to stable application responses. Keep raw runtime errors out of public API responses.

## Common mapping

| Condition | Suggested status | Suggested code |
|-----------|------------------|----------------|
| No login identity | `401` | `UNAUTHENTICATED` |
| Permission denied | `403` | `PERMISSION_DENIED` |
| Invalid permission input | `400` | `INVALID_PERMISSION_INPUT` |
| Runtime not initialized | `500` | `PERMISSION_RUNTIME_NOT_READY` |
| Missing role | `404` | `ROLE_NOT_FOUND` |
| Duplicate role | `409` | `ROLE_ALREADY_EXISTS` |
| Circular inheritance / conflicting revision | `409` | stable domain conflict code |
| Storage or compensation failure | `503` or `500` | `PERMISSION_STORAGE_ERROR` |

Authentication and authorization are separate. A missing/invalid login becomes `401`; an authenticated subject that fails authorization becomes `403`.

## Example

```typescript
try {
  await pc.assert(userId, 'invoke', 'POST:/api/refunds');
} catch (error) {
  if (error instanceof PermissionCoreError && error.code === 'PERMISSION_DENIED') {
    return res.status(403).json({
      code: error.code,
      message: 'You do not have permission to perform this action.',
      requestId: req.id,
    });
  }
  throw error;
}
```

Do not catch every error and return `403`; that hides invalid resources, unavailable storage, and lifecycle defects as user denials.

## Stable response shape

```json
{
  "code": "PERMISSION_DENIED",
  "message": "You do not have permission to perform this action.",
  "requestId": "req-123"
}
```

Keep `code` stable for clients and localize `message` at the application boundary. Management APIs may include field-level validation details, but public route guards should not expose rule contents or storage causes.

## Logging

Log enough context to debug:

- stable user id
- action
- resource
- request id
- service name

Do not log secrets, tokens, full payment credentials, connection strings, or raw private payloads unless your project policy explicitly allows it.

Include the tenant/app scope, matched route template, decision layer, and stable error code when available. For `STORAGE_ERROR`, log original and compensation causes internally with the same request/change ID.

The Vext adapter maps unauthenticated protected routes to `401 AUTH_REQUIRED` and denied route permission groups to `403 AUTH_FORBIDDEN`. Keep the adapter response contract stable even if the core error behind a direct `req.auth.assert` is `PERMISSION_DENIED`.

Frontends may use menu/button state to explain unavailable actions, but they must still handle `401/403/409` because server state can change after rendering.
