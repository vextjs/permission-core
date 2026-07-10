# Error Codes

permission-core exposes stable error semantics for common runtime failures.

## Common errors

| Code | Meaning | Typical layer |
|---|---|---|
| `NOT_INITIALIZED` | Runtime, menu manager, or adapter is not ready or was closed | Startup/lifecycle |
| `PERMISSION_DENIED` | The resolved rules deny the requested operation | Runtime guard |
| `ROLE_NOT_FOUND` | A role read, assignment, or authorization save targets a missing role | Management API |
| `ROLE_ALREADY_EXISTS` | Role creation reused an existing ID | Management API |
| `CIRCULAR_INHERITANCE` | A parent update would create an inheritance cycle | Management API |
| `INVALID_RESOURCE_PATH` | Resource syntax or a registered scheme validator rejected the value | Validation |
| `INVALID_ACTION` | Action is empty or unsupported by the call contract | Validation |
| `INVALID_ARGUMENT` | Scope, manifest, rule, identity, or option values conflict or are incomplete | Validation/integration |
| `STORAGE_ERROR` | Storage read/write, audit append, or compensation failed | Persistence |

## Application mapping

Map runtime errors to your own API response format. A typical service maps permission denial to HTTP `403` and anonymous requests to HTTP `401`.

```typescript
try {
  await pc.assertSubject(subject, 'invoke', resource);
} catch (error) {
  if (error instanceof PermissionCoreError && error.code === 'PERMISSION_DENIED') {
    return reply.status(403).send({ code: error.code, message: 'Forbidden' });
  }
  throw error;
}
```

Authentication failure is normally produced by your authentication layer, not by the core. The Vext route guard maps missing authentication to `401 AUTH_REQUIRED` and authorization denial to `403 AUTH_FORBIDDEN` at the adapter boundary.

## Production boundary

Do not return stack traces, connection strings, internal storage errors, or private payment payloads in public responses.

Management endpoints should preserve the stable error `code` while translating the message for users. Log storage/compensation causes with a correlation ID, then return a generic public response. Tests should cover every code your API maps and prove that unknown errors are rethrown instead of being converted to permission denial.
