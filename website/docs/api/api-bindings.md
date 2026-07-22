# Configure APIs and Response Fields API

## Purpose and preconditions

This page describes API and response-field configuration inside menu configs. Admin pages can maintain these pieces incrementally with `menus.loadApis/actions/responses`; config-as-code can declare `load`, `actions`, and `response` inside `MenuConfigInput`. Public code no longer needs to create API bindings directly. permission-core compiles internal endpoint contracts when the menu config is saved.

Before using it:

- You have a menu config, either from `menus.configs.create()` or a complete `MenuConfigInput`.
- API resources use `ApiResource` in `api:METHOD:/path` form.
- Response fields are declared in config before role-menu grants select them.

## What Do You Want to Do?

| Goal | Field or API | Notes |
|---|---|---|
| Declare a load API | `menus.loadApis.add()` / `MenuConfigInput.load` | Use `resource`; permission-core automatically treats it as `invoke`. |
| Declare an action API | `menus.actions.create()` / `MenuConfigInput.actions` | Use `resource`; `api:*` actions can also declare `response`. |
| Declare response fields | `menus.responses.set()` / `response` | `menus.responses.set()` uses object form; inline `MenuConfigInput` config can use an array or `{ target, preserve, fields }`. |
| Runtime check | `subject.assert()` / `subject.menus.filterResponse()` | Guard the API first, then project the response by granted fields; the projected value is in `data`. |
| Common errors | validation errors and permission errors | Check invalid resource format, field path conflicts, missing field grants, and default deny. |

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

menus.loadApis.add(configId: string, viewId: string, input: MenuLoadApiAddInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.actions.create(configId: string, viewId: string, input: MenuActionCreateInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.responses.set(configId: string, input: MenuResponseSetInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
```

Signature markers: `load.resource: ApiResource`, `actions[].resource: ApiResource | UiResource`, and `response?: ResponseProjectionConfigInput`. For ordinary incremental APIs, bind `actorId/requestId` once with `pc.scope(scope, defaults)`, then call the object methods directly; the system derives the idempotency key while performing internal preview and commit automatically. Use explicit `expected/previewToken` from the matching `preview*()` method for cascade delete, grant-revoking delete, or rejected auto-commit.

## Parameters

<!-- docs:params owner=MenuConfigInput locale=en -->

### `MenuLoadInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `resource` | `ApiResource` | Required | View load API, for example `api:GET:/api/orders`. The system treats it as `invoke`; do not write action separately. |
| `response` | `ResponseProjectionInput` | Optional | Response fields that can be granted for this API; inline `MenuConfigInput` config accepts array or object form. |
| `meta` | `Record<string, PolicyValue>` | Optional | Custom admin metadata. |

### `MenuActionInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `id` | `string` | Optional | Action ID; the compiler can generate one, but explicit IDs are easier to manage. |
| `title` | `string` | Required | Action display name. |
| `resource` | `ApiResource \| UiResource` | Required | Backend APIs use `api:`, frontend-only buttons use `ui:`. |
| `opens` | `string` | Optional | View ID opened by the action. |
| `response` | `ResponseProjectionInput` | Optional | Field config for the action API response; meaningful only for `api:*` actions. |
| `enabled` | `boolean` | Default `true` | Whether the action is active. |
| `i18nKey/meta` | Display metadata | Optional | For frontend or management UI. |

### `ResponseProjectionConfigInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `fields` | `ResponseFieldDefinition[]` | Required | Grantable field definitions. |
| `target` | `string` | Optional | Object or array path to project, such as `items` or `data.items`. |
| `preserve` | `string[]` | Default `[]` | Outer fields to keep without field grants, such as `total` or `cursor`. |

`ResponseProjectionInput` can be a field array or an object with `{ target, preserve, fields }`. That is the inline convenience form for `MenuConfigInput.load[].response` and `actions[].response`; `menus.responses.set()` should use object form, such as `response: { fields: [...] }`.

## Method details: page load APIs

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

## Method details: page action APIs

<span id="menu-config-input-actions"></span>
### `MenuConfigInput.actions`

<!-- docs:method name=MenuConfigInput.actions locale=en -->

- **Purpose**: Declare buttons, toolbar actions, or row operations under a view.
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

## Method details: response fields

<span id="menu-config-input-response"></span>
### `MenuConfigInput.response`

<!-- docs:method name=MenuConfigInput.response locale=en -->

- **Purpose**: Define which fields in an API response can be granted to roles.
- **Parameters**: Array form declares fields directly; object form uses `target/preserve/fields` for paginated or nested responses. When calling `menus.responses.set()` incrementally, wrap it in object form: `response: { fields: [...] }`.
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

`load/actions/response` are config fields, not standalone mutation envelopes. Their validation and compiled results surface through these APIs:

| Operation | Result |
|---|---|
| `menus.loadApis.add()` / `menus.actions.create()` / `menus.responses.set()` | Incrementally saves APIs, actions, and response fields and returns `MenuManagementResult`. |
| `menus.config.preview(config)` | Previews whether the config is valid and which internal assets it creates. |
| `menus.config.save(config, options)` | Saves the config and returns `MenuConfigSaveResult`. |
| `roles.menuPermissions.preview/grant` | Selects load, action, and responseFields and creates role sources. |
| `subject.menus.filterResponse(apiResource, payload)` | Projects response fields for the current user; the projected payload is in `data`. |

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

For incremental response-field configuration, remember that `menus.responses.set()` expects `input.response` to be a `ResponseProjectionConfigInput` object, not an array. For a direct-object response, write `{ fields: [...] }`.

## Example

```ts
const selection = {
  configId: 'admin',
  views: ['orders-list'],
  responseFields: [{
    apiResource: 'api:GET:/api/orders',
    target: 'items',
    fields: ['orderNo', 'status'],
  }],
  include: { loads: true, actions: true, responseFields: 'none' },
};

const projected = await subject.menus.filterResponse('api:GET:/api/orders', {
  items: [{ orderNo: 'O-1001', status: 'paid', amount: 88 }],
  total: 1,
});
const projectedData = projected.data;
```

```json
{
  "items": [{ "orderNo": "O-1001", "status": "paid" }],
  "total": 1
}
```

## Related

See [Manage Menus](/guide/menu-management), [Authorize Role Menus](/guide/role-menu-authorization), and [Menus API](/api/menus).
