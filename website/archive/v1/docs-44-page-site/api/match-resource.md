# matchResource

`matchResource` checks whether one built-in resource pattern covers a target resource.

## Purpose and import

```typescript
import { matchResource } from 'permission-core/match';
```

Use it in tests, diagnostics, and tooling. Runtime authorization should normally use `PermissionCore.can()` or `assert()` so deny and role semantics are included.

## Construction and types

There is no constructor or options object. Both arguments are resource strings and the result is a boolean.

The helper covers built-in HTTP, `api:`, `db:`, namespaced UI resources, and the global `*` pattern.

## Signature index

`matchResource(pattern: string, resource: string): boolean`

The public subpath exports the standalone resource matcher. Core rule evaluation also matches action through its internal rule matcher.

## Behavior and defaults

Matching is scheme-aware. HTTP method must match unless the pattern uses `*`; `:param` covers one path segment; trailing `*` covers descendants. `db:orders:*` covers fields in `orders` but not another collection.

The global `*` covers every resource. A wildcard in one scheme never crosses into another scheme: `db:*` does not match `api:GET:/orders`.

## Errors and limits

The helper returns false for incompatible/malformed built-in shapes rather than performing full role validation. Built-in wildcard matching is suffix-oriented; `GET:/api/*/items` is not a generic middle-segment glob.

Custom schemes registered on `pc.resourceSchemes` use that registry during core checks. This standalone helper does not receive a registry and must not be used to bypass custom validation or final authorization.

## Minimal example

```typescript
matchResource('GET:/api/*', 'GET:/api/orders'); // true
matchResource('GET:/api/*', 'POST:/api/orders'); // false
matchResource('db:orders:*', 'db:orders:amount'); // true
```

## Related

See [Resource Paths](/guide/resource-paths), [PermissionCore](/api/permission-core), and [Permission Checks](/guide/check-permission).
