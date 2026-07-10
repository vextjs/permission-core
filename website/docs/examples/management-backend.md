# Management Backend Example

Management backends usually save a complete role or user-role state.

## Load a role editor

```typescript
const inspection = await pc.roles.inspect(roleId);
const authorizationTree = await menu.getAuthorizationTree(scope, roleId);
const diagnostics = await menu.validate(scope);
```

Return own rules, inherited effective rules, `sourceRoleIds`, current revision, and blocking diagnostics so the UI can explain rather than flatten inheritance.

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

## Save menu authorization

```typescript
const audit = await menu.saveRoleAuthorization(scope, roleId, {
  allow: input.allow,
  deny: input.deny,
  revoke: input.revoke,
  actorId: req.user.id,
  reason: input.reason,
});
```

This path validates assets, rejects same-request allow/deny conflicts, records a stable diff, and attempts to restore the previous rules if persistence or audit append fails. Return the new audit/revision evidence to the management UI.

## Refresh after save

After a successful save, reload `roles.inspect()`, the authorization tree, and the affected subject's visible menu/button snapshots. Public managers already invalidate permission caches; direct adapter writes require explicit invalidation and are not recommended for ordinary admin endpoints.

Use optimistic revision checks in your backend when multiple administrators may edit the same role. Record actor, reason, request ID, old/new revision, and error/compensation state.
