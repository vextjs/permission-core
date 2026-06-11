# Management Console

Management consoles usually edit roles, role rules, user-role bindings, and cache invalidation together. Keep that workflow explicit.

## Role detail page

Use these APIs:

1. `roles.get()` / `roles.update()` for role metadata.
2. `roles.getRules()` for the role's own rules.
3. `roles.inspect()` for effective rules and inheritance.
4. `roles.delete()` for role removal.

`getRules()` returns only the role's own rules. Use `inspect()` when the UI needs the final inherited result.

## Save role rules

Before saving from a UI:

- validate every `action`
- validate every `resource`
- deduplicate by `type + action + resource + where`
- keep `allow` and `deny` visible when both exist
- invalidate affected users or all permissions after rule changes

## User-role bindings

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
await pc.invalidate('u-1');
```

Use `setUserRoles()` for full replacement saves from an admin form. Use `grant()` and `revoke()` for small targeted changes.

## Error mapping

Return clear errors to the frontend. Do not expose secrets, connection strings, raw database errors, or stack traces in production responses.

## Next step

See [Management Backend Example](/examples/management-backend) and [Error Response Mapping](/guide/error-response-mapping).
