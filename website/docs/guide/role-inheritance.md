# Role Inheritance
<!-- docs:inline-parity `roles.create(input)` `id/label` `parentId` `MutationResult<Role>` `roles.allow(roleId, rule)` `action/resource` `where` `order-operator` `order-base` `own/effective/chain` `getOwnRules(roleId)` `VersionedResult<PermissionRuleView[]>` `data[]` `getEffectiveRules(roleId)` `VersionedResult<EffectiveRoleRules>` `data.rules.items` `data.conflicts` `sourceRoleId/inherited/depth` `getChain(roleId)` `VersionedResult<RoleChainEntry[]>` `role/depth/included/reason` `getOwnRules` `getEffectiveRules` `getChain` `deny(roleId, rule)` `MutationResult<PermissionRuleView>` `previewAccessUpdate(roleId, patch, options?)` `patch` `parentId/status` `ImpactPreview<RoleAccessUpdatePlan>` `executable/conflicts/capacity/affectedUsers` `executeAccessUpdate(roleId, patch, options)` `preview.expected` `previewToken` `CIRCULAR_INHERITANCE` `getRemovalImpact(roleId)` `VersionedResult<RoleRemovalImpact>` `childRoles/directUsers/menuSources` `remove(roleId, options)` `expectedRevision` `DEPENDENCY_EXISTS` `userRoles.getDirect` `userRoles.getEffective` `getDirect(userId)` `getEffective(userId)` `set()` -->

Each role has at most one direct parent. Child roles inherit the active parent chain while preserving readable provenance for own rules and menu-generated rules.

## Create Parent and Child Roles

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

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
## Read Own and Effective State

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

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
## Conflict Handling

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

```ts
await scoped.roles.deny('order-operator', {
  action: 'read',
  resource: 'db:orders:field:secret',
});
```
## Safely Change Parent or Status

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

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
## Parent Changes, Removal, and Cache

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

## Admin UI Model

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

Continue with [Multi-Tenant Model](/guide/multi-tenant).
