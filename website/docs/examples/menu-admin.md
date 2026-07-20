# Menu Administration
<!-- docs:inline-parity `examples/menu-admin.mjs` `docs:menu-admin:start` `docs:menu-admin:end` `roleGrant.generatedSources: 4` `roleGrant.auditRecorded: true` `subjectRuntime.exportButton.enabled: true` `manifest.apiBindingCount: 1` `menus.create` `apiBindings.create` `created` `menus.create()` `MutationResult<MenuNode>` `apiBindings.create()` `MutationResult<ApiBinding>` `root/page/button/binding.data.id` `roles.create` `order-operator` `userRoles.assign` `u-menu` `roles.create()` `userRoles.assign()` `set()` `menuPermissions.preview` `menuPermissions.grant` `menuPermissions.getDirect` `orders` `apiChoices` `roleGrant` `menuPermissions.preview(roleId, change)` `{ operation:'grant', selection }` `ImpactPreview<MenuPermissionPlan>` `menuPermissions.grant(roleId, selection, options)` `MutationResult<MenuPermissionGrantResult>` `menuPermissions.getDirect(roleId)` `VersionedResult<DirectMenuPermissionSnapshot>` `menus.update` `Order management` `revision` `expectedRevision` `2` `update` `page.data.revision` `updated` `updated.data.title/revision` `forSubject` `getVisibleTree` `getButtonMap` `/orders` `getRouteState` `subjectRuntime` `SubjectRuntimeResult<VisibleMenuTreeNode[]>` `data` `detailBudget` `menus.manifest.export` `schemaVersion` `manifest` `manifest.export()` `VersionedResult<FrontendMenuManifest>` `manifest.data.nodes/apiBindings` `printExample()` `generatedSources` `auditRecorded` -->

## Scenario

This example creates a directory, page, button, and API binding; grants the page workflow to a role; updates presentation state; projects user menu/button/route state; and exports a frontend manifest with audit evidence.

## Run

```bash
npm run example:menu-admin
```

The canonical source is the `docs:menu-admin:start` to `docs:menu-admin:end` block in `examples/menu-admin.mjs`.

## First Check the Result

A successful run confirms `roleGrant.generatedSources: 4`, `roleGrant.auditRecorded: true`, `subjectRuntime.exportButton.enabled: true`, and `manifest.apiBindingCount: 1`.

## Source walkthrough

```js
const root = await scoped.menus.create({
  id: 'operations', type: 'directory', title: 'Operations',
}, { actorId: 'admin' });
const page = await scoped.menus.create({
  id: 'orders', parentId: 'operations', type: 'page', title: 'Orders',
  path: '/orders', name: 'orders', component: 'OrdersPage',
  permission: { action: 'read', resource: 'ui:page:orders' },
  dataPermissions: [{ action: 'read', resource: 'db:orders', label: 'Read orders' }],
}, { actorId: 'admin' });
const button = await scoped.menus.create({
  id: 'orders-export', parentId: 'orders', type: 'button', title: 'Export orders',
  code: 'orders.export',
  permission: { action: 'invoke', resource: 'ui:button:orders.export' },
}, { actorId: 'admin' });
const binding = await scoped.apiBindings.create({
  id: 'orders-export-api', method: 'POST', path: '/api/orders/export',
  purpose: 'importExport',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:POST:/api/orders/export' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
  canonicalOwner: { type: 'button', id: 'orders-export' },
}, { actorId: 'admin' });

await scoped.roles.create({ id: 'order-operator', label: 'Order operator' });
await scoped.userRoles.assign('u-menu', 'order-operator');
const selection = {
  nodeIds: ['orders'],
  include: { descendants: true, buttons: true, apis: 'required', dataPermissions: true },
  apiChoices: { bindingIds: [], permissionsByBinding: {} },
};
const preview = await scoped.roles.menuPermissions.preview(
  'order-operator',
  { operation: 'grant', selection },
);
if (!preview.executable) throw new Error('Grant is not executable');
const granted = await scoped.roles.menuPermissions.grant('order-operator', selection, {
  ...preview.expected,
  previewToken: preview.previewToken,
});

const updated = await scoped.menus.update(
  'orders',
  { title: 'Order management' },
  { expectedRevision: page.data.revision, actorId: 'admin' },
);
const subjectMenus = core.forSubject({ userId: 'u-menu', scope }).menus;
const visible = await subjectMenus.getVisibleTree();
const buttons = await subjectMenus.getButtonMap('orders');
const route = await subjectMenus.getRouteState('/orders');
const manifest = await scoped.menus.manifest.export();
const directGrant = await scoped.roles.menuPermissions.getDirect('order-operator');
```

The selection includes descendants, buttons, required APIs, and data templates. The grant creates provenance-bearing rule sources, and UI projection evaluates those sources for the user.

### 1. Create the menu and API ownership model

<!-- docs:operation id=menu-model calls=menus.create,apiBindings.create outputs=created -->

**Purpose and target.** This operation explains `menus.create`, `apiBindings.create` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `created`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [menus](/api/menus), [api-bindings](/api/api-bindings) for exact signatures, response wrappers, and public error codes.

### 2. Create the role identity used by the workflow

<!-- docs:operation id=menu-role calls=roles.create,userRoles.assign outputs=subjectRuntime -->

**Purpose and target.** This operation explains `roles.create`, `userRoles.assign` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `subjectRuntime`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [roles](/api/roles), [user-roles](/api/user-roles) for exact signatures, response wrappers, and public error codes.

### 3. Preview and commit the role-menu grant

<!-- docs:operation id=menu-grant calls=menuPermissions.preview,menuPermissions.grant,menuPermissions.getDirect outputs=roleGrant -->

**Purpose and target.** This operation explains `menuPermissions.preview`, `menuPermissions.grant`, `menuPermissions.getDirect` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `roleGrant`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [role-menu-permissions](/api/role-menu-permissions) for exact signatures, response wrappers, and public error codes.

### 4. Update presentation state with a revision

<!-- docs:operation id=menu-update calls=menus.update outputs=update -->

**Purpose and target.** This operation explains `menus.update` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `update`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [menus](/api/menus) for exact signatures, response wrappers, and public error codes.

### 5. Project the user's visible runtime state

<!-- docs:operation id=menu-subject calls=forSubject,getVisibleTree,getButtonMap,getRouteState outputs=subjectRuntime -->

**Purpose and target.** This operation explains `forSubject`, `getVisibleTree`, `getButtonMap`, `getRouteState` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `subjectRuntime`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [core-and-contexts](/api/core-and-contexts), [menus](/api/menus), [role-menu-permissions](/api/role-menu-permissions) for exact signatures, response wrappers, and public error codes.

### 6. Export the frontend manifest

<!-- docs:operation id=menu-manifest calls=menus.manifest.export outputs=manifest -->

**Purpose and target.** This operation explains `menus.manifest.export` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `manifest`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [menus](/api/menus), [api-bindings](/api/api-bindings) for exact signatures, response wrappers, and public error codes.


## Expected output

The following JSON is the **Example summary output** generated by `printExample()`. It combines selected fields from several API calls and is not the raw response of one method.

```json
{
  "example": "menu-admin",
  "ok": true,
  "created": {
    "nodes": ["operations", "orders", "orders-export"],
    "apiBinding": "orders-export-api"
  },
  "update": { "title": "Order management", "revision": 2 },
  "roleGrant": {
    "generatedSources": 4,
    "grantCount": 1,
    "sourceStatus": { "integrity": "valid", "availability": "active", "drift": "current" },
    "auditRecorded": true
  },
  "subjectRuntime": {
    "visibleNodeIds": ["operations", "orders"],
    "exportButton": {
      "visible": true,
      "enabled": true,
      "reason": "allowed",
      "action": "invoke",
      "resource": "ui:button:orders.export",
      "apiRisks": {
        "total": 1,
        "items": [
          {
            "bindingId": "orders-export-api",
            "required": true,
            "allowed": true
          }
        ],
        "truncated": false,
        "digest": "tLtCyOJN4gP1FKjpuujpqJC7WfPZPYQkWlncDHSbiMY"
      }
    },
    "route": { "allowed": true, "reason": "allowed", "navigationReachable": true }
  },
  "manifest": { "schemaVersion": 2, "nodeCount": 3, "apiBindingCount": 1 }
}
```

<!-- docs:output group=created producer=menu-model -->

**`created` provenance.** This output group is produced by the menu-model walkthrough and should be read together with `menus.create`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=update producer=menu-update -->

**`update` provenance.** This output group is produced by the menu-update walkthrough and should be read together with `menus.update`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=roleGrant producer=menu-grant -->

**`roleGrant` provenance.** This output group is produced by the menu-grant walkthrough and should be read together with `menuPermissions.grant`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=subjectRuntime producer=menu-subject -->

**`subjectRuntime` provenance.** This output group is produced by the menu-subject walkthrough and should be read together with `getVisibleTree`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=manifest producer=menu-manifest -->

**`manifest` provenance.** This output group is produced by the menu-manifest walkthrough and should be read together with `menus.manifest.export`. It is a selected, documented example field rather than a new API response shape.


## Production boundary

This is a backend management workflow, not frontend-only filtering. Protect every management endpoint and every bound business API, and require preview tokens for high-impact changes.

## Related

See [Manage Menus](/guide/menu-management), [Bind APIs](/guide/api-bindings), and [Authorize Role Menus](/guide/role-menu-authorization).
