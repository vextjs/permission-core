# 快速开始

这条路径从宿主持有的 MonSQLize 连接开始，在第 1～4 步得到第一次权限决策，再继续加入菜单和数据权限。第 1～4 步的可运行源码位于 [`examples/basic.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/basic.mjs)，第 5 步位于 [`examples/menu-admin.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/menu-admin.mjs)，第 6 步位于 [`examples/data-guard.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/data-guard.mjs)。

## 1. 安装并初始化

使用 Node.js 18 或更高版本，并准备可用的 MongoDB。

```bash
npm install permission-core monsqlize@3.1.0
```

```ts
import MonSQLize from 'monsqlize';
import { PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://127.0.0.1:27017' },
});
await msq.connect();

const pc = new PermissionCore({
  monsqlize: msq,
  tokenSecret: 'replace-with-a-host-secret-at-least-32-bytes',
});
const health = await pc.init();
```

`tokenSecret` 至少需要包含 32 个 UTF-8 字节。共享同一权限命名空间的实例应使用相同的宿主配置值，这样 preview 和 cursor token 才能跨实例、跨重启保持有效。

`init()` 会创建并核验权限索引，同时确认数据库支持事务。成功响应中的关键字段如下：

```json
{
  "status": "up",
  "lifecycle": "ready",
  "initialized": true,
  "database": { "status": "up" }
}
```

`msq` 的所有者是宿主。后续关闭 permission-core 不会顺带关闭这个连接。

## 2. 创建角色、规则和用户绑定

所有管理 API 都绑定到 scope；scope 至少包含 `tenantId`。

```ts
const scope = { tenantId: 'acme' };
const scoped = pc.scope(scope);

const created = await scoped.roles.create({
  id: 'order-reader',
  label: 'Order reader',
});
const rule = await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'GET:/api/orders',
});
const assigned = await scoped.userRoles.assign('u-1', 'order-reader');
```

每个写方法都会返回已提交数据、修订向量、审计 ID 和缓存结果。以下对象从三个独立变更响应中提取本流程使用的值：

```json
{
  "created": { "changed": true, "role": { "id": "order-reader", "revision": 1 } },
  "rule": { "effect": "allow", "action": "invoke", "resource": "GET:/api/orders" },
  "assigned": { "userId": "u-1", "roleIds": ["order-reader"], "revision": 1 }
}
```

`assign(userId, roleId)` 增量添加一个直接角色。`set(userId, roleIds, { expectedRevision })` 会替换用户的完整直接角色集合，适合管理后台保存全量勾选结果。

## 3. 检查允许和阻止的操作

把可信用户和 scope 绑定一次，再对这个 subject 做判断。

```ts
const subject = pc.forSubject({ userId: 'u-1', scope });

const allowed = await subject.can('invoke', 'GET:/api/orders');
const cannotDelete = await subject.cannot('invoke', 'DELETE:/api/orders');
```

```json
{
  "allowed": true,
  "cannotDelete": true
}
```

角色没有 `DELETE:/api/orders` 规则，所以 DELETE 的 `can(...)` 为 `false`，`cannot(...)` 为 `true`。`cannot` 就是 `can` 的逻辑取反，并不是给用户分配了另一条“阻止权限”。只有需要显式拒绝规则时才调用 `deny`。

## 4. 读取角色和有效权限

以下读取方法可直接支撑角色详情、用户详情和诊断页面，应用不需要自行重建继承逻辑。

```ts
const role = await scoped.roles.get('order-reader');
const ownRules = await scoped.roles.getOwnRules('order-reader');
const effectiveRules = await scoped.roles.getEffectiveRules('order-reader');
const chain = await scoped.roles.getChain('order-reader');
const directRoles = await scoped.userRoles.getDirect('u-1');
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
const permissions = await subject.getPermissions();
const resources = await subject.getResources('invoke');
```

```json
{
  "role": { "id": "order-reader", "label": "Order reader", "revision": 2 },
  "directRoleIds": ["order-reader"],
  "effectiveRoleIds": ["order-reader"],
  "ownRules": ["allow:invoke:GET:/api/orders"],
  "effectiveRules": ["allow:invoke:GET:/api/orders"],
  "roleChain": ["order-reader"],
  "permissionRuleCount": 1,
  "resources": ["GET:/api/orders"]
}
```

第 1～4 步构成独立的 First Success 路径。在本仓库执行 `npm run docs:first-success`，可以用新打包的消费者复证同一流程。

## 5. 添加菜单、接口绑定和角色授权

菜单节点描述导航或按钮，接口绑定描述由一个或多个节点拥有的真实后端接口；角色菜单授权会把选中的结构转换成权限规则。

```ts
await scoped.menus.create({
  id: 'operations', type: 'directory', title: 'Operations',
});
await scoped.menus.create({
  id: 'orders', parentId: 'operations', type: 'page', title: 'Orders',
  path: '/orders', name: 'orders', component: 'OrdersPage',
  permission: { action: 'read', resource: 'ui:page:orders' },
});
await scoped.menus.create({
  id: 'orders-export', parentId: 'orders', type: 'button',
  title: 'Export orders', code: 'orders.export',
  permission: { action: 'invoke', resource: 'ui:button:orders.export' },
});
await scoped.apiBindings.create({
  id: 'orders-export-api', method: 'POST', path: '/api/orders/export',
  purpose: 'importExport',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:POST:/api/orders/export' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
  canonicalOwner: { type: 'button', id: 'orders-export' },
});

const selection = {
  nodeIds: ['orders'],
  include: { descendants: true, buttons: true, apis: 'required', dataPermissions: false },
  apiChoices: { bindingIds: [], permissionsByBinding: {} },
};
const preview = await scoped.roles.menuPermissions.preview(
  'order-reader',
  { operation: 'grant', selection },
);
if (!preview.executable) throw new Error('Resolve preview conflicts first');
await scoped.roles.menuPermissions.grant('order-reader', selection, {
  ...preview.expected,
  previewToken: preview.previewToken,
});

const visible = await subject.menus.getVisibleTree();
const buttons = await subject.menus.getButtonMap('orders');
```

```json
{
  "visibleNodeIds": ["operations", "orders"],
  "buttons": {
    "orders.export": { "visible": true, "enabled": true, "reason": "allowed" }
  }
}
```

前端可见状态只改善导航体验，并不是后端安全边界。导出接口仍必须检查 `api:POST:/api/orders/export`。

## 6. 添加行级和字段级权限

先给集合规则添加动态行条件，再授权查询和投影使用的字段，并显式拒绝 secret 字段。

```ts
await scoped.roles.allow('order-reader', {
  action: 'read',
  resource: 'db:orders',
  where: { field: 'merchantId', op: 'eq', valueFrom: 'claims.merchantId' },
});
for (const field of ['merchantId', 'status', 'publicValue']) {
  await scoped.roles.allow('order-reader', {
    action: 'read', resource: `db:orders:field:${field}`,
  });
}
await scoped.roles.deny('order-reader', {
  action: 'read', resource: 'db:orders:field:secret',
});

const dataSubject = pc.forSubject({
  userId: 'u-1',
  scope,
  claims: { merchantId: 'm-1' },
});
const orders = dataSubject.data.collection('orders', {
  resource: 'db:orders',
  scopeFields: { tenantId: 'tenantId' },
});
const rows = await orders.find(
  { status: 'paid' },
  { projection: ['merchantId', 'publicValue'] },
);
```

假设数据库中有以下两行：

```json
[
  { "tenantId": "acme", "merchantId": "m-1", "status": "paid", "publicValue": "shown", "secret": "hidden" },
  { "tenantId": "acme", "merchantId": "m-2", "status": "paid", "publicValue": "other merchant", "secret": "hidden" }
]
```

授权后的返回结果是：

```json
[
  { "merchantId": "m-1", "publicValue": "shown" }
]
```

运行时自动组合调用方的 Mongo filter、精确租户条件、所有适用行规则和字段授权，不会只返回一个查询条件让调用方自行决定是否应用。

## 7. 按所有权顺序关闭

```ts
await pc.close();
await msq.close();
```

先停止新的权限操作并让 permission-core 完成排空，再由宿主关闭 MonSQLize。若要继续处理授权判定，请阅读[检查权限](/zh/guide/check-permission)；若要处理数据库访问，请阅读[数据权限](/zh/guide/data-permissions)。
