# Authorize Role Menus

Role-menu authorization converts an administrator's structural selection into durable, provenance-tracked permission rules. It does not bind a user automatically; users receive the result through their normal role bindings.

## Build a selection

```ts
const selection = {
  nodeIds: ['orders'],
  include: {
    descendants: true,
    buttons: true,
    apis: 'required',
    dataPermissions: true,
  },
  apiChoices: {
    bindingIds: [],
    permissionsByBinding: {},
  },
};
```

- `nodeIds` are the anchor nodes selected by the administrator.
- `descendants` includes child navigation nodes.
- `buttons` includes button children separately from the visible navigation tree.
- `apis` can include none, required owner bindings, or all owner bindings.
- `dataPermissions` includes data templates declared on selected nodes.
- `apiChoices` resolves explicit `any` alternatives returned by preview.

## Preview before execution

```ts
const preview = await scoped.roles.menuPermissions.preview(
  'order-operator',
  { operation: 'grant', selection },
  { actorId: 'admin' },
);
```

```json
{
  "executable": true,
  "plan": {
    "roleId": "order-operator",
    "operation": "grant",
    "choiceRequirements": { "total": 0 },
    "grants": { "total": 1 }
  },
  "previewToken": "signed-token",
  "expected": { "expectedRevisions": { "rbac": 3, "menu": 8 } }
}
```

If `executable` is false, render all `conflicts` and `choiceRequirements`. Rebuild the selection with the requested binding or permission semantic keys and preview again. Tokens bind the exact role, selection, plan, and revision vector; they are not reusable after relevant state changes.

## Grant, deny, revoke, or replace

```ts
if (!preview.executable) throw new Error('Resolve the preview first');
const granted = await scoped.roles.menuPermissions.grant(
  'order-operator',
  selection,
  {
    ...preview.expected,
    previewToken: preview.previewToken,
    actorId: 'admin',
    idempotencyKey: 'role-order-operator-orders-v1',
  },
);
```

```json
{
  "changed": true,
  "data": {
    "roleId": "order-operator",
    "generatedSources": 4,
    "generatedSemanticRules": 4,
    "removedSources": 0
  },
  "auditId": "..."
}
```

`grant` and `deny` create menu-source rules with opposite effects. `revoke` removes specific grant IDs. `set` replaces the role's complete menu assignment list and is the correct save operation for a full authorization-tree form. Every execute method requires a matching preview and revision vector.

## Bind users and read authorization

```ts
await scoped.userRoles.assign('u-1', 'order-operator');

const direct = await scoped.roles.menuPermissions.getDirect('order-operator');
const effective = await scoped.roles.menuPermissions.getEffective('order-operator');
const tree = await scoped.roles.menuPermissions.getAuthorizationTree('order-operator');
```

Direct reads show only grants owned by this role. Effective reads include inherited grants, source role IDs, conflicts, integrity, availability, and drift. The authorization tree is for an administrator; it is not the same as a user's visible menu tree.

## Project the user's UI

```ts
const menus = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme', appId: 'admin' },
}).menus;

const visible = await menus.getVisibleTree();
const buttons = await menus.getButtonMap('orders');
const route = await menus.getRouteState('/orders');
```

```json
{
  "visibleNodeIds": ["operations", "orders"],
  "button": { "visible": true, "enabled": true, "reason": "allowed" },
  "route": { "allowed": true, "navigationReachable": true }
}
```

A route can be permission-allowed but navigation-unreachable because an ancestor is hidden, disabled, denied, or API-unavailable. Keep `allowed` and `navigationReachable` separate in the frontend router.

## Handle asset changes

Each generated rule records its grant, asset, binding, contribution type, and snapshot digest. A changed menu permission or API binding may become `refresh-available`; a missing reference becomes stale or invalid. Use `listStale`, `previewRepairStale`, and `repairStale` only after showing the proposed source changes. Persisted integrity failures close authorization rather than silently falling back to old permissions.

The runnable [Menu Administration example](/examples/menu-admin) shows the full sequence. Exact methods and response types are in [Role Menu Permissions](/api/role-menu-permissions).
