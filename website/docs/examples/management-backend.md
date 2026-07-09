# Management Backend Example

Management backends usually save a complete role or user-role state.

## Replace user roles

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
```

`setUserRoles()` invalidates that user's permission cache automatically.

## Save role rules

```typescript
const rules = dedupeByTypeActionResourceWhere(inputRules);

await pc.roles.clearRules('refund-reviewer');
for (const rule of rules) {
  if (rule.type === 'allow') {
    await pc.roles.allow('refund-reviewer', rule.action, rule.resource, {
      where: rule.where,
    });
  } else {
    await pc.roles.deny('refund-reviewer', rule.action, rule.resource, {
      where: rule.where,
    });
  }
}
```

Keep validation and deduplication in the backend, not only in the browser. `RoleManager` write methods invalidate the permission-rule cache automatically.

The clear-and-rebuild example is intentionally simple. For larger rule sets or concurrent admin users, compute a diff and call `allow()`, `deny()`, and `revokeRule()` only for the changes. Do not expose `StorageAdapter.setRules()` directly as a business batch endpoint unless you also own validation, conflict handling, and cache invalidation.
