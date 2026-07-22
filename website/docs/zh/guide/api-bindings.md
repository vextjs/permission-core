# 接口与响应字段

新版菜单模型里，业务侧不需要手动创建 `apiBinding`。你只要把 `api:*` 资源配置到页面默认接口或按钮操作上，permission-core 会在保存时自动生成内部接口契约，并把它用于角色菜单授权、Vext 路由守卫和响应字段裁剪。

这页只回答三件事：

1. 页面打开时默认调用哪些接口。
2. 页面按钮点击时调用哪些接口，或者只是纯前端按钮权限。
3. 某个接口响应里哪些字段需要按角色授权后才能返回。

如果你只想先知道“我该用哪个方法”，看这张表就够了：

| 要做的事 | 管理端方法 | 记住一句话 |
|---|---|---|
| 给页面登记打开时调用的接口 | `menus.loadApis.add()` | 写 `resource: 'api:GET:/api/orders'`，不用写 `action`。 |
| 给按钮登记权限 | `menus.actions.create()` | 后端按钮用 `api:*`，纯前端按钮用 `ui:button:*`。 |
| 声明接口响应字段 | `menus.responses.set()` | 字段写在 `response.fields`，这里是响应 DTO 字段，不是数据库字段。 |
| 给角色分配字段 | `roles.menuPermissions.grant()` | 在 `responseFields` 中选择这个角色实际能看到的字段。 |
| 后端裁剪响应 | `subject.menus.filterResponse()` | 返回前裁剪响应；接口入口仍建议先用 `subject.assert()`。 |

## 使用前提

逐项配置接口和字段前，需要先有菜单配置、菜单和页面：

```ts
const scoped = pc.scope(
  { tenantId: 'acme', appId: 'admin' },
  { actorId: 'admin', requestId: 'req-api-bindings-save' },
);

// 这里假设已经创建好：
// configId: 'admin'
// menuId: 'orders'
// viewId: 'orders-list'
```

`orders-list` 是创建页面时写入的 `view.id`，不是 `loadApis.add()` 临时生成的名字。这个 ID 在同一套菜单配置内必须唯一；创建方式见[管理菜单](/zh/guide/menu-management)里的 `menus.views.create()` 示例。

完整流程通常是：

```text
创建菜单配置
-> 创建菜单
-> 创建页面 orders-list
-> 给页面添加默认加载接口
-> 给按钮添加接口或 UI 权限
-> 给接口配置响应字段
-> 给角色授权页面、接口、按钮和字段
-> 后端用 assert/filterResponse 或 Vext 保护接口
```

如果要让某个用户实际生效，还要在角色授权后通过 `userRoles.assign()` 或 `userRoles.set()` 把角色绑定给用户。

如果配置、页面或按钮还不存在，`menus.loadApis.add()`、`menus.actions.create()`、`menus.responses.set()` 会在预览或执行阶段失败。

## 页面默认接口

页面默认接口表示：用户打开某个页面时，这个页面需要调用的后端接口。

逐项配置时，对应 `menus.loadApis.add()` 的 `input.resource`。如果你使用高级的配置即代码入口，同一含义对应 `load.resource`；本页先讲后台逐项管理 API。

例如订单列表页打开时会请求：

```text
GET /api/orders
```

就把它登记为 `orders-list` 页面的 load API：

```ts
const added = await scoped.menus.loadApis.add('admin', 'orders-list', {
  resource: 'api:GET:/api/orders',
});
```

这段代码的意思是：

> 把 `GET /api/orders` 登记为 `admin` 配置中 `orders-list` 页面的默认加载接口。

参数说明：

| 参数 | 说明 |
|---|---|
| `'admin'` | 菜单配置 ID，表示修改哪一套后台菜单。 |
| `'orders-list'` | 页面/view ID，来自创建页面时的 `view.id`；同一菜单配置内唯一。 |
| `resource` | 接口资源，格式为 `api:METHOD:/path`。 |

操作者和请求 ID 已在 `pc.scope(scope, defaults)` 里绑定；单次调用只有在需要覆盖默认值时才传 `options`。

保存成功后，你不需要关心内部快照结构；只要理解这条记录会落在 `orders-list` 页面的加载接口里，也就是等价于配置里的 `views[].load[].resource = 'api:GET:/api/orders'`。

这条 load 会影响三处：

| 场景 | 影响 |
|---|---|
| 菜单配置 | 系统会把该接口登记到内部接口契约。 |
| 角色授权 | `include.loads: true` 时，角色会拿到 `invoke + api:GET:/api/orders`。 |
| 用户运行时 | `getViewState()` 会用页面加载接口判断页面是否可用。 |

接口资源不需要写 `action: 'invoke'`。`loadApis.add()` 会自动把 `api:GET:/api/orders` 编译成 `invoke + api:GET:/api/orders`。

路径中有参数时，使用路由模板：

```ts
{ resource: 'api:GET:/api/orders/:id' }
```

不要把具体业务 ID 写进资源：

```ts
// 不推荐
{ resource: 'api:GET:/api/orders/123' }
```

## 页面按钮和操作

按钮或操作表示：用户在页面里点击某个动作，例如导出、审核、删除、打开详情。

逐项配置时，对应 `menus.actions.create()` 的 `input.resource`。如果你使用高级的配置即代码入口，同一含义对应 `actions[].resource`。

如果按钮会调用后端接口，使用 `api:*`：

```ts
await scoped.menus.actions.create('admin', 'orders-list', {
  id: 'export',
  title: '导出订单',
  resource: 'api:POST:/api/orders/export',
});
```

这段代码的意思是：

> 在 `orders-list` 页面上创建一个“导出订单”按钮。用户有这个按钮权限时，才应该能看到或点击它；如果按钮调用后端，后端还要校验 `invoke + api:POST:/api/orders/export`。

如果按钮只是纯前端能力，不调用后端接口，使用 `ui:button:*`：

```ts
await scoped.menus.actions.create('admin', 'orders-list', {
  id: 'show-cost-column',
  title: '显示成本列',
  resource: 'ui:button:orders.show-cost-column',
});
```

两类按钮的区别：

| resource | 适合场景 | 后端是否需要接口鉴权 |
|---|---|---|
| `api:POST:/api/orders/export` | 点击后请求后端接口 | 需要 |
| `ui:button:orders.show-cost-column` | 只控制前端展示或交互 | 不需要 |

如果按钮只是打开弹窗，而弹窗里再请求接口，推荐把弹窗建成一个 `dialog` 或 `drawer` view，再给这个 view 配置自己的 load API。这样权限含义更清楚：

```text
按钮权限：能不能打开弹窗
弹窗页面权限：能不能进入弹窗视图
弹窗 load API：能不能请求弹窗里的数据接口
```

## 响应字段配置

响应字段配置回答的是：

> 这个接口返回的 DTO 里，哪些字段需要变成可授权字段？

注意区分两件事：

| 操作 | 作用 |
|---|---|
| `menus.responses.set()` | 声明“这个接口有哪些可授权字段”。 |
| `roles.menuPermissions.grant({ responseFields })` | 给某个角色分配“实际能返回哪些字段”。 |

也就是说，配置响应字段不等于用户已经能看到字段。角色没有字段授权时，字段仍会被裁剪。

### 响应字段挂在哪个接口上

`menus.responses.set()` 里的 `owner` 只是告诉系统：“这组字段属于哪一个接口响应”。新手优先按页面来源选择 `load` 或 `action`，别一开始就用 `api`。

| ownerType | 用途 | 示例 |
|---|---|---|
| `load` | 页面默认加载接口的响应字段 | 订单列表页的 `GET /api/orders` |
| `action` | 按钮接口的响应字段 | 导出按钮的 `POST /api/orders/export` |
| `api` | 按 API 资源查找来源 | 高级用法，通常放到配置即代码或迁移工具里 |

页面默认接口的字段配置：

```ts
const responseInput = {
  owner: {
    ownerType: 'load',
    viewId: 'orders-list',
    resource: 'api:GET:/api/orders',
  },
  response: {
    target: 'items',
    preserve: ['total'],
    fields: [
      { field: 'orderNo', title: '订单号' },
      { field: 'status', title: '状态' },
      { field: 'amount', title: '金额' },
    ],
  },
} as const;

await scoped.menus.responses.set('admin', responseInput);
```

这段代码的意思是：

> `api:GET:/api/orders` 返回分页数据，真正要裁剪的是 `items` 中每一行；`total` 是分页总数，保留但不参与字段授权；`orderNo/status/amount` 是可以分配给角色的字段。

这些普通新增/设置操作会自动完成内部预览并提交。管理端如果想先展示影响，可以改用对应的 `previewAdd()`、`previewCreate()` 或 `previewSet()`，确认后再带 `expected/previewToken` 执行。

参数说明：

| 参数 | 说明 |
|---|---|
| `owner.ownerType: 'load'` | 字段属于页面默认接口。 |
| `owner.viewId` | 页面 ID。 |
| `owner.resource` | 页面 load API 资源。 |
| `response.target` | 要裁剪的对象或数组路径。分页接口常用 `items` 或 `data.items`。 |
| `response.preserve` | 保留但不参与字段授权的外层字段，如 `total`、`cursor`。 |
| `response.fields[].field` | 响应 DTO 字段路径，不是数据库字段路径。 |
| `response.fields[].title` | 管理后台展示名。 |

保存后，这组字段会挂到 `api:GET:/api/orders` 的 `items` 响应目标上。后面给角色授权时，就从这里声明过的 `orderNo/status/amount` 里选择。

### 数组形式和对象形式

在 `MenuConfigInput.load[].response` 或 `actions[].response` 里，可以直接写数组：

```ts
response: [
  { field: 'orderNo', title: '订单号' },
  { field: 'buyer.name', title: '买家姓名' },
]
```

但在 `menus.responses.set()` 里，`response` 使用对象形式。即使没有 `target`，也要写成：

```ts
response: {
  fields: [
    { field: 'orderNo', title: '订单号' },
    { field: 'buyer.name', title: '买家姓名' },
  ],
}
```

如果接口返回分页结构：

```json
{
  "items": [{ "orderNo": "O-1001", "status": "paid", "amount": 88 }],
  "total": 1
}
```

推荐写：

```ts
response: {
  target: 'items',
  preserve: ['total'],
  fields: [
    { field: 'orderNo', title: '订单号' },
    { field: 'status', title: '状态' },
    { field: 'amount', title: '金额' },
  ],
}
```

不要把敏感业务字段放进 `preserve`，因为 `preserve` 不参与字段授权。

## 授权响应字段

声明字段之后，还要给角色授权字段。下面表示：

> `order-operator` 可以进入订单列表页，可以调用页面默认接口和按钮接口，但订单列表接口只返回 `orderNo` 和 `status`。

```ts
const selection = {
  configId: 'admin',
  views: ['orders-list'],
  responseFields: [{
    apiResource: 'api:GET:/api/orders',
    target: 'items',
    fields: ['orderNo', 'status'],
  }],
  include: {
    loads: true,
    actions: true,
    responseFields: 'none',
  },
};
```

`fields` 必须来自前面已经声明过的响应字段。分页或嵌套响应建议写 `target`，例如 `items` 或 `data.items`；同一个接口存在多个响应目标时，不写 `target` 会因为目标不明确而被 preview 拒绝。

默认不会自动全选响应字段。如果确实要给某角色全部字段，必须显式设置：

```ts
include: { responseFields: 'all' }
```

## 后端裁剪响应

响应字段必须在后端返回前裁剪，不应该只靠前端隐藏。

手写框架时，推荐把接口入口鉴权和响应字段裁剪分开写：

```ts
const subject = pc.forSubject({ userId: 'u-menu', scope });

await subject.assert('invoke', 'api:GET:/api/orders');

const payload = {
  items: [
    { orderNo: 'O-1001', status: 'paid', amount: 88, internalCost: 51 },
  ],
  total: 1,
  debug: true,
};

const projected = await subject.menus.filterResponse(
  'api:GET:/api/orders',
  payload,
);

return projected.data;
```

如果当前用户只有 `orderNo` 和 `status` 字段权限，`projected.data` 接近：

```json
{
  "items": [
    { "orderNo": "O-1001", "status": "paid" }
  ],
  "total": 1
}
```

职责边界：

| 方法 | 职责 |
|---|---|
| `subject.assert('invoke', apiResource)` | 保护接口入口。 |
| `subject.menus.filterResponse(apiResource, payload)` | 按当前用户字段授权裁剪响应。 |

`filterResponse()` 内部也会检查当前用户是否能 `invoke` 该 API；但业务接口仍建议先使用 `subject.assert()` 或框架守卫保护入口，这样失败点更清晰。

使用 Vext 插件时，受 `permission: true` 保护的路由可以自动做接口鉴权和响应字段投影；手写业务代码也可以显式调用 `req.auth.permission.filterResponse()`。详见[Vext 插件](/zh/guide/vext-plugin)。

## 未配置响应字段时会怎样

- 如果某个 API 没有配置 `response`，`filterResponse()` 在接口权限通过后会返回原始 payload。
- 如果某个 API 配置了 `response`，但当前用户没有字段授权，则只会保留 `preserve` 中声明的结构字段。
- 如果接口包含敏感字段，应该配置 `response` 并通过角色授权显式分配字段。

## 同一个接口被多个页面复用

同一个 `apiResource` 可以被多个页面或按钮复用，但响应结构需要兼容。

例如这些通常可以合并：

```text
orders-list    -> api:GET:/api/orders -> target: items
sales-orders   -> api:GET:/api/orders -> target: items
```

但如果同一个接口在不同页面声明了不同响应结构，例如一个是 `target: 'items'`，另一个是 `target: 'data.rows'`，预览可能会拒绝。遇到这种情况，优先考虑拆成不同 API，或者统一响应结构。

## 高级：配置即代码与批量导入

本页主线是后台逐项管理 API。如果你要从插件、CI/CD 或配置文件一次性导入整套菜单，请看[菜单配置即代码与批量导入](/zh/guide/menu-config-as-code)。

等价关系只有一条：`MenuConfigInput.load[].resource` 对应 `menus.loadApis.add()`，`MenuConfigInput.actions[].resource` 对应 `menus.actions.create()`，`MenuConfigInput.load[].response` 或 `MenuConfigInput.actions[].response` 对应 `menus.responses.set()`。

## 常见误区

| 误区 | 正确理解 |
|---|---|
| 需要先手动创建接口绑定 | 不需要。通过 `loadApis/actions/responses` 或 `MenuConfigInput` 声明接口后，系统会生成内部绑定。 |
| `load` 要写 `action: 'invoke'` | 不需要。`api:*` 会自动按 `invoke` 处理。 |
| `menus.responses.set()` 的 `response` 可以直接写数组 | 不可以。逐项 API 使用对象形式：`response: { fields: [...] }`。数组形式主要用于 `MenuConfigInput`。 |
| 配置了响应字段，用户就能看到这些字段 | 不会。字段还要通过角色菜单授权分配。 |
| 角色选中页面就自动返回所有字段 | 不会。默认不给响应字段；必须显式选择字段或设置 `include.responseFields: 'all'`。 |
| `filterResponse()` 直接返回业务对象 | 不是。裁剪后的业务数据在 `projected.data`。 |
| 响应字段只影响前端展示 | 不对。它应该在后端返回前通过 `filterResponse()` 裁剪。 |
| `preserve` 可以放任何字段 | 不建议。`preserve` 是总数/游标这类外层结构字段，不是业务字段授权。 |

精确字段约束见[配置接口与响应字段 API](/zh/api/api-bindings)，完整流程见[管理菜单](/zh/guide/menu-management)和[角色菜单授权](/zh/guide/role-menu-authorization)。
