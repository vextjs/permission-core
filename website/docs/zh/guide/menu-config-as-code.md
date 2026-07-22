# 菜单配置即代码与批量导入

这页是高级用法，适合插件安装、CI/CD、应用升级或配置文件一次性导入完整菜单。

如果你正在做普通后台管理页面，优先使用逐项方法：`menus.configs/items/views/loadApis/actions/responses`。那条路径更直观，见[管理菜单](/zh/guide/menu-management)。如果你只是想理解 `load`、`actions` 和 `response` 分别做什么，见[接口与响应字段](/zh/guide/api-bindings)。

## 什么时候用 MenuConfigInput

`MenuConfigInput` 表示“我已经准备好一整套菜单配置，现在要整体保存”。它不适合普通表单每改一个字段就调用一次。

| 场景 | 是否适合 |
|---|---|
| 插件安装时注册一个模块的菜单 | 适合 |
| CI/CD 发布时导入完整后台菜单 | 适合 |
| 从 JSON/YAML 配置包恢复菜单 | 适合 |
| 后台页面逐项新增菜单、页面、按钮 | 不优先；用逐项方法更清楚 |
| 用户拖拽菜单树后保存一个小改动 | 不优先；用 `menus.management.applyChanges()` 更合适 |

## 完整配置示例

一份完整配置可以同时声明菜单、页面、页面加载接口、按钮和响应字段：

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

## 字段说明

这份配置表达这些事：

| 字段 | 表达什么 | 运行时影响 |
|---|---|---|
| `configId` | 一套菜单配置的稳定 ID | 后续授权和运行时读取都用它定位这一套后台菜单。 |
| `menus[]` | 左侧导航分组 | 分组本身不是接口权限；通常用于组织页面。 |
| `views[]` | 可打开的页面、抽屉、弹窗或 tab | `getViewTree()` 和 `getViewState()` 会按用户权限投影这些视图。 |
| `load[].resource` | 页面进入时需要调用的接口 | 只写 `api:METHOD:/path`；省略 action，系统自动补成 `invoke`。 |
| `actions[].resource` | 页面按钮或操作调用的接口 | 支持 `api:*` 后端接口，也支持 `ui:*` 前端纯按钮资源。 |
| `response` | 允许返回给前端的字段清单 | 授权角色后，`filterResponse()` 会按用户拥有的字段裁剪响应。 |

`load.resource` 必须是 `api:` 资源，例如 `api:GET:/api/orders`。这样 Vext 路由守卫、角色菜单授权和响应字段投影才能使用同一份资源 ID。`actions[].resource` 可以是后端接口，也可以是纯 UI 资源；如果是接口，同样建议使用 `api:`。

## 响应字段写法

在 `MenuConfigInput` 里，响应字段支持数组，也支持对象形式：

```ts
response: [
  { field: 'orderNo', title: '订单号' },
  { field: 'buyer.name', title: '买家姓名' },
]
```

数组形式适合接口直接返回一条对象或对象数组。字段名支持点路径，例如 `buyer.name`。

如果接口返回分页结构，使用对象形式：

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

`target` 表示要裁剪的数组字段，`preserve` 表示保留但不参与字段授权的外层字段。上例会裁剪 `items` 中每一行，只保留 `total` 作为分页信息。

注意：数组形式只适用于 `MenuConfigInput` 的内联配置。如果你用逐项方法 `menus.responses.set()`，即使没有 `target`，也要写成 `response: { fields: [...] }`。

## 预览并保存完整配置

`menus.config.preview(config)` 只计算影响，不写数据库；`menus.config.save(config, options)` 才会写入完整配置。

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

执行时必须带上预览返回的 `expected` 和 `previewToken`，避免管理员保存一份已经过期的菜单模型。

## 修改、删除和批量变更

读取、删除和批量变更都走 `menus.config` 高级入口：

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

单次保存适合导入一套完整菜单；`menus.config.previewChanges()` / `menus.config.applyChanges()` 适合一次提交多个模块菜单，例如插件安装、应用升级或导入配置包。

保存配置后，角色仍然没有权限。如果还没理解页面接口、按钮接口和响应字段，先看[接口与响应字段](/zh/guide/api-bindings)；下一步通常是进入[角色菜单授权](/zh/guide/role-menu-authorization)，把页面、接口、按钮和响应字段分配给角色。
