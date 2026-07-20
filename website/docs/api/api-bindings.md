# Configure APIs and Response Fields API

## Purpose and preconditions

This page describes API and response-field configuration inside `MenuConfigInput`. Applications no longer need to directly create API bindings through a public manager. Declare `load`, `actions`, and `response` in the menu config; `menus.config.save()` compiles the internal endpoint contracts.

Before using it:

- You have a `MenuConfigInput`.
- API resources use `ApiResource` in `api:METHOD:/path` form.
- Response fields are declared in config before role-menu grants select them.

## What Do You Want to Do?

| Goal | Field or API | Notes |
|---|---|---|
| Declare a load API | `MenuConfigInput.load` | Use `load.resource`; permission-core automatically treats it as `invoke`. |
| Declare an action API | `MenuConfigInput.actions` | Use `actions[].resource`; `api:*` actions can also declare `response`. |
| Declare response fields | `response` / `ResponseProjectionConfigInput` | Use array form for direct objects or `{ target, preserve, fields }` for paged responses. |
| Runtime check | `subject.assert()` / `subject.menus.filterResponse()` | Guard the API and project the response by granted fields. |
| Common errors | validation errors and permission errors | Check invalid resource format, field path conflicts, missing grants, and no-allow results. |

## Signatures

```ts
MenuConfigInput.load: readonly MenuLoadInput[]
load.resource: ApiResource
load.response?: ResponseProjectionInput

MenuConfigInput.actions: readonly MenuActionInput[]
actions[].resource: ApiResource | UiResource
actions[].response?: ResponseProjectionInput

MenuConfigInput.response?: ResponseProjectionConfigInput
response?: ResponseProjectionConfigInput
```

Signature markers: `load.resource: ApiResource`, `actions[].resource: ApiResource | UiResource`, `response?: ResponseProjectionConfigInput`.

## Parameters

<!-- docs:params owner=MenuConfigInput locale=en -->

### `MenuLoadInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `resource` | `ApiResource` | Required | View load API, for example `api:GET:/api/orders`. The system treats it as `invoke`; do not write action separately. |
| `response` | `ResponseProjectionInput` | Optional | Response fields that can be granted for this API. |
| `meta` | `Record<string, PolicyValue>` | Optional | Custom admin metadata. |

### `MenuActionInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `id` | `string` | Optional | Action ID; the compiler can generate one, but explicit IDs are easier to manage. |
| `title` | `string` | Required | Action display name. |
| `resource` | `ApiResource \| UiResource` | Required | Backend APIs use `api:`, frontend-only actions use `ui:`. |
| `opens` | `string` | Optional | View ID opened by the action. |
| `response` | `ResponseProjectionInput` | Optional | Field config for the action API response. |
| `enabled` | `boolean` | Default `true` | Whether the action is active. |
| `i18nKey/meta` | Display metadata | Optional | For frontend or management UI. |

### `ResponseProjectionConfigInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `fields` | `ResponseFieldDefinition[]` | Required | Grantable field definitions. |
| `target` | `string` | Optional | Object or array path to project, such as `items` or `data.items`. |
| `preserve` | `string[]` | Default `[]` | Outer fields to keep without field grants, such as `total` or `cursor`. |

`ResponseProjectionInput` can be a field array or an object with `{ target, preserve, fields }`.

## Load API field

<span id="menu-config-input-load"></span>
### `MenuConfigInput.load`

<!-- docs:method name=MenuConfigInput.load locale=en -->

- **Purpose**: Declare backend APIs required when entering a view.
- **Parameters**: `load.resource` is an `ApiResource`; `load.response` declares grantable response fields.
- **State impact**: Saving the config creates an internal endpoint contract; selecting `include.loads: true` in a role grant creates invoke permission sources.
- **Raw return**: The field has no standalone return. Results appear in `menus.config.preview/save` plans and snapshots.

Example:

```ts
load: [{
  resource: 'api:GET:/api/orders',
  response: {
    target: 'items',
    preserve: ['total'],
    fields: [
      { field: 'orderNo', title: '订单号' },
      { field: 'status', title: '状态' },
    ],
  },
}]
```

## Action API field

<span id="menu-config-input-actions"></span>
### `MenuConfigInput.actions`

<!-- docs:method name=MenuConfigInput.actions locale=en -->

- **Purpose**: Declare buttons, toolbar actions, or row actions under a view.
- **Parameters**: `actions[].resource` is `ApiResource | UiResource`; use `api:` when the action calls the backend.
- **State impact**: Saving the config creates grantable actions; selecting `include.actions: true` creates action or API permission sources.
- **Raw return**: The field has no standalone return. User-side state is read with `subject.menus.getActionMap()`.

Example:

```ts
actions: [{
  id: 'export',
  title: '导出订单',
  resource: 'api:POST:/api/orders/export',
  response: [{ field: 'downloadUrl', title: '下载地址' }],
}]
```

## Response field projection

<span id="menu-config-input-response"></span>
### `MenuConfigInput.response`

<!-- docs:method name=MenuConfigInput.response locale=en -->

- **Purpose**: Define which fields in an API response can be granted to roles.
- **Parameters**: Array form declares fields directly; object form uses `target/preserve/fields` for paginated or nested responses.
- **State impact**: Saving the config creates field inventory. After role grants select `responseFields`, `filterResponse()` returns only those fields.
- **Raw return**: Field declarations appear in `MenuConfigSnapshot` load/action responses; runtime projection appears in `SubjectRuntimeResult.data`.

Array form:

```ts
response: [
  { field: 'orderNo', title: '订单号' },
  { field: 'buyer.name', title: '买家姓名' },
]
```

Paginated form:

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

## Responses and side effects

`load/actions/response` are config fields, not standalone mutation methods. Their validation and compiled results surface through these APIs:

| Operation | Result |
|---|---|
| `menus.config.preview(config)` | Previews whether the config is valid and which internal assets it creates. |
| `menus.config.save(config, options)` | Saves the config and returns `MenuConfigSaveResult`. |
| `roles.menuPermissions.preview/grant` | Selects load, action, and responseFields and creates role sources. |
| `subject.menus.filterResponse(apiResource, payload)` | Projects response fields for the current user. |

```json
{
  "load": {
    "resource": "api:GET:/api/orders",
    "responseFieldCount": 2
  },
  "action": {
    "id": "export",
    "resource": "api:POST:/api/orders/export"
  }
}
```

## Failures and limits

`load.resource` must be an `api:` resource. `actions[].resource` must use a supported resource scheme. Field paths cannot be empty or unsafe, and role grants cannot select undeclared fields. `preserve` bypasses field grants, so keep it for structural fields, not sensitive business fields.

## Example

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

const projected = await subject.menus.filterResponse('api:GET:/api/orders', {
  items: [{ orderNo: 'O-1001', status: 'paid', amount: 88 }],
  total: 1,
});
```

```json
{
  "items": [{ "orderNo": "O-1001", "status": "paid" }],
  "total": 1
}
```

## Related

See [Manage Menus](/guide/menu-management), [Authorize Role Menus](/guide/role-menu-authorization), and [Menus API](/api/menus).
