# 管理角色与用户授权

本页只讲后台最常见的一件事：创建一个角色，把角色分给用户，再确认这个用户最终有哪些权限。示例假设 `pc.init()` 已完成，并且 `scope` 来自可信的租户上下文。

```ts
const scope = { tenantId: 'acme' };
const scoped = pc.scope(scope);
```

`scoped` 只管理 `acme` 租户内的数据。permission-core 不创建用户；示例里的 `u-1` 是宿主用户系统提供的稳定 ID。

## 先记住四个方法

| 方法 | 用来干嘛 | 最容易误解的点 |
|---|---|---|
| `userRoles.assign(userId, roleId)` | 给用户追加一个角色 | 不会清空用户已有角色 |
| `userRoles.set(userId, roleIds, options)` | 保存角色多选框的完整结果 | 会移除数组里没有的旧角色 |
| `userRoles.getDirect(userId)` | 打开编辑页时读取直接绑定的角色 | 这是后台可编辑值 |
| `userRoles.getEffective(userId)` | 排查最终权限时读取生效角色 | 会展开继承后的结果 |

## 1. 创建角色

```ts
const created = await scoped.roles.create({
  id: 'order-reader',
  label: '订单只读',
  description: '可以查看订单列表',
});
```

`roles.create()` 会在当前 scope 新增角色。常用返回值在 `created.data.id` 和 `created.data.revision`；完整响应字段见[核心与上下文 API](/zh/api/core-and-contexts#公共响应合同)。

## 2. 给角色加一条权限

```ts
const granted = await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/api/orders',
});
```

`roles.allow(roleId, rule)` 表示“这个角色允许做某个动作”。本例允许 `order-reader` 调用 `api:GET:/api/orders`。没有匹配 allow 的操作默认拒绝，所以通常不需要给每个不能访问的接口写 deny。

## 3. 给用户绑定角色

单独增加一个角色时使用 `assign()`：

```ts
const assigned = await scoped.userRoles.assign('u-1', 'order-reader');
console.log(assigned.data.roleIds); // ['order-reader']
```

`userId` 来自宿主用户系统，`roleId` 必须是当前 scope 内已存在且可用的角色。调用会更新用户的**直接角色集合**；同一角色已经存在时是幂等操作，不会重复保存。

如果后台页面是角色多选框，保存完整勾选结果时使用 `set()`：

```ts
const before = await scoped.userRoles.getDirect('u-1');
const saved = await scoped.userRoles.set(
  'u-1',
  ['order-reader', 'report-reader'],
  { expectedRevision: before.data.revision },
);
```

| 方法 | 数组/参数含义 | 适合场景 |
|---|---|---|
| `assign(userId, roleId)` | 只追加一个角色，不需要 revision | “再给这个用户一个角色” |
| `set(userId, roleIds, options)` | `roleIds` 是最终完整集合；缺少的旧角色会被移除 | 保存角色多选框 |
| `getDirect(userId)` | 读取可编辑的直接集合和最新 revision | 打开编辑页、提交 `set/clear` 前 |

> **全量替换风险。** `set('u-1', ['operator'], ...)` 不会在原角色旁追加 `operator`，而会把直接角色完整替换为仅 `operator`。

如果 `set()` 返回 `REVISION_CONFLICT`，说明读取后有人改过绑定。重新调用 `getDirect()`，展示最新值并让操作者再次确认。

## 4. 读取最终结果

```ts
const role = await scoped.roles.get('order-reader');
const effectiveRules = await scoped.roles.getEffectiveRules('order-reader');
const directRoles = await scoped.userRoles.getDirect('u-1');
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
```

| 读取 | 回答的问题 | 返回中的关键位置 |
|---|---|---|
| `roles.get()` | 角色名称、状态、父角色和 revision 是什么 | `data.id/label/status/parentId/revision` |
| `roles.getEffectiveRules()` | 加上父角色后最终有哪些规则和冲突 | `data.chain/rules/conflicts` |
| `userRoles.getDirect()` | 用户后台可编辑的直接角色有哪些 | `data.roleIds/revision` |
| `userRoles.getEffective()` | 继承展开后哪些角色真正参与授权 | `data.direct/effective` |

编辑页面使用 direct/own；诊断最终结果使用 effective。不要把 effective 结果保存回 direct 集合。

## 常见问题

### assign 和 set 到底有什么区别？

`assign()` 是追加一个角色；`set()` 是保存完整角色集合。角色多选框提交时用 `set()`，单个“授予角色”按钮用 `assign()`。

### 为什么读取 direct 后再 set？

`set()` 是全量替换，带 `expectedRevision` 可以防止用旧页面覆盖别人刚改过的角色。

### 更新或删除角色去哪看？

改父角色、禁用角色、替换规则或删除角色会影响继承和用户绑定。先看[角色 API](/zh/api/roles)里的 `previewAccessUpdate()`、`previewReplaceRules()` 和 `getRemovalImpact()`。

## 失败时先看什么

| 错误 | 含义 | 处理 |
|---|---|---|
| `ROLE_NOT_FOUND` | 当前 scope 找不到角色 | 检查 `tenantId` 和 `roleId` |
| `REVISION_CONFLICT` | 提交基于旧 revision | 重新读取并让操作者确认 |

下一步进入[检查权限](/zh/guide/check-permission)，学习 `can()`、`assert()`、`explain()` 以及如何读取用户权限快照。精确签名与全部错误见[角色 API](/zh/api/roles)和[用户角色 API](/zh/api/user-roles)。
