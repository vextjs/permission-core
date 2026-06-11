# RoleManager

`RoleManager` manages roles, role rules, inheritance, and inspection APIs.

## Create and update roles

```typescript
await pc.roles.create('support', { label: 'Support' });
await pc.roles.update('support', { label: 'Support Team' });
const role = await pc.roles.get('support');
```

## Add rules

```typescript
await pc.roles.allow('support', 'invoke', 'GET:/api/refunds');
await pc.roles.allow('support', 'read', 'db:refunds');
await pc.roles.deny('support', 'invoke', 'POST:/api/payouts');
```

## Row rule

```typescript
await pc.roles.allow('merchant-auditor', 'read', 'db:transactions', {
  field: 'merchantId',
  op: 'eq',
  valueFrom: 'merchantId',
});
```

## Remove rules

```typescript
await pc.roles.revokeRule('support', 'invoke', 'GET:/api/refunds');
await pc.roles.clearRules('support');
```

## Inheritance

```typescript
await pc.roles.setParent('finance-admin', 'finance-ops');
const chain = await pc.roles.getRoleChain('finance-admin');
const effectiveRules = await pc.roles.getEffectiveRules('finance-admin');
```

## Inspect a role

```typescript
const inspection = await pc.roles.inspect('finance-admin');
```

`inspect()` returns role metadata, own rules, effective rules, and the inherited role chain. It is the recommended API for role detail pages.

## Management UI boundary

Treat identical `type + action + resource + where` as duplicate input before save. `allow` and `deny` can both exist for the same `action + resource`; runtime checks still apply deny-first semantics.
