# Configure APIs and Response Fields

In the new menu model, applications do not directly manage a public API-binding manager. Declare `load`, `actions`, and `response` inside `MenuConfigInput`; permission-core compiles them into internal endpoint contracts used by role-menu grants, Vext route guards, and response-field projection.

## View Load APIs

APIs called when a view opens live in `views[].load[]`:

```ts
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
}]
```

`load.resource` must be an `ApiResource` in `api:METHOD:/path` form. You do not write `action: 'invoke'`; the system compiles a load into `invoke + api:GET:/api/orders`.

| Scenario | Effect |
|---|---|
| Menu save | `menus.config.save()` records the endpoint as an internal contract. |
| Role grant | `include.loads: true` grants invoke permission for the load API. |
| User runtime | `getViewState()` checks API availability, and `filterResponse()` projects response fields. |

## Page Actions

Buttons, toolbar actions, and row actions live in `views[].actions[]`:

```ts
actions: [{
  id: 'export',
  title: '导出订单',
  resource: 'api:POST:/api/orders/export',
  response: [{ field: 'downloadUrl', title: '下载地址' }],
}]
```

`actions[].resource` can point to a backend API or a frontend-only UI resource:

| Resource | Use it for |
|---|---|
| `api:POST:/api/orders/export` | The action calls a backend endpoint and should be guarded server-side. |
| `ui:button:orders.export` | A frontend-only capability with no backend endpoint. |

If the action calls the backend, prefer `api:`. Then `roles.menuPermissions.grant()` with `include.actions: true` gives the role both action state and API invoke permission.

## Response Field Config

There are two response-field shapes.

Direct object or array projection:

```ts
response: [
  { field: 'orderNo', title: '订单号' },
  { field: 'buyer.name', title: '买家姓名' },
]
```

Paginated response projection:

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

`field` supports dot paths such as `buyer.name`. `target` also supports dot paths, for example `data.items`. `preserve` is for outer structural fields such as totals, cursors, or status fields; do not use it for sensitive business fields, because it is not field-granted.

## Grant Response Fields

After fields are declared in config, select them in the role-menu grant:

```ts
const selection = {
  configId: 'admin',
  views: ['orders-list'],
  responseFields: [{
    apiResource: 'api:GET:/api/orders',
    fields: ['orderNo', 'status'],
  }],
  include: { loads: true, actions: true, responseFields: 'none' },
};
```

`fields` must come from the fields already declared for that API in the config. Preview rejects fields that do not exist in the config.

## Project the Response on the Server

Call before returning from the endpoint:

```ts
const projected = await subject.menus.filterResponse('api:GET:/api/orders', {
  items: [
    { orderNo: 'O-1001', status: 'paid', amount: 88, internalCost: 51 },
  ],
  total: 1,
  debug: true,
});
```

```json
{
  "items": [{ "orderNo": "O-1001", "status": "paid" }],
  "total": 1
}
```

`filterResponse()` first checks API invoke permission. If the user cannot `invoke + api:GET:/api/orders`, it fails. If the user can invoke the API but has only some response fields, it returns only those fields.

In the Vext plugin, routes protected by `permission: true` automatically project `res.json()` responses. Manual handlers can also call `req.auth.permission.filterResponse()`. See [Vext Plugin](/guide/vext-plugin).

## Backend APIs Still Need Guards

Response-field projection does not replace route authorization. Protect the endpoint first:

```ts
const subject = pc.forSubject({ userId: 'u-menu', scope });
await subject.assert('invoke', 'api:GET:/api/orders');
const projected = await subject.menus.filterResponse('api:GET:/api/orders', payload);
```

With the Vext plugin, `permission: true` checks `invoke + api:METHOD:/path` from the route. Without Vext, call `subject.assert()` in your framework.

## Common Mistakes

| Mistake | Correct model |
|---|---|
| Create API bindings first, then menus | Do not. `MenuConfigInput` is the public entry. |
| `load` needs action | It does not. `load.resource` automatically compiles to `invoke`. |
| Response fields only affect frontend display | They should be projected server-side with `filterResponse()`. |
| `preserve` can contain any field | Avoid that. `preserve` is for outer structure fields, not sensitive business fields. |

See [Configure APIs and Response Fields API](/api/api-bindings) and the complete flow in [Manage Menus](/guide/menu-management).
