# 配置接口与响应字段 API

## 用途与前置条件

本页说明菜单中的接口和响应字段配置。后台页面可以用 `menus.loadApis/actions/responses` 逐项维护；配置即代码可以在 `MenuConfigInput` 中声明 `load`、`actions` 和 `response`。公开 API 不再要求业务方直接创建接口绑定，保存时 permission-core 会自动编译出内部接口契约。

前置条件：

- 已有一套菜单配置；可以来自 `menus.configs.create()` 空配置，也可以来自完整 `MenuConfigInput`。
- 接口资源统一使用 `ApiResource`，格式是 `api:METHOD:/path`。
- 需要裁剪响应字段时，先在配置里声明字段，再通过角色菜单授权分配字段。

## 我想做什么

| 目标 | 字段或 API | 说明 |
|---|---|---|
| 声明加载接口 | `menus.loadApis.add()` / `MenuConfigInput.load` | 使用 `resource`；系统自动按 `invoke` 处理。 |
| 声明操作接口 | `menus.actions.create()` / `MenuConfigInput.actions` | 使用 `resource`；`api:*` 操作也可以声明 `response`。 |
| 声明响应字段 | `menus.responses.set()` / `response` | 对象或数组直接用数组形式；分页响应用 `{ target, preserve, fields }`。 |
| 运行时校验 | `subject.assert()` / `subject.menus.filterResponse()` | 先守住接口调用，再按已授权字段裁剪响应。 |
| 常见错误 | 校验错误和权限错误 | 检查资源格式、字段路径冲突、缺少字段授权和默认拒绝。 |

## 签名

```ts
MenuConfigInput.load: readonly MenuLoadInput[]
load.resource: ApiResource
load.response?: ResponseProjectionInput

MenuConfigInput.actions: readonly MenuActionInput[]
actions[].resource: ApiResource | UiResource
actions[].response?: ResponseProjectionInput

MenuConfigInput.response?: ResponseProjectionConfigInput
response?: ResponseProjectionConfigInput

menus.loadApis.add(configId: string, viewId: string, input: MenuLoadApiAddInput, options: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.actions.create(configId: string, viewId: string, input: MenuActionCreateInput, options: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.responses.set(configId: string, input: MenuResponseSetInput, options: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
```

关键参数标记：`load.resource: ApiResource`，`actions[].resource: ApiResource | UiResource`，`response?: ResponseProjectionConfigInput`。逐项 API 的 `options` 普通情况下传 `actorId/idempotencyKey` 即可，系统会自动内部预览并提交；级联删除、撤权删除或自动提交被拒绝时，再使用对应 `preview*()` 返回的 `expected/previewToken` 显式确认。

## 参数对象

<!-- docs:params owner=MenuConfigInput locale=zh -->

### `MenuLoadInput`

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `resource` | `ApiResource` | 必填 | 页面加载接口，例如 `api:GET:/api/orders`。系统自动按 `invoke` 处理，不需要额外写 action。 |
| `response` | `ResponseProjectionInput` | 可选 | 该接口允许配置的响应字段。 |
| `meta` | `Record<string, PolicyValue>` | 可选 | 管理端自定义元数据。 |

### `MenuActionInput`

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `id` | `string` | 可选 | 按钮/操作 ID；不填时由编译器生成稳定 ID，但建议显式填写。 |
| `title` | `string` | 必填 | 操作展示名。 |
| `resource` | `ApiResource \| UiResource` | 必填 | 后端接口使用 `api:`，纯前端按钮使用 `ui:`。 |
| `opens` | `string` | 可选 | 点击后打开的 view ID。 |
| `response` | `ResponseProjectionInput` | 可选 | 操作接口返回值的字段配置。 |
| `enabled` | `boolean` | 默认 `true` | 是否启用该操作。 |
| `i18nKey/meta` | 展示元数据 | 可选 | 给前端或管理端使用。 |

### `ResponseProjectionConfigInput`

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `fields` | `ResponseFieldDefinition[]` | 必填 | 可授权字段清单。 |
| `target` | `string` | 可选 | 要裁剪的对象或数组路径，例如 `items`、`data.items`。 |
| `preserve` | `string[]` | 默认 `[]` | 保留但不参与字段授权的外层字段，例如 `total`、`cursor`。 |

`ResponseProjectionInput` 可以直接写成字段数组，也可以写成 `{ target, preserve, fields }` 对象。

## 方法详解：页面加载接口

<span id="menu-config-input-load"></span>
### `MenuConfigInput.load`

<!-- docs:method name=MenuConfigInput.load locale=zh -->

- **用途**：声明视图进入时必须调用的后端接口。
- **参数**：`load.resource` 是 `ApiResource`；`load.response` 是该接口可被授权的响应字段。
- **状态影响**：保存配置时会生成内部接口契约；角色选择 `include.loads: true` 时会生成接口调用权限来源。
- **原始返回**：字段本身没有独立返回；结果体现在 `menus.config.preview/save` 的计划和配置快照中。

示例：

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

## 方法详解：页面操作接口

<span id="menu-config-input-actions"></span>
### `MenuConfigInput.actions`

<!-- docs:method name=MenuConfigInput.actions locale=zh -->

- **用途**：声明视图下的按钮、工具栏动作或行操作。
- **参数**：`actions[].resource` 是 `ApiResource | UiResource`；有后端接口时建议使用 `api:`。
- **状态影响**：保存配置时会生成可授权操作；角色选择 `include.actions: true` 时会生成按钮或接口权限来源。
- **原始返回**：字段本身没有独立返回；用户侧通过 `subject.menus.getActionMap()` 读取操作状态。

示例：

```ts
actions: [{
  id: 'export',
  title: '导出订单',
  resource: 'api:POST:/api/orders/export',
  response: [{ field: 'downloadUrl', title: '下载地址' }],
}]
```

## 方法详解：响应字段

<span id="menu-config-input-response"></span>
### `MenuConfigInput.response`

<!-- docs:method name=MenuConfigInput.response locale=zh -->

- **用途**：定义某个接口响应里哪些字段可以被分配给角色。
- **参数**：数组形式直接声明字段；对象形式使用 `target/preserve/fields` 处理分页或嵌套响应。
- **状态影响**：保存配置后形成字段库存；角色授权 `responseFields` 选择字段后，`filterResponse()` 才会返回这些字段。
- **原始返回**：字段声明会出现在 `MenuConfigSnapshot` 的 load/action response 中；运行时裁剪结果在 `SubjectRuntimeResult.data`。

数组形式：

```ts
response: [
  { field: 'orderNo', title: '订单号' },
  { field: 'buyer.name', title: '买家姓名' },
]
```

分页形式：

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

## 响应与副作用

`load/actions/response` 本身是配置字段，不直接返回 mutation envelope。它们的校验和编译结果通过这些 API 体现：

| 操作 | 结果 |
|---|---|
| `menus.loadApis.add()` / `menus.responses.set()` | 逐项保存接口和响应字段，并返回 `MenuManagementResult`。 |
| `menus.config.preview(config)` | 预览配置是否合法、会生成哪些内部资产。 |
| `menus.config.save(config, options)` | 保存配置并返回 `MenuConfigSaveResult`。 |
| `roles.menuPermissions.preview/grant` | 选择 load、action、responseFields 并生成角色来源。 |
| `subject.menus.filterResponse(apiResource, payload)` | 对当前用户执行响应字段裁剪。 |

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

## 失败与限制

`load.resource` 必须是 `api:` 资源；`actions[].resource` 只能是支持的资源 scheme；字段路径不能为空、不能包含危险段，也不能引用未声明字段。`preserve` 不参与字段授权，适合分页总数和游标，不适合业务敏感字段。

## 示例

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
```

```json
{
  "items": [{ "orderNo": "O-1001", "status": "paid" }],
  "total": 1
}
```

## 相关内容

参见[管理菜单](/zh/guide/menu-management)、[角色菜单授权](/zh/guide/role-menu-authorization)和[菜单 API](/zh/api/menus)。
