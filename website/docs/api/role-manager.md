# RoleManager

`RoleManager` manages roles, role rules, inheritance, and inspection APIs.

It is the public management surface for role rules. Keep low-level storage adapter methods behind your own infrastructure code; application code should normally go through `pc.roles`.

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
  where: {
    field: 'merchantId',
    op: 'eq',
    valueFrom: 'merchantId',
  },
});
```

## Remove rules

```typescript
await pc.roles.revokeRule('support', 'invoke', 'GET:/api/refunds');
await pc.roles.clearRules('support');
```

## Rule API boundary

`allow()` and `deny()` accept `actions: string | string[]`. The array form only expands several actions for the same resource; it is not a general multi-resource or multi-rule batch API.

permission-core v1 does not expose a public API that overwrites or appends arbitrary role-rule arrays in one call. Role-rule writes can affect users directly assigned to a role, users that inherit it through child roles, and cached permission sets for many users. For that reason, rule changes stay behind explicit `RoleManager` methods that validate input, deduplicate rules, preserve deny-first semantics, and invalidate the permission-rule cache.

For admin forms that edit many rules at once, keep the rule array in your own backend service. Validate and deduplicate the submitted rules, decide whether to clear-and-rebuild or compute a diff, then call `allow()`, `deny()`, `revokeRule()`, or `clearRules()`. Do not treat `StorageAdapter.setRules()` as a business batch API; calling it directly bypasses `RoleManager` validation and cache invalidation.

## Inheritance

```typescript
await pc.roles.create('finance-admin', {
  label: 'Finance Admin',
  parent: 'finance-ops',
});
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

Public `RoleManager` write methods already invalidate the relevant permission cache. Only plan manual `invalidateAll()` calls when you intentionally bypass `RoleManager`, write through a storage adapter directly, or synchronize rules from an external system.
