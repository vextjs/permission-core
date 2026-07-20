# 绑定接口

接口绑定把真实后端 endpoint 连接到使用它的菜单、页面或按钮，同时回答两个独立问题：接口需要哪些权限，以及接口不可调用时是否应禁用它的 UI owner。

## 与菜单如何关联

菜单节点先定义 UI 结构：页面、菜单和按钮各自有稳定 `id`，按钮还会有前端使用的 `code`。接口绑定不会挂在路由字符串上，而是通过 `owners` 指向这些菜单对象：

```ts
owners: [
  { type: 'button', id: 'orders-export', required: true },
],
canonicalOwner: { type: 'button', id: 'orders-export' },
```

这表示 `/api/orders/export` 是 `orders-export` 按钮使用的真实后端接口。`owners` 决定运行时可用性：当当前 subject 缺少 binding 的 `authorization` 权限时，`required: true` 的 owner 会被投影为不可用，例如按钮 `enabled=false`、`reason='api-unavailable'`。`canonicalOwner` 只是主要管理归属，必须也出现在 `owners` 中；它不会替代 owner 列表，也不会自动给角色授权。

角色菜单授权会读取菜单节点和这些 owner 关系。管理员选择 `orders` 页面并包含 `buttons/apis` 时，preview 会把页面、按钮、关联 API binding 和数据模板展开成带来源的角色规则；执行 grant 后，用户通过角色绑定同时获得可见菜单、按钮状态和后端 `api:` 权限。完整选择流程见[角色菜单授权](/zh/guide/role-menu-authorization)。

在菜单场景里，`authorization.permissions` 建议只表达“是否允许调用这个 endpoint”，也就是 `api:*` 权限。不要把 `db:*` 数据权限混进接口绑定；页面或按钮关联的数据权限模板放在菜单节点的 `dataPermissions`，真实数据范围仍由数据权限或数据层查询负责。

## 绑定结构

以下示例承接[管理菜单](/zh/guide/menu-management)：当前 scope 中已经存在 `orders` 页面，以及其子按钮 `id='orders-export'`、`code='orders.export'`。owner 不存在时 `create()` 会拒绝写入。

```ts
const created = await scoped.apiBindings.create({
  id: 'orders-export-api',
  method: 'POST',
  path: '/api/orders/export',
  purpose: 'importExport',
  authorization: {
    mode: 'all',
    permissions: [
      { action: 'invoke', resource: 'api:POST:/api/orders/export' },
    ],
  },
  owners: [
    { type: 'button', id: 'orders-export', required: true },
  ],
  canonicalOwner: { type: 'button', id: 'orders-export' },
});
```

```json
{
  "changed": true,
  "data": {
    "id": "orders-export-api",
    "method": "POST",
    "path": "/api/orders/export",
    "purpose": "importExport",
    "revision": 1
  }
}
```

这是 `apiBindings.create()` 原始 `MutationResult<ApiBinding>` 的节选；完整响应还含 scope revisions、operation/audit/cache/warnings/detailBudget。

| 输入部分 | 本例含义 | 容易混淆的边界 |
|---|---|---|
| `method/path` | 唯一 endpoint 契约，method 会规范为大写 | 不是权限本身；后端仍按 authorization 执行检查 |
| `authorization` | 调用 endpoint 需要具备 `api:POST:/api/orders/export` | 入门场景只放 `api:*` 调用权限；不要把数据权限写进这里 |
| `owners` | binding 属于 export button，并且不可调用时应禁用按钮 | 一个 binding 可有多个 owner；一个 owner 也可有多个 bindings |
| `canonicalOwner` | 主要管理归属 | 必须同时出现在 owners，但不会删除其他 owners |
| [`create(input, options?)`](/zh/api/api-bindings#api-bindings-create) | 写入完整 binding | 不会自动给角色授权；返回 `data.revision` 供后续管理 |

`authorization.mode: 'all'` 要求全部权限，`'any'` 要求至少一个。`canonicalOwner` 标识主要文档和管理归属，但不会删除其他 owner 关系。

## 一个按钮对应多个接口

每个真实 endpoint 创建一条绑定，并让它们指向同一个按钮，从而保留接口级审计和权限语义。

```ts
await scoped.apiBindings.create({
  id: 'orders-export-start',
  method: 'POST',
  path: '/api/orders/exports',
  purpose: 'operation',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:POST:/api/orders/exports' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
});
await scoped.apiBindings.create({
  id: 'orders-export-download',
  method: 'GET',
  path: '/api/orders/exports/:id',
  purpose: 'detail',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:GET:/api/orders/exports/:id' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
});
```

两个 `create()` 各自返回一个 mutation envelope，示例故意省略变量，只突出“一条真实 endpoint 对应一条 binding”。保存后可分别用 `get('orders-export-start')` 和 `get('orders-export-download')` 验证规范化结果。

每个未分组的 `required: true` 绑定都必须可用，否则按钮被禁用。可选关系仍出现在 `apiRisks`，但不会禁用 owner。

多个 endpoint 互为替代时，可在必需 owner 关系上设置相同 `availabilityGroup` 和 `availabilityMode: 'any'`。角色授权必须通过 `apiChoices.bindingIds` 明确选择。若某条绑定自身的 authorization mode 为 `any`，则用 `apiChoices.permissionsByBinding` 至少选择一项要求。预览会返回未解决选择，而不是自行猜测。

## 读取与更新绑定

使用 `get`、游标式 `list`，并按 `method`、`path`、`status`、`purpose` 或 `ownerId` 过滤。只修改描述或 purpose 时使用 `expectedRevision`：

```ts
const current = await scoped.apiBindings.get('orders-export-api');
const updated = await scoped.apiBindings.update(
  'orders-export-api',
  { description: 'Starts an order export' },
  { expectedRevision: current.data.revision },
);
```

| 方法 | 参数 | 原始返回/状态 |
|---|---|---|
| [`get(bindingId)`](/zh/api/api-bindings#api-bindings-get) | binding ID | `VersionedResult<ApiBinding>`；`current.data.revision` 是并发基线 |
| [`list(query?)`](/zh/api/api-bindings#api-bindings-list) | 可按 method/path/status/purpose/ownerId + first/after 过滤 | `PageResult<ApiBinding>`，只读 |
| [`update(bindingId, patch, options)`](/zh/api/api-bindings#api-bindings-update) | patch 仅 purpose/description；expectedRevision 必填 | `MutationResult<ApiBinding>`；本例的新状态在 `updated.data` |
| [`previewUpdate/executeUpdate`](/zh/api/api-bindings#api-bindings-preview-update) | 用于 method/path/authorization/owners/canonicalOwner | 先返回影响计划，再凭 token 写入并处理角色来源 |

修改 method、path、authorization、owners 或 canonical owner 可能让角色生成来源失效，必须带明确来源重写决定调用 `previewUpdate` 和 `executeUpdate`。状态变更、移除和完整替换也都有影响预览。

## 运行时可用性

subject 菜单投影会用同一用户评估每个已启用绑定的 authorization 要求，并给 owner 返回有界风险项：

```ts
const subject = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme', appId: 'admin' },
});
const buttonMap = await subject.menus.getButtonMap('orders');
const exportButton = buttonMap.data['orders.export'];
```

```json
{
  "orders.export": {
    "visible": true,
    "enabled": false,
    "reason": "api-unavailable",
    "apiRisks": {
      "items": [
        { "bindingId": "orders-export-api", "required": true, "allowed": false }
      ]
    }
  }
}
```

展示的 JSON 是 `buttonMap.data` 的节选，不是 `getButtonMap()` 最外层原始结构；原始结构还包含 `detailBudget`。参数 `orders` 是 owner page/menu 的节点 ID，返回对象键 `orders.export` 才是 button code。精确响应见[`subject.menus.getButtonMap()`](/zh/api/menus#subject-menus-get-button-map)。

该状态只是体验投影。后端接口仍必须通过 `subject.assert` 或 Vext 路由守卫独立检查相同 `api:` 权限。

下一步通过[角色菜单授权](/zh/guide/role-menu-authorization)按菜单选择给角色分配绑定，精确方法见[接口绑定 API](/zh/api/api-bindings)。
