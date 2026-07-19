# Manage Menus

Menu management stores the backend-owned navigation model. A node is not a permission by itself: it carries a permission requirement, optional data templates, hierarchy metadata, and revision state. Role authorization is a separate task.

## Node types

| Type | Purpose | Required fields |
|---|---|---|
| `directory` | Structural navigation group | `id`, `title` |
| `menu` | Navigable menu without a component | `path`, `name`, `permission` |
| `page` | Navigable application page | `path`, `name`, `component`, `permission` |
| `button` | Action inside a menu or page | `code`, `permission` |
| `external` | External URL entry | `url`, `permission` |
| `iframe` | Embedded URL with an internal route | `url`, `path`, `name`, `permission` |

Buttons never appear as tree navigation nodes. They are returned by the subject button map for their owner page or menu.

## Create and read nodes

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

Use `get(nodeId)`, cursor-based `list(filter)`, or `getTree({ rootId?, includeHidden? })` for management screens. These methods return management state, including disabled and hidden nodes; subject runtime projection is intentionally different.

## Update metadata and structure

Simple metadata changes use an entity revision:

```ts
const current = await scoped.menus.get('orders');
const updated = await scoped.menus.update(
  'orders',
  { title: 'Order management', icon: 'shopping-cart' },
  { expectedRevision: current.data.revision },
);
```

Path, permission, data templates, and other source-bearing changes require `previewUpdate` followed by `executeUpdate`. The preview exposes every role source that must be replaced or revoked. Moving, reordering, status changes, and removal follow the same preview/execute pattern when they can affect descendants or role grants.

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

`REVISION_CONFLICT` and `PREVIEW_STALE` mean the admin UI must reload current state. Never execute an old preview against a changed hierarchy.

## Remove safely

Read impact first, then preview the exact cascade decision:

```ts
const impact = await scoped.menus.getRemovalImpact('orders');
const preview = await scoped.menus.previewRemove('orders', {
  cascade: true,
});
```

The impact reports descendants, API bindings, and role sources. Removal is blocked when dependencies or source rewrites are unresolved. `cascade: true` removes descendants atomically; it does not silently detach unrelated role rules.

## Import and export a manifest

`nodes` is the ordered list of complete menu node declarations. `apiBindings` is the ordered list of backend endpoints and their owners. They live together in a version-2 manifest so frontend route declarations and backend authorization inventory can be reviewed as one unit.

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

`merge` changes declared IDs and keeps others; `replace` makes the manifest authoritative for the scope. Both modes remain revisioned, audited, capacity-bounded, and source-integrity checked.

Next, attach real endpoints in [API Bindings](/guide/api-bindings), then grant the structure in [Role Menu Authorization](/guide/role-menu-authorization).
