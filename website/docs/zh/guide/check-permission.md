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

`getPermissions()` 返回直接角色 ID、有界的有效角色、有效规则和冲突。`getResources(action?)` 返回有效资源模式，并标记带条件的条目。这些方法是诊断快照，不能替代具体操作鉴权；实际请求仍应带策略上下文调用 `can` 或 `assert`。

继承行为请继续阅读[角色继承](/zh/guide/role-inheritance)。精确签名见[核心与上下文](/zh/api/core-and-contexts)、[角色 API](/zh/api/roles)和[用户角色 API](/zh/api/user-roles)。
