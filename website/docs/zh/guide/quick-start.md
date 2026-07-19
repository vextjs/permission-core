# 快速开始

这条路径从宿主持有的 MonSQLize 连接开始，在第 1～4 步得到第一次权限决策，再继续加入菜单和数据权限。第 1～4 步的可运行源码位于 [`examples/basic.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/basic.mjs)，第 5 步位于 [`examples/menu-admin.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/menu-admin.mjs)，第 6 步位于 [`examples/data-guard.mjs`](https://github.com/vextjs/permission-core/blob/main/examples/data-guard.mjs)。

> 第 1～4 步是必须先完成的核心路径。第 5～6 步是可选扩展，不需要为了完成第一次鉴权一次学完菜单和数据权限。

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

这段代码里有四个不同职责：

| 对象/方法 | 做什么 | 谁负责关闭 |
|---|---|---|
| `new MonSQLize(...)` | 配置宿主数据库客户端 | 宿主 |
| `msq.connect()` | 建立 MongoDB 连接 | 宿主最终调用 `msq.close()` |
| `new PermissionCore(options)` | 创建权限核心并校验配置 | 宿主最终调用 `pc.close()` |
| `pc.init()` | 创建/核验权限 schema、索引、事务和可选缓存 | 返回健康状态，不返回角色或权限 |

`PermissionCore` 构造字段、默认值和限制见[核心与公共合同](/zh/api/core-and-contexts#permission-core-options)。

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

| 调用 | 参数分别表示什么 | 会改变什么 | 原始返回中本步使用的字段 |
|---|---|---|---|
| `pc.scope(scope)` | `scope.tenantId='acme'` 是权限隔离域 | 不写数据库，只创建管理上下文 | `scoped.roles/userRoles/...` |
| `roles.create(input)` | `id` 是稳定角色 ID；`label` 是展示名称 | 新增角色并推进角色 revision | `created.data.id`、`created.data.revision` |
| `roles.allow(roleId, rule)` | 第一个参数选择角色；rule 的 `action/resource` 描述允许的操作 | 给角色追加手工 allow 规则 | `rule.data.effect/action/resource` |
| `userRoles.assign(userId, roleId)` | 把已存在角色增量绑定给用户 | 更新用户直接角色集合 | `assigned.data.roleIds`、`assigned.data.revision` |

这里的 `userId='u-1'` 只是宿主用户 ID。permission-core 不创建该用户，也不处理登录。

每个写方法都会返回已提交数据、修订向量、审计 ID 和缓存结果。下面是从 `created`、`rule`、`assigned` 三个**原始 `MutationResult`** 中提取的示例汇总，不是某一个方法直接返回的 JSON：

```json
{
  "created": { "changed": true, "role": { "id": "order-reader", "revision": 1 } },
  "rule": { "effect": "allow", "action": "invoke", "resource": "GET:/api/orders" },
  "assigned": { "userId": "u-1", "roleIds": ["order-reader"], "revision": 1 }
}
```

`assign(userId, roleId)` 增量添加一个直接角色。`set(userId, roleIds, { expectedRevision })` 会替换用户的完整直接角色集合，适合管理后台保存全量勾选结果。完整差异、参数和响应见[用户角色 API](/zh/api/user-roles#user-roles-assign-vs-set)。

## 3. 检查允许和阻止的操作

把可信用户和 scope 绑定一次，再对这个 subject 做判断。

```ts
const subject = pc.forSubject({ userId: 'u-1', scope });

const allowed = await subject.can('invoke', 'GET:/api/orders');
const cannotDelete = await subject.cannot('invoke', 'DELETE:/api/orders');
```

| 调用 | 参数 | 返回 | 什么时候用 |
|---|---|---|---|
| `pc.forSubject({ userId, scope })` | 可信用户 ID 和完整 scope | `SubjectPermissionContext` | 一个请求内连续做多个权限判断时先绑定一次。 |
| `subject.can(action, resource)` | 要执行的 action 与具体资源 | `true` 表示允许 | 普通 `if` 分支和后端 guard。 |
| `subject.cannot(action, resource)` | 与 `can` 相同 | `true` 表示不能执行 | 变量/条件本身以 blocked/forbidden 表达时。 |
| `subject.assert(action, resource)` | 与 `can` 相同 | 允许时 `void`，拒绝时抛 `PERMISSION_DENIED` | 希望拒绝立即中断业务流程时。 |
| `subject.explain(action, resource)` | 与 `can` 相同 | 带 `allowed/reason/evaluations` 的诊断 envelope | 需要回答“为什么拒绝”时。 |

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

这些方法读取的是不同层次，不能互相替代：

| 方法 | 回答的问题 | 关键原始返回 |
|---|---|---|
| `roles.get(roleId)` | 角色本身叫什么、状态和 revision 是什么 | `VersionedResult<Role>.data` |
| `roles.getOwnRules(roleId)` | 角色自己直接拥有哪些规则 | `data: PermissionRuleView[]` |
| `roles.getEffectiveRules(roleId)` | 加上父角色后最终有哪些规则和冲突 | `data.chain/rules/conflicts` |
| `roles.getChain(roleId)` | 父角色链有哪些节点、哪些被排除 | `data: RoleChainEntry[]` |
| `userRoles.getDirect(userId)` | 后台可编辑的直接角色集合是什么 | `data.roleIds/revision` |
| `userRoles.getEffective(userId)` | 展开父角色后哪些角色实际参与授权 | `data.direct/effective` |
| `subject.getPermissions()` | 该用户最终有哪些角色、规则和冲突 | `data.directRoleIds/roles/rules/conflicts` |
| `subject.getResources(action?)` | 某 action 下有哪些有效资源模式 | `data: EffectiveResourcePattern[]` |

下面仍然是把八个读取结果整理后的**页面汇总输出**，不是任何单个读取方法的原始响应：

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

`directRoleIds` 来自 `getDirect`，`effectiveRoleIds` 来自 `getEffective`；`ownRules` 与 `effectiveRules` 的差异用于解释继承；`permissionRuleCount/resources` 来自 subject 视角。需要把这些值用于后台页面时，应读取上表所列原始 envelope，而不是假设方法直接返回这个汇总对象。

第 1～4 步构成独立的 First Success 路径。在本仓库执行 `npm run docs:first-success`，可以用新打包的消费者复证同一流程。

## 5. 添加菜单、接口绑定和角色授权

菜单节点描述导航或按钮，接口绑定描述由一个或多个节点拥有的真实后端接口；角色菜单授权会把选中的结构转换成权限规则。

这一节是可选扩展。先认识四类对象：

| 对象 | 关键字段 | 含义 |
|---|---|---|
| menu node | `id/type/parentId/title/path/code/permission` | directory 组织层级，page 描述路由，button 描述按钮；permission 是该节点自身要求。 |
| API binding | `method/path/authorization` | 描述真实后端接口，以及调用接口必须同时或任选满足哪些权限。 |
| owners | `type/id/required` | 哪个 page/button 拥有该接口；`required=true` 会参与可用性判断。 |
| role menu selection | `nodeIds/include/apiChoices` | 本次角色授权选中哪些节点，是否带后代、按钮、API 和数据模板。 |

`authorization.mode='all'` 表示 `permissions` 中每项都要满足；`'any'` 表示任一项即可。`canonicalOwner` 是接口在 manifest/管理界面中的主归属，不等同于授权规则。

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

`selection.include` 字段：

| 字段 | 当前值含义 |
|---|---|
| `descendants: true` | 自动包含 `orders` 下的后代节点。 |
| `buttons: true` | 同时选择后代按钮。 |
| `apis: 'required'` | 只自动纳入 required owner 关系下的 API；`none` 不纳入，`all` 纳入所有候选。 |
| `dataPermissions: false` | 本次不带菜单节点声明的数据权限模板。 |
| `apiChoices` | preview 出现 any/多候选选择时提交明确选择；本例没有额外选择。 |

`preview()` 只生成计划。只有 `preview.executable=true` 时，才把 `preview.expected` 和 `preview.previewToken` 原样传给 `grant()`；否则先处理 `preview.conflicts` 或 choice requirement。

```json
{
  "visibleNodeIds": ["operations", "orders"],
  "buttons": {
    "orders.export": { "visible": true, "enabled": true, "reason": "allowed" }
  }
}
```

这是由 `visible.data` 和 `buttons.data` 提取的 UI 汇总。两个方法的原始返回都使用 subject runtime envelope；菜单/API 的管理写入则使用 mutation/preview envelope。

前端可见状态只改善导航体验，并不是后端安全边界。导出接口仍必须检查 `api:POST:/api/orders/export`。

## 6. 添加行级和字段级权限

先给集合规则添加动态行条件，再授权查询和投影使用的字段，并显式拒绝 secret 字段。

本节中的四种约束各有职责：

| 字段/参数 | 作用 | 值来源 |
|---|---|---|
| rule `where` | 持久化行条件 AST；本例要求记录的 `merchantId` 等于 subject claim | 管理员配置，`valueFrom` 指向可信 claims |
| subject `claims` | 为动态 where 提供本次用户值 | 宿主认证/业务上下文 |
| collection `scopeFields` | 把权限 scope 字段映射到 Mongo 文档字段 | 应用固定 schema；本例 `tenantId -> tenantId` |
| `find(filter, options)` 的 filter | 调用方本次业务查询 | 业务代码；本例 `{ status: 'paid' }` |
| `projection` | 调用方希望返回的字段 | 必须同时通过字段资源授权 |

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

运行时最终查询是“调用方 filter AND 完整 scope equality AND 所有适用 row condition”；之后再校验 projection 字段。`where` 不是直接交给 Mongo 的任意对象，也不接受 JavaScript 函数。完整 AST、读写方法和返回值见[数据权限](/zh/guide/data-permissions)与[授权集合 API](/zh/api/authorized-collection)。

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
