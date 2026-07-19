# Check Permissions

Use a subject context for request-time decisions and a scoped context for administration reads. Both are immutable facades over the same tenant-scoped authorization state.

## Boolean checks and enforcement

```ts
const subject = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme' },
});

const allowed = await subject.can('invoke', 'GET:/api/orders');
const blocked = await subject.cannot('invoke', 'DELETE:/api/orders');
await subject.assert('invoke', 'GET:/api/orders');
```

```json
{ "allowed": true, "blocked": true, "assertResult": "void" }
```

`can` returns a boolean. `cannot` returns the exact logical negation. `assert` resolves with no value when allowed and throws `PERMISSION_DENIED` otherwise. A blocked result does not imply that an explicit deny rule exists; default deny also blocks the operation.

Use the matched route template, such as `GET:/orders/:id`, rather than a concrete URL with query parameters. Keep the action and resource naming identical when granting and checking.

## Explain a decision

```ts
const explanation = await subject.explain(
  'invoke',
  'DELETE:/api/orders',
);
```

```json
{
  "data": {
    "allowed": false,
    "action": "invoke",
    "resource": "DELETE:/api/orders",
    "reason": "no-allow",
    "evaluations": [
      { "action": "invoke", "allowed": false, "reason": "no-allow" }
    ]
  },
  "detailBudget": { "limit": 100, "returned": 0, "truncated": false, "digest": "..." }
}
```

Typical reasons are `allow`, `explicit-deny`, `no-allow`, `policy-unknown`, `role-disabled`, and `context-missing`. Explanation traces are bounded; check `detailBudget` before assuming every matching source was returned.

## Read a role and its rules

```ts
const scoped = pc.scope({ tenantId: 'acme' });
const role = await scoped.roles.get('order-reader');
const own = await scoped.roles.getOwnRules('order-reader');
const effective = await scoped.roles.getEffectiveRules('order-reader');
const chain = await scoped.roles.getChain('order-reader');
```

```json
{
  "role": { "id": "order-reader", "parentId": null, "revision": 2 },
  "ownRules": [
    { "effect": "allow", "action": "invoke", "resource": "GET:/api/orders" }
  ],
  "effectiveRuleCount": 1,
  "chain": [{ "role": { "id": "order-reader" }, "depth": 0, "included": true }]
}
```

`getOwnRules` shows only rules attached to that role. `getEffectiveRules` includes inherited rules, conflicts, source role IDs, and menu-generated sources. `getChain` shows why each role in the single-parent chain is included or excluded.

## Read and replace user roles

```ts
await scoped.userRoles.assign('u-1', 'order-reader');
await scoped.userRoles.assign('u-1', 'operator');

const direct = await scoped.userRoles.getDirect('u-1');
const saved = await scoped.userRoles.set('u-1', ['order-reader'], {
  expectedRevision: direct.data.revision,
});
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
```

```json
{
  "beforeSet": ["operator", "order-reader"],
  "afterSet": ["order-reader"],
  "effective": ["order-reader"]
}
```

`assign` is an incremental add and is idempotent for an existing binding. `set` is a complete replacement protected by `expectedRevision`; omitting a role revokes that direct binding. Use `set` for a form that saves the entire selected role list, not for a single checkbox event.

## Read the subject snapshot

```ts
const permissions = await subject.getPermissions();
const invokeResources = await subject.getResources('invoke');
```

```json
{
  "permissions": {
    "data": {
      "subject": { "userId": "u-1", "scope": { "tenantId": "acme" } },
      "directRoleIds": ["order-reader"],
      "roles": {
        "total": 1,
        "items": [{
          "role": { "id": "order-reader", "status": "enabled", "parentId": null },
          "direct": true,
          "viaRoleIds": ["order-reader"],
          "depth": 0,
          "included": true
        }],
        "truncated": false,
        "digest": "..."
      },
      "rules": {
        "total": 1,
        "items": [{
          "effect": "allow",
          "action": "invoke",
          "resource": "GET:/api/orders",
          "sourceRoleId": "order-reader",
          "inherited": false,
          "depth": 0
        }],
        "truncated": false,
        "digest": "..."
      },
      "conflicts": { "total": 0, "items": [], "truncated": false, "digest": "..." }
    },
    "detailBudget": { "limit": 100, "returned": 2, "truncated": false, "digest": "..." }
  },
  "invokeResources": {
    "data": [{
      "action": "invoke",
      "resource": "GET:/api/orders",
      "conditional": false,
      "sourceRoleIds": {
        "total": 1,
        "items": ["order-reader"],
        "truncated": false,
        "digest": "..."
      }
    }],
    "detailBudget": { "limit": 100, "returned": 1, "truncated": false, "digest": "..." }
  }
}
```

`getPermissions()` returns direct role IDs, bounded effective roles, bounded effective rules, and conflicts. `getResources(action?)` returns effective resource patterns and marks conditional entries. These methods are diagnostic snapshots, not replacement authorization checks: call `can` or `assert` for the concrete operation and policy context.

For inheritance behavior, continue with [Role Inheritance](/guide/role-inheritance). For method signatures, see [Core and Contexts](/api/core-and-contexts), [Roles](/api/roles), and [User Roles](/api/user-roles).
