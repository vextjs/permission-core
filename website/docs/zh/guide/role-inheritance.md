# 角色继承

每个角色最多有一个直接父角色。子角色继承已激活的父角色链，同时自身规则和菜单授权仍保留可识别来源。单父模型让有效权限保持确定且可审查。

## 创建父角色与子角色

```ts
await scoped.roles.create({
  id: 'order-base',
  label: 'Order base',
});
await scoped.roles.allow('order-base', {
  action: 'read',
  resource: 'db:orders',
});

await scoped.roles.create({
  id: 'order-operator',
  label: 'Order operator',
  parentId: 'order-base',
});
await scoped.roles.allow('order-operator', {
  action: 'invoke',
  resource: 'api:POST:/api/orders/export',
});
```

给用户绑定 `order-operator` 后，子角色是直接角色，`order-base` 是继承角色。不要为了获得父角色规则再重复给用户分配父角色。

## 读取自身与有效状态

```ts
const own = await scoped.roles.getOwnRules('order-operator');
const effective = await scoped.roles.getEffectiveRules('order-operator');
const chain = await scoped.roles.getChain('order-operator');
```

```json
{
  "own": [
    { "effect": "allow", "resource": "api:POST:/api/orders/export" }
  ],
  "effective": [
    { "resource": "api:POST:/api/orders/export", "sourceRoleId": "order-operator", "inherited": false, "depth": 0 },
    { "resource": "db:orders", "sourceRoleId": "order-base", "inherited": true, "depth": 1 }
  ],
  "chain": [
    { "role": { "id": "order-operator" }, "depth": 0, "included": true },
    { "role": { "id": "order-base" }, "depth": 1, "included": true }
  ]
}
```

`getOwnRules` 不会展开父角色。`getEffectiveRules` 包含来源角色、继承标记、深度、冲突和有界来源信息。`getChain` 还会返回被停用或废弃的条目及排除原因，方便管理员解释继承权限为何消失。

## 冲突处理

所有被包含角色的规则一起评估。任意适用 deny 都优先于 allow，与规则来自直接角色还是继承角色无关。

```ts
await scoped.roles.deny('order-operator', {
  action: 'read',
  resource: 'db:orders:field:secret',
});
```

子角色仍继承 `order-base` 的集合读取，但 secret 字段保持拒绝。子角色 allow 不能覆盖命中的父角色 deny；应明确修改父级策略，而不是依赖层级位置覆盖。

## 安全修改父角色或状态

父角色和状态变化可能影响全部后代与绑定用户，必须先 preview 再 execute：

```ts
const preview = await scoped.roles.previewAccessUpdate(
  'order-operator',
  { parentId: 'order-supervisor' },
);
if (!preview.executable) throw new Error('Resolve impact conflicts');
await scoped.roles.executeAccessUpdate(
  'order-operator',
  { parentId: 'order-supervisor' },
  { ...preview.expected, previewToken: preview.previewToken },
);
```

预览会报告后代、直接绑定用户、受影响用户、容量方向和必需确认。`CIRCULAR_INHERITANCE` 阻止循环；角色链最多 32 层；每个用户最多 128 个直接角色，有效角色和有效规则快照也有明确边界。

## 父级变化、移除与缓存

父角色规则或状态变化在事务提交后立即影响所有激活后代。语义缓存会定向失效父角色、后代和受影响 subject，调用方无需手工清理无关缓存。

移除前调用 `getRemovalImpact(roleId)`。存在子角色或绑定用户时，必须明确处理依赖后才能删除；移除父角色不会静默给子角色换父级。菜单授权沿用同一继承链，并在有效读取中保留来源角色 ID。

## 用户界面模型

管理系统应分别展示三种视图：

1. 用户直接角色（`userRoles.getDirect`）
2. 带继承路径的用户有效角色（`userRoles.getEffective`）
3. 角色自身与有效规则、菜单授权

这样继承权限不会被误解为直接分配。全部签名见[角色 API](/zh/api/roles)和[用户角色 API](/zh/api/user-roles)。
