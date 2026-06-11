# Error Codes

permission-core exposes stable error semantics for common runtime failures.

## Common errors

| Situation | Meaning |
|-----------|---------|
| Runtime not initialized | Public APIs were called before `await pc.init()` |
| Permission denied | The user does not have the required permission |
| Invalid input | The action, resource, role, or rule payload is invalid |
| Storage failure | The storage adapter failed during a runtime operation |

## Application mapping

Map runtime errors to your own API response format. A typical service maps permission denial to HTTP `403` and anonymous requests to HTTP `401`.

## Production boundary

Do not return stack traces, connection strings, internal storage errors, or private payment payloads in public responses.
