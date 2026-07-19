# Match Resource

## Purpose and preconditions

`permission-core/match` exposes the built-in resource matcher without constructing a core. Use it in configuration tooling or tests that need exactly the same built-in HTTP/API/data/UI pattern semantics. It does not evaluate actions, roles, deny precedence, conditions, or custom resource schemes.

## Signatures

```ts
import { matchResource } from 'permission-core/match';

matchResource(pattern: string, resource: string): boolean
```

The first argument is a rule-side pattern; the second is a concrete request resource. Reversing them changes the meaning.

## Responses and side effects

The function is synchronous, pure, and returns only `true` or `false`. Invalid or mixed-scheme input returns `false`; it does not throw and does not normalize caller state.

```json
{
  "http": true,
  "api": true,
  "field": true,
  "invalid": false
}
```

HTTP/API `*` is a trailing segment wildcard that requires at least one remaining segment. `:param` consumes one segment. Data field patterns support exact paths, `profile.*`, and field-wide `*`. The rule-side global `*` matches any valid built-in concrete resource.

## Failures and limits

Custom schemes configured on `PermissionCore` are intentionally unavailable from this standalone function; use a core decision for them. Query strings/fragments, malformed templates, concrete wildcards, unknown schemes, and resources longer than the built-in grammar accepts return `false`. `matchResource` does not implement action-side `write` semantics.

## Example

```ts
const result = {
  exact: matchResource('GET:/orders/:id', 'GET:/orders/42'),
  subtree: matchResource('api:POST:/api/orders/*', 'api:POST:/api/orders/export'),
  field: matchResource('db:orders:field:profile.*', 'db:orders:field:profile.name'),
  tooShort: matchResource('GET:/orders/*', 'GET:/orders'),
};
```

```json
{ "exact": true, "subtree": true, "field": true, "tooShort": false }
```

## Related

See [Resources and Rules](/guide/resources-and-rules), [Resource Schemes](/api/resource-schemes), and [Check Permissions](/guide/check-permission).
