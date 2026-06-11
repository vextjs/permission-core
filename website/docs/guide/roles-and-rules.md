# Roles and Rules

Roles contain permission rules. Users receive permissions through role bindings.

## Minimal role flow

```typescript
await pc.roles.create('finance-ops', { label: 'Finance Operations' });
await pc.roles.allow('finance-ops', 'invoke', 'GET:/api/refunds');
await pc.roles.allow('finance-ops', 'read', 'db:refunds');
await pc.users.setUserRoles('u-100', ['finance-ops']);
```

## Rule shape

```typescript
{
  type: 'allow',
  action: 'read',
  resource: 'db:transactions',
  where: {
    field: 'merchantId',
    op: 'eq',
    valueFrom: 'merchantId',
  },
}
```

Rules can be `allow` or `deny`. Deny rules take priority over allow rules.

## Inheritance

Child roles inherit parent role rules. Use inheritance for stable organizational roles, not for every temporary exception.

```typescript
await pc.roles.create('finance-admin');
await pc.roles.setParent('finance-admin', 'finance-ops');
```

## Inspecting effective permissions

```typescript
const chain = await pc.roles.getRoleChain('finance-admin');
const rules = await pc.roles.getEffectiveRules('finance-admin');
const inspection = await pc.roles.inspect('finance-admin');
```

`inspect()` is useful for role detail pages and debugging tools because it returns the role, own rules, effective rules, and role chain together.

## Deduplication boundary

Treat the same `type + action + resource + where` as duplicate rule input before saving from a management UI. `allow` and `deny` can still both exist for the same `action + resource`; runtime semantics remain deny-first.

## Next step

For management UI details, continue with [Management Console](/guide/site-preview-release).
