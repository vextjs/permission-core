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

## Matching rules

| Pattern | Target | Result | Reason |
|---|---|---:|---|
| `*` | `api:POST:/api/refunds` | true | Global wildcard |
| `GET:/api/*` | `GET:/api/orders` | true | Same scheme/method and trailing wildcard |
| `GET:/api/*` | `POST:/api/orders` | false | HTTP method differs |
| `db:orders:*` | `db:orders:amount` | true | Same resource hierarchy |
| `db:*` | `api:GET:/orders` | false | Wildcards do not cross resource schemes |
| `GET:/api/*/items` | `GET:/api/orders/items` | false | Built-in wildcard is suffix-oriented, not a middle-segment glob |

The matcher is scheme-aware. A custom scheme registered through `pc.resourceSchemes.register()` uses its own `validate` and `match` functions inside core checks, role writes, menu validation, and authorization trees. The standalone `permission-core/match` helper covers built-in matching; applications should not use it to bypass a custom registry.

## Common mistakes

- Matching a concrete URL with query strings instead of the normalized route template.
- Assuming an HTTP wildcard can authorize `db:` or `ui:` resources.
- Using resource-list matching as the final decision instead of `can()`/`assert()` with deny priority.
- Treating `*` as an arbitrary regular expression.
