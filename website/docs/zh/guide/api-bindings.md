# 配置接口与响应字段

在新版菜单模型里，业务侧不再直接维护公开的接口绑定管理 API。后台页面可以用 `menus.loadApis`、`menus.actions`、`menus.responses` 逐项配置接口和字段；配置即代码场景也可以在 `MenuConfigInput` 里写 `load`、`actions` 和 `response`。保存时 permission-core 会自动生成内部接口契约，并把它们用于角色菜单授权、Vext 路由守卫和响应字段投影。

## 页面加载接口

页面进入时要调用的接口写在 `views[].load[]`：

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

`load.resource` 必须是 `ApiResource`，格式是 `api:METHOD:/path`。这里不需要写 `action: 'invoke'`；系统会自动把 load 编译成 `invoke + api:GET:/api/orders`。

后台页面逐项保存时，对应方法是：

```ts
const preview = await scoped.menus.loadApis.previewAdd('admin', 'orders-list', {
  resource: 'api:GET:/api/orders',
});

await scoped.menus.loadApis.add('admin', 'orders-list', {
  resource: 'api:GET:/api/orders',
}, {
  ...preview.expected,
  previewToken: preview.previewToken,
  actorId: 'admin',
});
```

这条 load 会影响三处：

| 场景 | 影响 |
|---|---|
| 菜单保存 | `menus.loadApis.add()`、`menus.responses.set()` 或 `menus.config.save()` 会把该接口登记到内部契约。 |
| 角色授权 | `include.loads: true` 时会把该接口调用权限授给角色。 |
| 用户运行时 | `getViewState()` 会用接口权限判断页面是否可用；`filterResponse()` 会按响应字段裁剪返回值。 |

## 页面按钮和操作

页面内按钮、工具栏动作、行操作写在 `views[].actions[]`：

```ts
actions: [{
  id: 'export',
  title: '导出订单',
  resource: 'api:POST:/api/orders/export',
  response: [{ field: 'downloadUrl', title: '下载地址' }],
}]
```

`actions[].resource` 可以是后端接口，也可以是纯前端 UI 资源：

| 资源 | 适合场景 |
|---|---|
| `api:POST:/api/orders/export` | 点击后会请求后端接口，应该由后端鉴权。 |
| `ui:button:orders.export` | 纯前端能力，例如只控制按钮展示，后端没有对应接口。 |

如果按钮调用后端，优先使用 `api:`。这样 `roles.menuPermissions.grant()` 勾选 `include.actions: true` 后，角色会同时拿到按钮状态和接口调用能力。

后台页面逐项保存时，对应方法是 `menus.actions.previewCreate()` / `menus.actions.create()`。按钮如果是 `ui:button:*` 纯前端资源，不能配置 `response`；只有 `api:*` 接口才有响应字段。

## 响应字段配置

响应字段有两种写法。

对象或数组直接裁剪：

```ts
response: [
  { field: 'orderNo', title: '订单号' },
  { field: 'buyer.name', title: '买家姓名' },
]
```

分页响应裁剪：

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

`field` 支持点路径，例如 `buyer.name`。`target` 也支持点路径，例如 `data.items`。`preserve` 适合保留分页总数、游标、状态码等外层字段，但不要把敏感业务字段放进 `preserve`，因为它不参与字段授权。

后台页面逐项保存响应字段时，对应方法是：

```ts
const preview = await scoped.menus.responses.previewSet('admin', {
  owner: { ownerType: 'load', viewId: 'orders-list', resource: 'api:GET:/api/orders' },
  response: {
    target: 'items',
    preserve: ['total'],
    fields: [
      { field: 'orderNo', title: '订单号' },
      { field: 'status', title: '状态' },
    ],
  },
});

await scoped.menus.responses.set('admin', {
  owner: { ownerType: 'load', viewId: 'orders-list', resource: 'api:GET:/api/orders' },
  response: {
    target: 'items',
    preserve: ['total'],
    fields: [
      { field: 'orderNo', title: '订单号' },
      { field: 'status', title: '状态' },
    ],
  },
}, {
  ...preview.expected,
  previewToken: preview.previewToken,
  actorId: 'admin',
});
```

## 授权响应字段

配置里声明字段后，还需要在角色菜单授权里选择字段：

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
```

`fields` 必须来自配置中已经声明的字段。分页或嵌套响应建议写 `target`，例如 `items` 或 `data.items`；同一个接口存在多个响应目标时，不写 `target` 会因为目标不明确而被 preview 拒绝。不要给角色分配配置里不存在的字段。

## 后端裁剪响应

接口处理器返回前调用：

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

`filterResponse()` 会先执行接口权限检查。当前用户没有 `invoke + api:GET:/api/orders` 时，它会失败；当前用户有接口权限但只被授权部分字段时，它只返回这些字段。

在 Vext 插件里，受 `permission: true` 保护的路由会自动对 `res.json()` 做响应字段投影；手写业务代码也可以显式调用 `req.auth.permission.filterResponse()`。详见[Vext 插件](/zh/guide/vext-plugin)。

## 后端接口仍要鉴权

响应字段投影不是路由鉴权的替代品。业务接口仍应先保护入口：

```ts
const subject = pc.forSubject({ userId: 'u-menu', scope });
await subject.assert('invoke', 'api:GET:/api/orders');
const projected = await subject.menus.filterResponse('api:GET:/api/orders', payload);
```

如果使用 Vext 插件，`permission: true` 会用路由的 method/path 自动检查 `invoke + api:METHOD:/path`。如果不使用 Vext，就在自己的框架中调用 `subject.assert()`。

## 常见误区

| 误区 | 正确理解 |
|---|---|
| 需要先创建接口绑定，再写菜单 | 不需要。现在通过 `menus.loadApis/actions/responses` 或 `MenuConfigInput` 声明接口，内部绑定由系统生成。 |
| 只能写完整 `MenuConfigInput` | 不需要。后台页面优先用 `menus.loadApis/actions/responses` 逐项维护。 |
| `load` 要写 action | 不需要。`load.resource` 自动补成 `invoke`。 |
| 角色选中页面就自动返回所有字段 | 不会。默认不给响应字段；必须显式选择字段或设置 `include.responseFields: 'all'`。 |
| 响应字段只影响前端展示 | 不对。它应该在后端返回前通过 `filterResponse()` 裁剪。 |
| `preserve` 可以放任何字段 | 不建议。`preserve` 是总数/游标这类外层结构字段，不是业务字段授权。 |

精确字段约束见[配置接口与响应字段 API](/zh/api/api-bindings)，完整流程见[管理菜单](/zh/guide/menu-management)。
