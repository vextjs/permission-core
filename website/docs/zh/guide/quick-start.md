# 快速开始

本页只做一件事：创建一个角色，把“读取订单接口”权限交给用户，然后看到一条允许和一条默认拒绝结果。完成这条路径后，再学习角色后台、菜单或数据权限。

## 1. 安装并准备 MongoDB

需要 Node.js 18 或更高版本，以及支持事务的 MongoDB。安装 permission-core 和唯一数据库依赖 MonSQLize 3.1：

```bash
npm install permission-core monsqlize@3.1.0
```

把 MongoDB 地址放入环境变量。下面是本地示例；生产环境应使用宿主应用自己的配置方式。

```bash
MONGODB_URI=mongodb://127.0.0.1:27017 node quick-start.mjs
```

## 2. 连接并初始化

新建 `quick-start.mjs`，使用下面这份完整代码：

<!-- docs:first-success:start -->
```js
import MonSQLize from 'monsqlize';
import { PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: process.env.MONGODB_DATABASE ?? 'permission_core_quick_start',
  config: {
    uri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
  },
});

await msq.connect();
const pc = new PermissionCore({ monsqlize: msq });

try {
  await pc.init();

  const scope = { tenantId: 'acme' };
  const scoped = pc.scope(scope, {
    actorId: 'quick-start',
    requestId: 'req-quick-start-first-success',
  });

  await scoped.roles.create({
    id: 'order-reader',
    label: '订单只读',
  });
  await scoped.roles.allow('order-reader', {
    action: 'invoke',
    resource: 'api:GET:/api/orders',
  });
  await scoped.userRoles.assign('u-1', 'order-reader');

  const subject = pc.forSubject({ userId: 'u-1', scope });
  const allowed = await subject.can('invoke', 'api:GET:/api/orders');
  const deleteAllowed = await subject.can('invoke', 'api:DELETE:/api/orders');

  console.log(JSON.stringify({ allowed, deleteAllowed }, null, 2));
} finally {
  await pc.close();
  await msq.close();
}
```
<!-- docs:first-success:end -->

`msq.connect()` 由宿主建立数据库连接；`pc.init()` 创建或核验 permission-core 所需的集合与索引。permission-core 使用传入的 MonSQLize，但不拥有它，所以关闭时两者要分别处理。

## 3. 创建角色并绑定用户

代码中间的三个写方法建立了最小授权状态：

| 调用 | 参数表示什么 | 会改变什么 | 返回什么 |
|---|---|---|---|
| `roles.create(input)` | `id` 是代码使用的稳定角色 ID；`label` 是展示名称 | 在当前 `tenantId` 下创建角色 | `MutationResult<Role>`，角色在 `data` |
| `roles.allow(roleId, rule)` | 第一个参数选角色；`action/resource` 表示允许调用哪个接口 | 给角色追加一条 allow 规则 | `MutationResult<PermissionRuleView>` |
| `userRoles.assign(userId, roleId)` | `u-1` 来自宿主用户系统；第二个参数是已存在角色 | 给用户增量添加一个直接角色 | `MutationResult<UserRoleBindingSet>` |

`pc.scope(scope, defaults)` 让这些管理操作只发生在 `acme` 租户。它本身不写数据库；`actorId/requestId` 会作为后续管理写入的默认审计与幂等上下文，所以普通代码不需要每个 `roles.create()`、`roles.allow()`、`userRoles.assign()` 都手动传一遍。permission-core 不创建或登录 `u-1`，只保存这个用户 ID 与角色的关系。

## 4. 验证允许与默认拒绝

`pc.forSubject({ userId, scope })` 把可信用户与租户范围绑定成判断上下文。`subject.can(action, resource)` 返回布尔值，不修改权限数据。

运行后应看到：

```json
{
  "allowed": true,
  "deleteAllowed": false
}
```

这是程序直接打印的**原始示例输出**：

- `allowed: true`：角色拥有 `invoke + api:GET:/api/orders` 的 allow 规则。
- `deleteAllowed: false`：没有任何规则允许 `api:DELETE:/api/orders`，所以系统默认拒绝。

这里没有给用户“分配 DELETE 权限”，也没有额外创建一条阻止权限。`false` 只是 `can()` 对未授权操作的正常结果。

如果第一次运行失败，先检查 MongoDB 是否可连接、是否支持事务，以及 `MONGODB_URI` 是否指向正确实例。重复使用同一个非空示例数据库时，角色可能已经存在；换一个空数据库或清理这次示例数据后再运行。

## 5. 关闭并继续下一项任务

> **资源关闭。** permission-core 使用宿主的 MonSQLize 连接但不拥有它；关闭顺序固定为先 `pc.close()`，再由宿主 `msq.close()`。

`finally` 保证成功或报错时都先调用 `pc.close()`，等权限操作排空，再由宿主调用 `msq.close()` 关闭数据库连接。

现在你已经完成核心 RBAC 第一次成功：

- 要做角色管理后台：进入[管理角色与用户授权](/zh/guide/manage-roles-and-users)。
- 要做菜单、按钮、接口和响应字段授权：进入[管理菜单](/zh/guide/menu-management)。
- 要在业务代码中处理中断、诊断和权限快照：进入[检查权限](/zh/guide/check-permission)。
- 对 `scope`、`subject`、直接和有效仍不熟悉：阅读[核心术语与心智模型](/zh/guide/core-concepts)。
