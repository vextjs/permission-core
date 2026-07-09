# Management Console

Management consoles usually edit roles, role rules, and user-role bindings together. Public manager APIs already handle permission cache invalidation; keep manual invalidation for direct storage writes, external synchronization, or cross-instance invalidation strategy.

## Role detail page

Use these APIs:

1. `roles.get()` / `roles.update()` for role metadata.
2. `roles.getRules()` for the role's own rules.
3. `roles.inspect()` for effective rules and inheritance.
4. `roles.delete()` for role removal.

`getRules()` returns only the role's own rules. Use `inspect()` when the UI needs the final inherited result.

## Save role rules

permission-core v1 does not expose a generic role-rule batch API. `roles.allow()` and `roles.deny()` can accept several actions for the same resource, but they are still explicit rule operations, not a `setRules()` replacement.

Before saving from a UI:

- validate every `action`
- validate every `resource`
- deduplicate by `type + action + resource + where`
- keep `allow` and `deny` visible when both exist
- save through your own backend service, then call the public `RoleManager` methods

Avoid binding a browser form directly to many remote `allow()` / `deny()` calls. A backend save service can validate the submitted rule array, reject partial input, compute a diff, and avoid unnecessary cache churn. Do not call `StorageAdapter.setRules()` from business code unless you intentionally own the missing validation and invalidation behavior.

## User-role bindings

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
```

Use `setUserRoles()` for full replacement saves from an admin form. Use `assign()` and `revoke()` for small targeted changes. These methods invalidate the affected user's cache automatically.

## Error mapping

Return clear errors to the frontend. Do not expose secrets, connection strings, raw database errors, or stack traces in production responses.

## Next step

See [Management Backend Example](/examples/management-backend) and [Error Response Mapping](/guide/error-response-mapping).
