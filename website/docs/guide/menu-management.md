# Manage Menus
<!-- docs:inline-parity `directory` `id` `title` `menu` `path` `name` `permission` `page` `component` `button` `code` `external` `url` `iframe` `menus.create()` `MutationResult<MenuNode>` `revisions/operationId/replayed/cache/warnings/detailBudget` `pc.scope(scope)` `tenantId` `appId` `menus.create(input, options?)` `get(nodeId)` `list(filter)` `getTree({ rootId?, includeHidden? })` `VersionedResult<MenuNode>` `list(query?)` `parentId/type/status/hidden/search/first/after` `PageResult<MenuNode>` `getTree(options?)` `VersionedResult<MenuTreeNode[]>` `subject.menus.getVisibleTree(options?)` `SubjectRuntimeResult<VisibleMenuTreeNode[]>` `get()` `data.revision` `update()` `updated.data.revision` `previewUpdate` `executeUpdate` `previewMove(input)` `ImpactPreview<MenuMovePlan>` `executable` `conflicts` `expected` `previewToken` `move(input, options)` `REVISION_CONFLICT` `PREVIEW_STALE` `cascade: true` `getRemovalImpact(nodeId)` `VersionedResult<MenuRemovalImpact>` `previewRemove(nodeId, input)` `ImpactPreview<MenuRemovalPlan>` `remove(nodeId, input, options)` `MutationResult<BatchMutationSummary>` `nodes` `apiBindings` `manifest.preview(manifest)` `replace` `manifest.import(manifest, options)` `manifest.export()` `VersionedResult<FrontendMenuManifest>` `exported.data` `merge` -->

Menu management stores the backend-owned navigation inventory. A node is not a permission by itself; role-menu authorization decides which roles receive the generated rules.

## Node Types

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
