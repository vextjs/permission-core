# Quick Start

This path starts with a host-owned MonSQLize connection, reaches the first authorization decision in steps 1-4, then adds menu and data permissions. The runnable sources are [`examples/basic.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/basic.mjs) for steps 1-4, [`examples/menu-admin.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/menu-admin.mjs) for step 5, and [`examples/data-guard.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/data-guard.mjs) for step 6.

## 1. Install and initialize

Use Node.js 18 or newer and an available MongoDB deployment.

```bash
npm install permission-core monsqlize@3.1.0
```

```ts
import MonSQLize from 'monsqlize';
import { PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://127.0.0.1:27017' },
});
await msq.connect();

const pc = new PermissionCore({
  monsqlize: msq,
  tokenSecret: 'replace-with-a-host-secret-at-least-32-bytes',
});
const health = await pc.init();
```

`tokenSecret` must contain at least 32 UTF-8 bytes. Keep the same host-configured value on every instance that shares this permission namespace so preview and cursor tokens remain valid across restarts.

`init()` creates and verifies permission indexes and a transaction-capable database contract. Key fields from a successful response are:

```json
{
  "status": "up",
  "lifecycle": "ready",
  "initialized": true,
  "database": { "status": "up" }
}
```

The host owns `msq`. Closing permission-core later does not close that connection.

## 2. Create a role, rule, and user binding

All management APIs are scope-bound. At minimum, a scope contains `tenantId`.

```ts
const scope = { tenantId: 'acme' };
const scoped = pc.scope(scope);

const created = await scoped.roles.create({
  id: 'order-reader',
  label: 'Order reader',
});
const rule = await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'GET:/api/orders',
});
const assigned = await scoped.userRoles.assign('u-1', 'order-reader');
```

Each mutation returns committed data, revision vectors, an audit ID, and cache outcome. The object below extracts the values used by this walkthrough from the three separate mutation responses:

```json
{
  "created": { "changed": true, "role": { "id": "order-reader", "revision": 1 } },
  "rule": { "effect": "allow", "action": "invoke", "resource": "GET:/api/orders" },
  "assigned": { "userId": "u-1", "roleIds": ["order-reader"], "revision": 1 }
}
```

`assign(userId, roleId)` adds one direct role. `set(userId, roleIds, { expectedRevision })` replaces the user's complete direct-role set and is intended for an admin form that saves the full selection.

## 3. Check allowed and blocked operations

Bind a trusted user and scope once, then evaluate that subject.

```ts
const subject = pc.forSubject({ userId: 'u-1', scope });

const allowed = await subject.can('invoke', 'GET:/api/orders');
const cannotDelete = await subject.cannot('invoke', 'DELETE:/api/orders');
```

```json
{
  "allowed": true,
  "cannotDelete": true
}
```

The role has no `DELETE:/api/orders` rule, so `can(...)` for DELETE is `false` and `cannot(...)` is `true`. `cannot` is exactly the negation of `can`; it does not assign a separate blocked permission. Use `deny` only when an explicit deny rule is required.

## 4. Read roles and effective permissions

These reads support role detail pages, user detail pages, and diagnostics without reconstructing inheritance in application code.

```ts
const role = await scoped.roles.get('order-reader');
const ownRules = await scoped.roles.getOwnRules('order-reader');
const effectiveRules = await scoped.roles.getEffectiveRules('order-reader');
const chain = await scoped.roles.getChain('order-reader');
const directRoles = await scoped.userRoles.getDirect('u-1');
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
const permissions = await subject.getPermissions();
const resources = await subject.getResources('invoke');
```

```json
{
  "role": { "id": "order-reader", "label": "Order reader", "revision": 2 },
  "directRoleIds": ["order-reader"],
  "effectiveRoleIds": ["order-reader"],
  "ownRules": ["allow:invoke:GET:/api/orders"],
  "effectiveRules": ["allow:invoke:GET:/api/orders"],
  "roleChain": ["order-reader"],
  "permissionRuleCount": 1,
  "resources": ["GET:/api/orders"]
}
```

Steps 1-4 are the independent First Success path. Run `npm run docs:first-success` in this repository to verify the same path against a freshly packed consumer.

## 5. Add a menu, API binding, and role grant

A menu node describes navigation or a button. An API binding describes a real backend endpoint owned by one or more nodes. A role grant turns that selected structure into permission rules.

```ts
await scoped.menus.create({
  id: 'operations', type: 'directory', title: 'Operations',
});
await scoped.menus.create({
  id: 'orders', parentId: 'operations', type: 'page', title: 'Orders',
  path: '/orders', name: 'orders', component: 'OrdersPage',
  permission: { action: 'read', resource: 'ui:page:orders' },
});
await scoped.menus.create({
  id: 'orders-export', parentId: 'orders', type: 'button',
  title: 'Export orders', code: 'orders.export',
  permission: { action: 'invoke', resource: 'ui:button:orders.export' },
});
await scoped.apiBindings.create({
  id: 'orders-export-api', method: 'POST', path: '/api/orders/export',
  purpose: 'importExport',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:POST:/api/orders/export' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
  canonicalOwner: { type: 'button', id: 'orders-export' },
});

const selection = {
  nodeIds: ['orders'],
  include: { descendants: true, buttons: true, apis: 'required', dataPermissions: false },
  apiChoices: { bindingIds: [], permissionsByBinding: {} },
};
const preview = await scoped.roles.menuPermissions.preview(
  'order-reader',
  { operation: 'grant', selection },
);
if (!preview.executable) throw new Error('Resolve preview conflicts first');
await scoped.roles.menuPermissions.grant('order-reader', selection, {
  ...preview.expected,
  previewToken: preview.previewToken,
});

const visible = await subject.menus.getVisibleTree();
const buttons = await subject.menus.getButtonMap('orders');
```

```json
{
  "visibleNodeIds": ["operations", "orders"],
  "buttons": {
    "orders.export": { "visible": true, "enabled": true, "reason": "allowed" }
  }
}
```

Visible UI state improves navigation but is not a backend security boundary. The export endpoint must enforce `api:POST:/api/orders/export` as well.

## 6. Add row and field permissions

Grant a collection rule with a dynamic row condition, allow fields used by filtering and projection, and explicitly deny the secret field.

```ts
await scoped.roles.allow('order-reader', {
  action: 'read',
  resource: 'db:orders',
  where: { field: 'merchantId', op: 'eq', valueFrom: 'claims.merchantId' },
});
for (const field of ['merchantId', 'status', 'publicValue']) {
  await scoped.roles.allow('order-reader', {
    action: 'read', resource: `db:orders:field:${field}`,
  });
}
await scoped.roles.deny('order-reader', {
  action: 'read', resource: 'db:orders:field:secret',
});

const dataSubject = pc.forSubject({
  userId: 'u-1',
  scope,
  claims: { merchantId: 'm-1' },
});
const orders = dataSubject.data.collection('orders', {
  resource: 'db:orders',
  scopeFields: { tenantId: 'tenantId' },
});
const rows = await orders.find(
  { status: 'paid' },
  { projection: ['merchantId', 'publicValue'] },
);
```

Given these stored rows:

```json
[
  { "tenantId": "acme", "merchantId": "m-1", "status": "paid", "publicValue": "shown", "secret": "hidden" },
  { "tenantId": "acme", "merchantId": "m-2", "status": "paid", "publicValue": "other merchant", "secret": "hidden" }
]
```

the authorized result is:

```json
[
  { "merchantId": "m-1", "publicValue": "shown" }
]
```

The runtime combines the caller's Mongo filter, exact tenant scope, all applicable row rules, and field authorization. It does not return a query for the caller to remember to apply.

## 7. Close in owner order

```ts
await pc.close();
await msq.close();
```

First stop new permission operations and drain permission-core, then let the host close MonSQLize. For authorization decisions, continue with [Check Permissions](/guide/check-permission); for database access, continue with [Data Permissions](/guide/data-permissions).
