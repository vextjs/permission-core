# 检查权限

请求时决策使用 subject context，管理查询使用 scoped context。两者都是同一租户范围授权状态上的不可变门面。

## 布尔检查与强制执行

```ts
const subject = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme' },
});

const allowed = await subject.can('invoke', 'GET:/api/orders');
const blocked = await subject.cannot('invoke', 'DELETE:/api/orders');
await subject.assert('invoke', 'GET:/api/orders');
```

```json
{ "allowed": true, "blocked": true, "assertResult": "void" }
```

上面的 JSON 是把三个不同调用整理在一起的教程汇总，不是任何一个方法的原始响应。

| 方法 | 参数 | 原始返回 | 何时使用 |
|---|---|---|---|
| [`pc.forSubject(input)`](/zh/api/core-and-contexts#core-for-subject) | `userId` 与可信 `scope` 必填；可选 `claims` | 同步返回 subject facade | 每个请求先绑定可信身份，后续调用复用它 |
| [`subject.can(action, resource, context?)`](/zh/api/core-and-contexts#core-can) | action/resource 必填；条件规则需要 context | `Promise<boolean>` | 分支显示、路由或业务执行前做布尔检查 |
| [`subject.cannot(...)`](/zh/api/core-and-contexts#core-cannot) | 与 `can` 完全相同 | `Promise<boolean>`，等于 `!can(...)` | 只为了更自然地表达反向条件 |
| [`subject.assert(...)`](/zh/api/core-and-contexts#core-assert) | 与 `can` 完全相同 | 允许时 `Promise<void>`，拒绝时抛错 | 后端命令执行前需要强制中止流程时 |

`can` 返回布尔值，`cannot` 返回精确逻辑取反。允许时 `assert` 完成且没有返回值，否则抛出 `PERMISSION_DENIED`。操作被阻止不代表一定存在显式 deny；默认拒绝也会阻止。

接口检查应使用匹配后的路由模板，例如 `GET:/orders/:id`，不要使用带查询参数的具体 URL。授权和检查时必须保持 action 与 resource 命名一致。

## 解释一次决策

```ts
const explanation = await subject.explain(
  'invoke',
  'DELETE:/api/orders',
);
```

```json
{
  "data": {
    "allowed": false,
    "action": "invoke",
    "resource": "DELETE:/api/orders",
    "reason": "no-allow",
    "evaluations": [
      { "action": "invoke", "allowed": false, "reason": "no-allow" }
    ]
  },
  "detailBudget": { "limit": 100, "returned": 0, "truncated": false, "digest": "..." }
}
```

这是 `explain()` 的原始 `SubjectRuntimeResult<PermissionExplanation>`。`data` 是决策解释，`detailBudget` 说明有界明细是否完整；它不是 `can()` 的返回结构。

| 参数 | 来源 | 说明 |
|---|---|---|
| `action` | 与真实业务检查相同 | 本例为 `invoke`；不能用 explain 时换成另一个 action。 |
| `resource` | 与真实业务检查相同 | 本例诊断 DELETE endpoint。 |
| `context?` | 当前请求的可信策略上下文 | 规则使用动态 `valueFrom` 时必须与 `can/assert` 传入相同上下文。 |

常见原因包括 `allow`、`explicit-deny`、`no-allow`、`policy-unknown`、`role-disabled` 和 `context-missing`。解释轨迹是有界响应；在认定全部来源都已返回前，应检查 `detailBudget`。

## 读取角色及其规则

```ts
const scoped = pc.scope({ tenantId: 'acme' });
const role = await scoped.roles.get('order-reader');
const own = await scoped.roles.getOwnRules('order-reader');
const effective = await scoped.roles.getEffectiveRules('order-reader');
const chain = await scoped.roles.getChain('order-reader');
```

```json
{
  "role": { "id": "order-reader", "parentId": null, "revision": 2 },
  "ownRules": [
    { "effect": "allow", "action": "invoke", "resource": "GET:/api/orders" }
  ],
  "effectiveRuleCount": 1,
  "chain": [{ "role": { "id": "order-reader" }, "depth": 0, "included": true }]
}
```

该 JSON 是从四个原始 envelope 中提取字段后的教程汇总。四个方法不会共同返回这个对象。

| 方法 | 参数 | 原始响应与区别 |
|---|---|---|
| [`roles.get(roleId)`](/zh/api/roles#roles-get) | 角色 ID | `VersionedResult<Role>`；只读角色属性和 revision，不含规则。 |
| [`roles.getOwnRules(roleId)`](/zh/api/roles#roles-get-own-rules) | 角色 ID | `VersionedResult<PermissionRuleView[]>`；只含该角色自身来源。 |
| [`roles.getEffectiveRules(roleId)`](/zh/api/roles#roles-get-effective-rules) | 角色 ID | 返回继承展开后的规则、冲突和来源信息。 |
| [`roles.getChain(roleId)`](/zh/api/roles#roles-get-chain) | 角色 ID | 返回父链条目及 included/reason，不返回规则列表。 |

`getOwnRules` 只返回直接挂在这个角色上的规则。`getEffectiveRules` 还包含继承规则、冲突、来源角色 ID 和菜单生成来源。`getChain` 说明单父角色链上的每个角色为何被包含或排除。

## 读取并替换用户角色

```ts
await scoped.userRoles.assign('u-1', 'order-reader');
await scoped.userRoles.assign('u-1', 'operator');

const direct = await scoped.userRoles.getDirect('u-1');
const saved = await scoped.userRoles.set('u-1', ['order-reader'], {
  expectedRevision: direct.data.revision,
});
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
```

```json
{
  "beforeSet": ["operator", "order-reader"],
  "afterSet": ["order-reader"],
  "effective": ["order-reader"]
}
```

该 JSON 同样是教程汇总。`assign()` 和 `set()` 各自返回 mutation envelope，`getDirect/getEffective` 各自返回 read envelope。

| 方法 | 参数 | 状态变化与原始返回 |
|---|---|---|
| [`userRoles.assign(userId, roleId, options?)`](/zh/api/user-roles#user-roles-assign) | 用户 ID、要追加的角色 ID | 只追加一个直接角色；返回提交后的 `UserRoleBindingSet`。 |
| [`userRoles.getDirect(userId)`](/zh/api/user-roles#user-roles-get-direct) | 用户 ID | 只读直接角色和 revision；本例把 revision 交给 `set`。 |
| [`userRoles.set(userId, roleIds, options)`](/zh/api/user-roles#user-roles-set) | 完整目标数组；必填 `expectedRevision` | 替换完整直接角色集合；返回替换后的 binding set。 |
| [`userRoles.getEffective(userId)`](/zh/api/user-roles#user-roles-get-effective) | 用户 ID | 解析直接角色及其父链；不修改绑定。 |

`assign` 是增量添加，角色已经绑定时保持幂等。`set` 是受 `expectedRevision` 保护的全量替换；列表中缺少的角色会被撤销。管理后台保存完整角色勾选结果时使用 `set`，单个复选框事件不要直接做全量替换。

## 读取用户权限快照

```ts
const permissions = await subject.getPermissions();
const invokeResources = await subject.getResources('invoke');
```

```json
{
  "permissions": {
    "data": {
      "subject": { "userId": "u-1", "scope": { "tenantId": "acme" } },
      "directRoleIds": ["order-reader"],
      "roles": {
        "total": 1,
        "items": [{
          "role": { "id": "order-reader", "status": "enabled", "parentId": null },
          "direct": true,
          "viaRoleIds": ["order-reader"],
          "depth": 0,
          "included": true
        }],
        "truncated": false,
        "digest": "..."
      },
      "rules": {
        "total": 1,
        "items": [{
          "effect": "allow",
          "action": "invoke",
          "resource": "GET:/api/orders",
          "sourceRoleId": "order-reader",
          "inherited": false,
          "depth": 0
        }],
        "truncated": false,
        "digest": "..."
      },
      "conflicts": { "total": 0, "items": [], "truncated": false, "digest": "..." }
    },
    "detailBudget": { "limit": 100, "returned": 2, "truncated": false, "digest": "..." }
  },
  "invokeResources": {
    "data": [{
      "action": "invoke",
      "resource": "GET:/api/orders",
      "conditional": false,
      "sourceRoleIds": {
        "total": 1,
        "items": ["order-reader"],
        "truncated": false,
        "digest": "..."
      }
    }],
    "detailBudget": { "limit": 100, "returned": 1, "truncated": false, "digest": "..." }
  }
}
```

外层 `permissions/invokeResources` 是教程为并列展示而组装的对象；两项内部保留了各自的原始 subject runtime response。

| 方法 | 参数 | 原始返回与用途 |
|---|---|---|
| [`subject.getPermissions(options?)`](/zh/api/core-and-contexts#core-get-permissions) | 可选 detail budget；subject 已绑定身份 | 返回角色、规则、冲突的有界诊断快照。 |
| [`subject.getResources(action?, options?)`](/zh/api/core-and-contexts#core-get-resources) | 可选 action 过滤和 detail budget | 返回有效资源模式；`conditional=true` 表示实际判定仍需要上下文。 |

`getPermissions()` 返回直接角色 ID、有界的有效角色、有效规则和冲突。`getResources(action?)` 返回有效资源模式，并标记带条件的条目。这些方法是诊断快照，不能替代具体操作鉴权；实际请求仍应带策略上下文调用 `can` 或 `assert`。

继承行为请继续阅读[角色继承](/zh/guide/role-inheritance)。精确签名见[核心与上下文](/zh/api/core-and-contexts)、[角色 API](/zh/api/roles)和[用户角色 API](/zh/api/user-roles)。
