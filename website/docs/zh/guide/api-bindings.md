# 绑定接口

接口绑定把真实后端 endpoint 连接到使用它的菜单、页面或按钮，同时回答两个独立问题：接口需要哪些权限，以及接口不可调用时是否应禁用它的 UI owner。

## 绑定结构

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
      { action: 'read', resource: 'db:orders' },
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

每个未分组的 `required: true` 绑定都必须可用，否则按钮被禁用。可选关系仍出现在 `apiRisks`，但不会禁用 owner。

多个 endpoint 互为替代时，可在必需 owner 关系上设置相同 `availabilityGroup` 和 `availabilityMode: 'any'`。角色授权必须通过 `apiChoices.bindingIds` 明确选择。若某条绑定自身的 authorization mode 为 `any`，则用 `apiChoices.permissionsByBinding` 至少选择一项要求。预览会返回未解决选择，而不是自行猜测。

## 读取与更新绑定

使用 `get`、游标式 `list`，并按 `method`、`path`、`status`、`purpose` 或 `ownerId` 过滤。只修改描述或 purpose 时使用 `expectedRevision`：

```ts
const current = await scoped.apiBindings.get('orders-export-api');
await scoped.apiBindings.update(
  'orders-export-api',
  { description: 'Starts an order export' },
  { expectedRevision: current.data.revision },
);
```

修改 method、path、authorization、owners 或 canonical owner 可能让角色生成来源失效，必须带明确来源重写决定调用 `previewUpdate` 和 `executeUpdate`。状态变更、移除和完整替换也都有影响预览。

## 运行时可用性

subject 菜单投影会用同一用户评估每个已启用绑定的 authorization 要求，并给 owner 返回有界风险项：

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

该状态只是体验投影。后端接口仍必须通过 `subject.assert` 或 Vext 路由守卫独立检查相同 `api:` 权限。

下一步通过[角色菜单授权](/zh/guide/role-menu-authorization)按菜单选择给角色分配绑定，精确方法见[接口绑定 API](/zh/api/api-bindings)。
