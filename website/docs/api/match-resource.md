# matchResource

`matchResource` checks whether a resource pattern matches a target resource.

## Example

```typescript
import { matchResource } from 'permission-core/match';

matchResource('GET:/api/orders', 'GET:/api/orders'); // true
matchResource('GET:/api/*', 'GET:/api/orders'); // true
matchResource('*', 'POST:/api/refunds'); // true
```

## Use cases

- tests for permission rules
- diagnostics for wildcard behavior
- custom tooling around resource patterns

Runtime permission decisions should usually go through `PermissionCore.can()` or `PermissionCore.assert()`.
