# 行级权限示例

这个示例对应 `DB-only` 路径，重点展示怎么把集合门禁、行级范围、单条记录判断和最终字段收口串成一条真实链路。

## 规则准备

```typescript
await pc.roles.create('sales', { label: '销售' });
await pc.roles.allow('sales', 'read', 'db:orders', {
  where: { field: 'ownerId', op: 'eq', valueFrom: 'userId' },
});
await pc.roles.allow('sales', 'read', 'db:orders:id');
await pc.roles.allow('sales', 'read', 'db:orders:status');
await pc.roles.allow('sales', 'read', 'db:orders:amount');
await pc.users.assign('user-001', 'sales');
```

这组规则表达的是：

- 允许读取 `db:orders`
- 但只允许看到 `ownerId === 当前 userId` 的订单
- 即使记录进入结果集，最终返回时仍只保留有字段权限的列

## 查列表时怎么串

```typescript
await pc.assert('user-001', 'read', 'db:orders');

const scope = await pc.getRowScope('user-001', 'read', 'db:orders');
const rows = await orderRepo.findByScope(scope);

const visibleRows = await pc.filterRows('user-001', 'read', 'db:orders', rows);
```

这一步对应的理解顺序是：

1. `assert()` 先确认集合本身能不能进入
2. `getRowScope()` 把行级条件下推给你自己的查询层
3. `filterRows()` 再对结果列表做最后一层收口

## 查详情时怎么串

```typescript
const order = await orderRepo.findById('o-1');

const canReadSelf = await pc.canRow('user-001', 'read', 'db:orders', order);
const cannotReadForeign = await pc.cannotRow('user-001', 'read', 'db:orders', {
  id: 'o-2',
  ownerId: 'user-009',
  status: 'paid',
  amount: 100,
});

await pc.assertRow('user-001', 'read', 'db:orders', order);

const safeOrder = await pc.filterFields('user-001', 'read', 'db:orders', order);
```

这里可以把几类方法分别理解成：

- `canRow()`：需要布尔结果时最直接
- `cannotRow()`：写否定分支时更自然
- `assertRow()`：详情页或 Service 守卫里直接阻断
- `filterFields()`：记录已经允许返回后，再做字段收口

## 这个示例真正说明了什么

- 行级权限不是替代集合门禁，而是集合门禁后的第二层
- `getRowScope()` 适合查库前下推，`filterRows()` 适合查库后收口
- 单条记录判断应交给 `canRow()` / `cannotRow()` / `assertRow()`，不要继续塞回 `can()`
- 字段过滤仍然是最后一层，而不是行级权限的替代品

## 常见误区

- 只有 `where` 条件，没有先过集合门禁
- 只写 `getRowScope()`，却完全不做结果列表或详情页校验
- 试图把行级条件写成 MongoDB Query、SQL 片段或 JS callback

## 下一步看什么

- 想先理解行级能力为什么单独建模：看 [行级权限](/zh/guide/row-level)
- 想继续看字段级返回如何收口：看 [字段权限示例](/zh/examples/field-permission)
- 想回到主 API 核对返回值：看 [PermissionCore](/zh/api/permission-core)