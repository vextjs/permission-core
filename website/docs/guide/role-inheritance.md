# Role Inheritance

Each role may have one direct parent. A child inherits the active parent chain, while keeping its own rules and menu grants identifiable. This single-parent model makes effective permissions deterministic and reviewable.

## Create a parent and child

```ts
await scoped.roles.create({
  id: 'order-base',
  label: 'Order base',
});
await scoped.roles.allow('order-base', {
  action: 'read',
  resource: 'db:orders',
});

await scoped.roles.create({
  id: 'order-operator',
  label: 'Order operator',
  parentId: 'order-base',
});
await scoped.roles.allow('order-operator', {
  action: 'invoke',
  resource: 'api:POST:/api/orders/export',
});
```

Binding a user to `order-operator` makes the child direct and `order-base` inherited. Do not also assign the parent merely to obtain its rules.

## Read own and effective state

```ts
const own = await scoped.roles.getOwnRules('order-operator');
const effective = await scoped.roles.getEffectiveRules('order-operator');
const chain = await scoped.roles.getChain('order-operator');
```

```json
{
  "own": [
    { "effect": "allow", "resource": "api:POST:/api/orders/export" }
  ],
  "effective": [
    { "resource": "api:POST:/api/orders/export", "sourceRoleId": "order-operator", "inherited": false, "depth": 0 },
    { "resource": "db:orders", "sourceRoleId": "order-base", "inherited": true, "depth": 1 }
  ],
  "chain": [
    { "role": { "id": "order-operator" }, "depth": 0, "included": true },
    { "role": { "id": "order-base" }, "depth": 1, "included": true }
  ]
}
```

`getOwnRules` never flattens the parent. `getEffectiveRules` includes source role, inherited flag, depth, conflicts, and bounded provenance. `getChain` includes disabled or deprecated entries with an exclusion reason so an admin can explain why inherited access disappeared.

## Conflict resolution

Rules from all included roles are evaluated together. An applicable deny wins over any allow, regardless of whether either rule is direct or inherited.

```ts
await scoped.roles.deny('order-operator', {
  action: 'read',
  resource: 'db:orders:field:secret',
});
```

The child still inherits collection read from `order-base`, but the secret field remains denied. A child allow cannot override a matching parent deny; change the parent policy deliberately instead of relying on hierarchy position.

## Change parent or status safely

Parent and status changes can affect every descendant and bound user. Use preview plus execute:

```ts
const preview = await scoped.roles.previewAccessUpdate(
  'order-operator',
  { parentId: 'order-supervisor' },
);
if (!preview.executable) throw new Error('Resolve impact conflicts');
await scoped.roles.executeAccessUpdate(
  'order-operator',
  { parentId: 'order-supervisor' },
  { ...preview.expected, previewToken: preview.previewToken },
);
```

The preview reports descendants, directly bound users, affected users, capacity direction, and required acknowledgement. `CIRCULAR_INHERITANCE` prevents cycles. The chain depth limit is 32; a user can have at most 128 direct roles, with bounded effective-role and effective-rule snapshots.

## Parent changes, removal, and cache

Changing a parent's rules or status immediately changes every active descendant after the transaction commits. Semantic cache invalidation targets the parent, descendants, and affected subjects; callers should not manually flush an unrelated cache.

Before removal, call `getRemovalImpact(roleId)`. A role with children or bound users is not removable until those dependencies are explicitly handled. Removing a parent never reparents children silently. Menu grants follow the same inheritance chain and retain source role IDs in effective reads.

## User-facing model

Show three separate views in an admin system:

1. direct user roles (`userRoles.getDirect`)
2. effective user roles with inheritance paths (`userRoles.getEffective`)
3. a role's own versus effective rules and menu grants

This prevents an inherited permission from looking like a direct assignment. Continue with [Roles API](/api/roles) and [User Roles API](/api/user-roles) for all signatures.
