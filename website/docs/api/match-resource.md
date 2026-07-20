# Match Resource
<!-- docs:inline-parity `permission-core/match` `matchResource(pattern, resource)` `pattern` `GET:/orders/:id` `resource` `GET:/orders/42` `can/assert` `boolean` `true` `false` `matchResource()` `*` `:param` `profile.*` `PermissionCore` `matchResource` `write` -->

`matchResource` exposes the same resource matcher outside a `PermissionCore` instance for tests, diagnostics, or custom integration checks.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want To Do

| Goal | Entry point |
|---|---|
| Verify resource patterns in tests | [`matchResource(pattern, resource)`](#match-resource) |
| Reproduce the string matching part of `can/assert` | Pass the same action/resource resource string |
| Understand `*`, `:param`, and field wildcards | [Example](#example) |
| Decide whether a custom resource scheme is needed | [Resource Schemes API](/api/resource-schemes) |

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
import { matchResource } from 'permission-core/match';

matchResource(pattern: string, resource: string): boolean
```
## Method Details

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

<span id="match-resource"></span>
### `matchResource(pattern, resource)`
<!-- docs:method name=matchResource locale=en -->

- **Purpose**: Use `matchResource` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `boolean` or the documented matcher result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<!-- docs:params owner=matchResource locale=en -->
## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "http": true,
  "api": true,
  "field": true,
  "invalid": false
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

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

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Vext Plugin API](/api/vext-plugin).
