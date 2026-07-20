# 基础 RBAC

## 场景

这是第一个完整 RBAC 路径：创建角色与规则、给用户分配角色、检查 allow/默认拒绝、对比追加型 `assign` 与替换型 `set`，并读取自身/有效授权状态。

## 运行

```bash
npm run example:basic
```

规范源码是 `examples/basic.mjs` 中 `docs:basic:start` 到 `docs:basic:end` 的内容，并使用 `examples/_support/host.mjs` 中的共享宿主 fixture。

命令会自动启动临时 MongoDB 副本集、连接 MonSQLize，并在 `finally` 中依次关闭 PermissionCore、MonSQLize 和副本集。它不会连接你的业务数据库；生产应用应使用宿主自己创建并管理的 MonSQLize 实例。

## 先看结果

运行成功先确认四项：`ok` 是 `true`；`permissionChecks.allowed` 是 `true`；`permissionChecks.cannotDelete` 是 `true`；`userRoles.afterSet` 最终只有 `order-reader`。这些值分别证明允许规则生效、未授权 DELETE 被默认拒绝，以及 `set()` 确实执行全量替换。

## 源码解读

```js
await scoped.roles.create({ id: 'order-reader', label: 'Order reader' });
await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'GET:/api/orders',
});
await scoped.roles.create({ id: 'operator', label: 'Operator' });

const assigned = await scoped.userRoles.assign('u-1', 'order-reader');
const subject = core.forSubject({ userId: 'u-1', scope });
const allowed = await subject.can('invoke', 'GET:/api/orders');
const cannotDelete = await subject.cannot('invoke', 'DELETE:/api/orders');

await scoped.userRoles.assign('u-1', 'operator');
const beforeSet = await scoped.userRoles.getDirect('u-1');
const replaced = await scoped.userRoles.set('u-1', ['order-reader'], {
  expectedRevision: beforeSet.data.revision,
  actorId: 'admin',
});

const role = await scoped.roles.get('order-reader');
const ownRules = await scoped.roles.getOwnRules('order-reader');
const effectiveRules = await scoped.roles.getEffectiveRules('order-reader');
const roleChain = await scoped.roles.getChain('order-reader');
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
const permissions = await subject.getPermissions();
const resources = await subject.getResources('invoke');
const deleteExplanation = await subject.explain(
  'invoke',
  'DELETE:/api/orders',
);
```

`cannotDelete: true` 表示对应 `can()` 为 false，因为没有 delete allow。它不表示授予了 delete 权限，也不表示分配了单独 deny。

上面保留了生成“预期输出”所需的全部关键调用。`assigned`、`replaced`、`role` 等变量接收的是 API 原始响应；页面下方的 JSON 则是示例程序从这些响应中挑选字段后生成的汇总，不应把两者当成同一种返回结构。

### 1. 创建角色状态

<!-- docs:operation id=basic-role-state calls=roles.create,roles.allow outputs=role,reads.ownRules -->

**目的与目标。** `roles.create` 在当前 `acme` scope 中创建 `order-reader`，`roles.allow` 为该角色附加唯一规则：允许调用 `GET:/api/orders`。

**状态、参数与结果。** 角色输入提供持久化 ID 和 label；规则输入提供 `action` 与类型化 `resource`。这是两次独立提交的 mutation。示例随后读取已保存的角色及其自身规则，写入 `role` 和 `reads.ownRules`，因此输出描述的是数据库状态，不是内存参数的原样回显。

**失败与下一步。** 角色重复、角色不存在、规则无效或数据库不可用时，对应调用会失败。由于创建角色和添加规则不是同一事务，重试前应先检查具体错误，只重试失败的步骤。

**API 参考。** 参见[角色 API](/zh/api/roles)，了解 mutation envelope、角色读取、规则输入与错误。

| 方法 | 本例参数 | 状态变化 | 原始返回用途 |
|---|---|---|---|
| `roles.create(input)` | `{ id, label }`：角色唯一 ID 与展示名 | 新建角色，初始 revision 为 `1` | mutation envelope；后续用 `roles.get()` 读取完整角色 |
| `roles.allow(roleId, rule)` | 角色 ID；规则含 `action`、`resource` | 给角色追加一条 allow 规则，并推进 revision | mutation envelope；规则内容需由规则读取方法确认 |
| `roles.get(roleId)` | `order-reader` | 不修改状态 | 返回角色记录，本例提取 `id`、`label`、`revision` |
| `roles.getOwnRules(roleId)` | `order-reader` | 不修改状态 | 返回该角色自己持有的规则，不展开继承 |

### 2. 追加角色，再替换完整直接角色集合

<!-- docs:operation id=basic-assignment calls=userRoles.assign,userRoles.getDirect,userRoles.set outputs=userRoles.afterAssign,userRoles.beforeSet,userRoles.afterSet -->

**目的与目标。** `userRoles.assign` 给 `u-1` 追加一个直接角色；`userRoles.set` 替换该用户的完整直接角色集合。把两者并列展示，是为了明确追加和替换不是同义操作。

**状态、参数与结果。** `userRoles.getDirect` 返回当前 role ID 及其 revision。规范源码在读取前又添加了 `operator`，所以 `beforeSet` 有两个角色。随后 `userRoles.set(..., { expectedRevision })` 只提交 `order-reader`，因此 `afterSet` 只剩一个直接角色；继承角色属于另一层语义。

**失败与下一步。** `expectedRevision` 过期时，替换会被拒绝，避免覆盖其他管理员的并发修改。应通过 `getDirect` 重新读取，确认新角色集合仍然正确，再使用新 revision 重试。

**API 参考。** 参见[用户角色 API](/zh/api/user-roles)，了解追加分配、完整替换、直接/有效读取与 revision 错误。

| 方法 | 本例参数 | 状态变化 | 原始返回用途 |
|---|---|---|---|
| `userRoles.assign(userId, roleId)` | 用户 `u-1`；待追加角色 | 只追加目标角色，不移除已有直接角色 | 返回 mutation envelope，`data.roleIds` 是提交后的直接角色集合 |
| `userRoles.getDirect(userId)` | 用户 `u-1` | 不修改状态 | 返回直接角色及 revision，供并发保护使用 |
| `userRoles.set(userId, roleIds, options)` | 完整目标集合；`expectedRevision`；可选 `actorId` | 用传入集合替换全部直接角色 | 返回替换后的 binding set；revision 不匹配时不写入 |
| `userRoles.getEffective(userId)` | 用户 `u-1` | 不修改状态 | 返回解析继承后的有效角色，本例提取角色 ID |

### 3. 判定具体操作

<!-- docs:operation id=basic-decision calls=forSubject,can,cannot,explain outputs=permissionChecks -->

**目的与目标。** `forSubject` 把可信用户与 scope 身份绑定到请求期上下文；`can` 检查允许的 GET 操作，`cannot` 检查未授权的 DELETE 操作，`explain` 记录 DELETE 为何被阻止。

**状态、参数与结果。** 只有有效规则允许完全相同的 action/resource 时，`can` 才返回 `true`。`cannot` 是同一判定的布尔反值，不是一次权限分配。由于不存在匹配的 delete allow，解释原因是 `no-allow`；这是默认拒绝，不是显式 deny 规则。

**失败与下一步。** 缺少可信 scope、授权状态不可用或策略上下文无效时会 fail closed。可用 `explain` 诊断，再修正 subject/规则；真实业务操作仍应由 `can` 或 `assert` 执行强制检查。

**API 参考。** 参见[核心与上下文 API](/zh/api/core-and-contexts)，了解 subject factory、判定、解释与 fail-closed 错误。

| 方法 | 本例参数 | 状态变化 | 返回值如何读 |
|---|---|---|---|
| `core.forSubject(input)` | 可信 `userId` 与 `scope` | 创建请求期上下文，不写数据库 | 返回 subject facade，后续判定默认使用同一身份与 scope |
| `subject.can(action, resource)` | `invoke`；GET 接口资源 | 不写状态 | `true` 表示存在有效 allow 且未被 deny 覆盖 |
| `subject.cannot(action, resource)` | `invoke`；DELETE 接口资源 | 不写状态 | 等价于对应 `can()` 的布尔反值，不创建 deny |
| `subject.explain(action, resource)` | 与待诊断判定相同 | 不写状态 | 返回解释 envelope；本例读取 `data.reason` 的 `no-allow` |

### 4. 读取有效授权状态

<!-- docs:operation id=basic-effective-reads calls=roles.get,roles.getOwnRules,roles.getEffectiveRules,roles.getChain,userRoles.getEffective,getPermissions,getResources outputs=role,userRoles.effective,reads -->

**目的与目标。** `roles.get`、`roles.getOwnRules`、`roles.getEffectiveRules` 和 `roles.getChain` 检查角色；`userRoles.getEffective`、`getPermissions` 和 `getResources` 检查用户的有效授权状态。

**状态、参数与结果。** `roles.getOwnRules` 不含继承来源；`roles.getEffectiveRules` 解析继承和生成来源；`roles.getChain` 解释父角色链。`userRoles.getEffective` 把直接角色解析为有效角色，`getPermissions` 与 `getResources('invoke')` 则提供有界的 subject 诊断快照。

**失败与下一步。** 这些读取能暴露缺失、禁用、冲突或截断状态，但不能替代授权。诊断时检查其 metadata，真正执行受保护操作前仍需调用 `can` 或 `assert`。

**API 参考。** 参见[角色 API](/zh/api/roles)、[用户角色 API](/zh/api/user-roles)和[核心与上下文 API](/zh/api/core-and-contexts)。

| 方法 | 与相近方法的区别 | 本例读取内容 |
|---|---|---|
| `roles.getEffectiveRules(roleId)` | 包含继承/生成来源，区别于只读自身规则的 `getOwnRules` | `data.rules.items` |
| `roles.getChain(roleId)` | 返回继承链及每层角色，不返回规则集合 | 各项 `role.id` |
| `subject.getPermissions()` | 返回当前 subject 的有界规则诊断快照 | `data.rules.total` |
| `subject.getResources(action)` | 按 action 汇总可访问资源，仍不是授权执行结果 | 各项 `resource` |

## 预期输出

以下 JSON 是 `printExample()` 生成的**示例汇总输出**，不是某一个 API 方法的原始响应。字段来源已在代码变量、方法表及输出分组说明中逐项对应。

```json
{
  "example": "basic",
  "ok": true,
  "role": {
    "id": "order-reader",
    "label": "Order reader",
    "revision": 2
  },
  "userRoles": {
    "afterAssign": ["order-reader"],
    "beforeSet": ["operator", "order-reader"],
    "afterSet": ["order-reader"],
    "effective": ["order-reader"],
    "semantics": {
      "assign": "adds one direct role",
      "set": "replaces the complete direct-role set at the expected revision"
    }
  },
  "permissionChecks": {
    "allowed": true,
    "cannotDelete": true,
    "cannotMeaning": "true because can(...) is false; it is not a separate deny assignment",
    "deleteReason": "no-allow"
  },
  "reads": {
    "ownRules": ["allow:invoke:GET:/api/orders"],
    "effectiveRules": ["allow:invoke:GET:/api/orders"],
    "roleChain": ["order-reader"],
    "permissionRuleCount": 1,
    "resources": ["GET:/api/orders"]
  }
}
```

<!-- docs:output group=role producer=basic-role-state -->

**`role` 来源。** `roles.get` 读取 `order-reader`；其状态由 `roles.create` 建立、再由 `roles.allow` 推进；revision `2` 证明规则 mutation 已改变持久化角色状态。

<!-- docs:output group=userRoles producer=basic-assignment -->

**`userRoles` 来源。** 三个数组分别来自 `assign`、`set` 前的 `getDirect` 以及成功的 `set` 响应。`effective` 来自 `getEffective`，`semantics` 明确两种写方法应如何理解。

<!-- docs:output group=permissionChecks producer=basic-decision -->

**`permissionChecks` 来源。** `allowed` 与 `cannotDelete` 是两次布尔判定，`deleteReason` 来自 `explain`。四个字段应一起阅读，避免把 `cannotDelete: true` 误解为已经授予 delete 权限。

<!-- docs:output group=reads producer=basic-effective-reads -->

**`reads` 来源。** `roles.getOwnRules`、`roles.getEffectiveRules`、`roles.getChain`、`getPermissions` 和 `getResources` 共同生成该诊断组；其中任何字段都不能替代具体授权检查。

## 生产边界

示例只为可重复执行而启动内存 MongoDB replica set。生产环境由宿主提供已连接的 MonSQLize 3.1 实例、可信租户/用户身份、token secret 和进程生命周期。示例先关闭 PermissionCore，再关闭宿主数据库。

## 相关内容

参见[快速开始](/zh/guide/quick-start)、[检查权限](/zh/guide/check-permission)和[用户角色 API](/zh/api/user-roles)。
