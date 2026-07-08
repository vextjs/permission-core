# Management Backend Example

Management backends usually save a complete role or user-role state.

## Replace user roles

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
await pc.invalidate('u-1');
```

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

await pc.invalidateAll();
```

Keep validation, deduplication, and cache invalidation in the backend, not only in the browser.
