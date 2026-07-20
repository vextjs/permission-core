# Manage Menus
<!-- docs:inline-parity `directory` `id` `title` `menu` `path` `name` `permission` `page` `component` `button` `code` `external` `url` `iframe` `menus.create()` `MutationResult<MenuNode>` `revisions/operationId/replayed/cache/warnings/detailBudget` `pc.scope(scope)` `tenantId` `appId` `menus.create(input, options?)` `get(nodeId)` `list(filter)` `getTree({ rootId?, includeHidden? })` `VersionedResult<MenuNode>` `list(query?)` `parentId/type/status/hidden/search/first/after` `PageResult<MenuNode>` `getTree(options?)` `VersionedResult<MenuTreeNode[]>` `subject.menus.getVisibleTree(options?)` `SubjectRuntimeResult<VisibleMenuTreeNode[]>` `get()` `data.revision` `update()` `updated.data.revision` `previewUpdate` `executeUpdate` `previewMove(input)` `ImpactPreview<MenuMovePlan>` `executable` `conflicts` `expected` `previewToken` `move(input, options)` `REVISION_CONFLICT` `PREVIEW_STALE` `cascade: true` `getRemovalImpact(nodeId)` `VersionedResult<MenuRemovalImpact>` `previewRemove(nodeId, input)` `ImpactPreview<MenuRemovalPlan>` `remove(nodeId, input, options)` `MutationResult<BatchMutationSummary>` `nodes` `apiBindings` `manifest.preview(manifest)` `replace` `manifest.import(manifest, options)` `manifest.export()` `VersionedResult<FrontendMenuManifest>` `exported.data` `merge` -->

Menu management stores the backend-owned navigation inventory. The easiest way to understand it is as one menu configuration: pages, buttons, the APIs used by those buttons, and optional data-permission templates can all be reviewed and imported through one manifest.

The current manifest shape is flat: `nodes` contains directory/page/button UI nodes, while `apiBindings` contains real backend endpoints and points back to pages or buttons through `owners`. This is slightly more verbose than nested `page.buttons[].apis[]`, but it lets one API be shared by multiple UI assets and audited independently.

## One Importable Menu Config

```ts
const manifest = {
  schemaVersion: 2,
  mode: 'merge',
  nodes: [
    {
      id: 'operations',
      type: 'directory',
      title: 'Operations',
      order: 0,
    },
    {
      id: 'orders',
      parentId: 'operations',
      type: 'page',
      title: 'Orders',
      path: '/orders',
      name: 'orders',
      component: 'OrdersPage',
      order: 0,
      permission: { action: 'read', resource: 'ui:page:orders' },
      dataPermissions: [
        { action: 'read', resource: 'db:orders', label: 'Read orders' },
      ],
    },
    {
      id: 'orders-export',
      parentId: 'orders',
      type: 'button',
      title: 'Export',
      code: 'orders.export',
      order: 0,
      permission: { action: 'invoke', resource: 'ui:button:orders.export' },
    },
  ],
  apiBindings: [
    {
      id: 'orders-list-api',
      method: 'GET',
      path: '/api/orders',
      purpose: 'entry',
      authorization: {
        mode: 'all',
        permissions: [
          { action: 'invoke', resource: 'api:GET:/api/orders' },
        ],
      },
      owners: [{ type: 'page', id: 'orders', required: true }],
      canonicalOwner: { type: 'page', id: 'orders' },
    },
    {
      id: 'orders-export-api',
      method: 'POST',
      path: '/api/orders/export',
      purpose: 'importExport',
      authorization: {
        mode: 'all',
        permissions: [
          { action: 'invoke', resource: 'api:POST:/api/orders/export' },
        ],
      },
      owners: [{ type: 'button', id: 'orders-export', required: true }],
      canonicalOwner: { type: 'button', id: 'orders-export' },
    },
  ],
};

const preview = await scoped.menus.manifest.preview(manifest);
if (preview.executable) {
  await scoped.menus.manifest.import(manifest, {
    ...preview.expected,
    previewToken: preview.previewToken,
  });
}
```

This config means:

| Config | Purpose | Runtime effect |
|---|---|---|
| `nodes[0]` directory | Navigation grouping only | It is not a business permission. |
| `nodes[1]` page | The `/orders` page | A subject needs `ui:page:orders` for this page to appear in menu and route projections. |
| `nodes[1].dataPermissions` | Business data-permission templates related to the page | They are not granted when the menu is created; role-menu authorization expands them only when `dataPermissions` is included. |
| `nodes[2]` button | The export button on the page | A subject needs `ui:button:orders.export` for the button to appear in the button map. |
| `apiBindings[0]` | The endpoint loaded by default when the orders page opens | If the subject misses the `api:GET:/api/orders` invoke permission, the route may still be visible but runtime state can report the page's required API as unavailable; the backend endpoint must still check access. |
| `apiBindings[1]` | The backend endpoint used by the export button | If the subject misses the `api:POST:/api/orders/export` invoke permission, the button is projected as unavailable; the backend endpoint must still check access. |
| `owners` | Which page, menu, or button owns the API binding | `type: 'page'` fits default page-load APIs, `type: 'menu'` fits APIs triggered by clicking a menu item itself, and `type: 'button'` fits button operation APIs; `required: true` means missing API access makes that UI asset unavailable. |

You can treat this as one menu config file:

- Page access lives in the page node `permission`.
- APIs called by default when a page/menu opens live in `apiBindings[].authorization.permissions`, usually as `api:*` invoke permissions, with `owners: [{ type: 'page' | 'menu', id: ... }]` pointing back to that page or menu.
- Pure button access lives in the button node `permission`.
- Button API access lives in `apiBindings[].authorization.permissions`, usually as `api:*` invoke permissions.
- The button-to-API relationship lives in `apiBindings[].owners`.
- Do not mix data permissions into menu API access; related data-permission templates live in `dataPermissions`, and real data scope is enforced by data permissions or the data layer.
- Which pages, buttons, APIs, and data templates a role receives is decided by [role-menu authorization](/guide/role-menu-authorization).

## Node Types

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

Menu nodes only define UI assets that can be authorized and projected. Real backend endpoints are not stored on the node itself; [API bindings](/guide/api-bindings) point to page/menu/button `id` values through `owners`, and [role-menu authorization](/guide/role-menu-authorization) later expands the selected menus, buttons, APIs, and data templates into role rules.

## Create and Read Nodes

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const scoped = pc.scope({ tenantId: 'acme', appId: 'admin' });

const root = await scoped.menus.create({
  id: 'operations',
  type: 'directory',
  title: 'Operations',
});
const page = await scoped.menus.create({
  id: 'orders',
  parentId: 'operations',
  type: 'page',
  title: 'Orders',
  path: '/orders',
  name: 'orders',
  component: 'OrdersPage',
  permission: { action: 'read', resource: 'ui:page:orders' },
  dataPermissions: [
    { action: 'read', resource: 'db:orders', label: 'Read orders' },
  ],
});
```
```json
{
  "committed": true,
  "changed": true,
  "data": {
    "id": "orders",
    "parentId": "operations",
    "type": "page",
    "revision": 1
  },
  "revision": 2,
  "auditId": "..."
}
```
## Update Metadata and Structure

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const current = await scoped.menus.get('orders');
const updated = await scoped.menus.update(
  'orders',
  { title: 'Order management', icon: 'shopping-cart' },
  { expectedRevision: current.data.revision },
);
```
```ts
const preview = await scoped.menus.previewMove({
  nodeId: 'orders',
  parentId: null,
});
if (!preview.executable) throw new Error('Resolve conflicts first');
await scoped.menus.move(
  { nodeId: 'orders', parentId: null },
  { ...preview.expected, previewToken: preview.previewToken },
);
```
## Safe Removal

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const impact = await scoped.menus.getRemovalImpact('orders');
const preview = await scoped.menus.previewRemove('orders', {
  cascade: true,
});
if (!preview.executable) throw new Error('Resolve dependencies first');
const removed = await scoped.menus.remove(
  'orders',
  { cascade: true },
  { ...preview.expected, previewToken: preview.previewToken },
);
```
## Import and Export a Manifest

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const manifest = {
  schemaVersion: 2,
  mode: 'replace',
  nodes: [
    { id: 'operations', type: 'directory', title: 'Operations', order: 0 },
    {
      id: 'orders', parentId: 'operations', type: 'page', title: 'Orders',
      path: '/orders', name: 'orders', component: 'OrdersPage', order: 0,
      permission: { action: 'read', resource: 'ui:page:orders' },
    },
  ],
  apiBindings: [],
};
const preview = await scoped.menus.manifest.preview(manifest);
if (preview.executable) {
  await scoped.menus.manifest.import(manifest, {
    ...preview.expected,
    previewToken: preview.previewToken,
  });
}
const exported = await scoped.menus.manifest.export();
```
Continue with [Bind APIs](/guide/api-bindings).
