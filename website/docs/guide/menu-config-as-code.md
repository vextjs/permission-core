# Menu Config as Code and Batch Imports

This is an advanced workflow for plugin installation, CI/CD, app upgrades, or config files that import a complete menu at once.

If you are building a normal admin page, prefer the incremental methods: `menus.configs/items/views/loadApis/actions/responses`. That path is easier to understand; see [Manage Menus](/guide/menu-management). If you only need to understand what `load`, `actions`, and `response` mean, see [Configure APIs and Response Fields](/guide/api-bindings).

## When to use MenuConfigInput

`MenuConfigInput` means “I already have the whole menu config and want to save it as one model.” It is not the best fit for saving one field at a time from a normal admin form.

| Scenario | Fit |
|---|---|
| Register a module menu during plugin installation | Good fit |
| Import the full admin menu during CI/CD release | Good fit |
| Restore menus from a JSON/YAML config package | Good fit |
| Add menus, views, and actions one by one in an admin page | Not first choice; incremental methods are clearer |
| Save a small menu-tree drag-and-drop edit | Not first choice; `menus.management.applyChanges()` fits better |

## Complete config example

A full config can declare menus, views, page load APIs, actions, and response fields together:

```ts
const menuConfig = {
  configId: 'admin',
  title: 'Admin console',
  menus: [{
    id: 'orders',
    title: 'Orders',
    icon: 'shopping-cart',
    views: [{
      id: 'orders-list',
      type: 'page',
      title: 'Orders',
      path: '/orders',
      component: 'OrdersPage',
      load: [{
        resource: 'api:GET:/api/orders',
        response: {
          target: 'items',
          preserve: ['total'],
          fields: [
            { field: 'orderNo', title: '订单号' },
            { field: 'status', title: '状态' },
            { field: 'amount', title: '金额' },
          ],
        },
      }],
      actions: [{
        id: 'export',
        title: '导出订单',
        resource: 'api:POST:/api/orders/export',
        response: [{ field: 'downloadUrl', title: '下载地址' }],
      }],
    }],
  }],
};
```

## Field guide

This config expresses these things:

| Field | Meaning | Runtime effect |
|---|---|---|
| `configId` | Stable ID for one menu config | Grants and runtime reads use it to find this admin menu. |
| `menus[]` | Left-side navigation groups | The group itself is not an API permission; it usually organizes views. |
| `views[]` | Openable pages, drawers, dialogs, or tabs | `getViewTree()` and `getViewState()` project these for the current user. |
| `load[].resource` | API called when entering the view | Write only `api:METHOD:/path`; the system supplies `invoke`. |
| `actions[].resource` | API or UI resource used by a page action | Supports backend `api:*` and frontend-only `ui:*` resources. |
| `response` | Fields that can be returned to the frontend | After role authorization, `filterResponse()` projects data by granted fields. |

`load.resource` must be an `api:` resource, for example `api:GET:/api/orders`. That lets Vext route guards, role-menu authorization, and response-field projection use one resource ID. `actions[].resource` can be a backend API or a pure UI resource; use `api:` for backend calls.

## Response field syntax

Inside `MenuConfigInput`, response fields support array form and object form:

```ts
response: [
  { field: 'orderNo', title: '订单号' },
  { field: 'buyer.name', title: '买家姓名' },
]
```

Array form works when the endpoint returns an object or an array directly. Field names support dot paths such as `buyer.name`.

For paginated responses, use object form:

```ts
response: {
  target: 'items',
  preserve: ['total'],
  fields: [
    { field: 'orderNo', title: '订单号' },
    { field: 'status', title: '状态' },
  ],
}
```

`target` points to the array to project, and `preserve` keeps outer structural fields that do not require field grants. The example above filters each row under `items` and preserves `total` as pagination metadata.

Note: array form is only for inline config inside `MenuConfigInput`. If you use the incremental method `menus.responses.set()`, write object form even without `target`: `response: { fields: [...] }`.

## Preview and save a full config

`menus.config.preview(config)` computes impact without writing; `menus.config.save(config, options)` writes the full config.

```ts
const scoped = pc.scope({ tenantId: 'acme', appId: 'admin' });

const preview = await scoped.menus.config.preview(menuConfig);
if (!preview.executable) {
  throw new Error('MENU_CONFIG_CONFLICT');
}

const saved = await scoped.menus.config.save(menuConfig, {
  ...preview.expected,
  previewToken: preview.previewToken,
});
```

```json
{
  "changed": true,
  "data": {
    "config": {
      "configId": "admin",
      "revision": 1,
      "menus": [{ "id": "orders", "views": [{ "id": "orders-list" }] }]
    },
    "manifestOperations": { "total": 3 },
    "retainedGrantCount": 0,
    "revokedGrantCount": 0
  }
}
```

Execution must include the preview’s `expected` and `previewToken` so an administrator cannot save a stale menu model.

## Change, delete, and batch update

Reads, deletes, and batch updates use the advanced `menus.config` entrypoint:

```ts
const current = await scoped.menus.config.get('admin');
const page = await scoped.menus.config.list({ first: 20 });

const previewRemove = await scoped.menus.config.previewRemove('admin');
if (previewRemove.executable) {
  await scoped.menus.config.remove('admin', {
    ...previewRemove.expected,
    previewToken: previewRemove.previewToken,
  });
}

const changes = [
  { operation: 'save', config: menuConfig },
  { operation: 'remove', configId: 'legacy-admin' },
];
const previewChanges = await scoped.menus.config.previewChanges(changes);
if (previewChanges.executable) {
  await scoped.menus.config.applyChanges(changes, {
    ...previewChanges.expected,
    previewToken: previewChanges.previewToken,
  });
}
```

Single saves fit a complete menu import. `menus.config.previewChanges()` / `menus.config.applyChanges()` fit plugin installation, app upgrades, and config package imports where several module menus change together.

After saving the config, the role still has no permission. If page APIs, action APIs, and response fields are still unclear, read [Configure APIs and Response Fields](/guide/api-bindings) first. The next usual step is [Authorize Role Menus](/guide/role-menu-authorization), where views, APIs, actions, and response fields are granted to roles.
