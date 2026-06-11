# Error Response Mapping

Map permission-core errors to stable application responses. Keep raw runtime errors out of public API responses.

## Common mapping

| Condition | Suggested status | Suggested code |
|-----------|------------------|----------------|
| No login identity | `401` | `UNAUTHENTICATED` |
| Permission denied | `403` | `PERMISSION_DENIED` |
| Invalid permission input | `400` | `INVALID_PERMISSION_INPUT` |
| Runtime not initialized | `500` | `PERMISSION_RUNTIME_NOT_READY` |

## Example

```typescript
try {
  await pc.assert(userId, 'invoke', 'POST:/api/refunds');
} catch (error) {
  return res.status(403).json({
    code: 'PERMISSION_DENIED',
    message: 'You do not have permission to perform this action.',
  });
}
```

## Logging

Log enough context to debug:

- stable user id
- action
- resource
- request id
- service name

Do not log secrets, tokens, full payment credentials, connection strings, or raw private payloads unless your project policy explicitly allows it.
