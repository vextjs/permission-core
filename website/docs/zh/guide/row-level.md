# 行级权限

行级权限解决的问题，不是“这个集合能不能访问”，而是“在已经允许访问这个集合之后，哪些记录还能继续进入后续流程”。

在 permission-core 里，它和资源字符串是分开的：

- 资源仍然写成 `db:<collection>[:<field>]`
- 行级条件写在规则的 `where` 元数据里

## 为什么不把条件塞进资源字符串

如果把“只能看自己的订单”写成某种特殊资源路径，很快就会遇到两个问题：

- 资源模型会和具体数据库方言耦合
- 后台保存、缓存和运行时判断会变成两套结构

所以当前方案选择把资源保持稳定，把条件外置到规则里。

## 一个最小规则示例

```typescript
await pc.roles.allow('sales', 'read', 'db:orders', {
  where: { field: 'ownerId', op: 'eq', valueFrom: 'userId' },
});
```

这条规则的意思是：

- 资源仍然是 `db:orders`
- 允许读取
- 但只允许读取 `ownerId === 当前 userId` 的记录

## 运行时怎么用

### 先过集合门禁

```typescript
await pc.assert('user-001', 'read', 'db:orders');
```

### 再拿记录范围

```typescript
const scope = await pc.getRowScope('user-001', 'read', 'db:orders');
```

`getRowScope()` 适合两类场景：

- 你想在查库前把条件下推到自己的查询层
- 你想先看运行时最终合成出的范围结构

### 或者直接过滤记录

```typescript
const visibleOrders = await pc.filterRows('user-001', 'read', 'db:orders', orders);
```

如果你手头已经拿到了结果列表，`filterRows()` 通常是最直接的做法。

如果你额外传了 `context`，它会作为 `valueFrom` 的补充变量参与求值；但当前主体的 `userId` 始终以 API 参数为准，不会被 `context.userId` 覆盖。

## 再往下才是字段过滤

推荐把三层能力按下面顺序理解：

1. `can()` / `assert()`：集合门禁
2. `getRowScope()` / `canRow()` / `assertRow()` / `filterRows()`：记录范围
3. `filterFields()`：字段收口

也就是说，字段过滤不是行级权限的替代品，而是它后面的一层。

## 后台保存应该长什么样

如果你做的是管理后台，更稳妥的做法通常是直接维护规则数组，而不是让前端拼 MongoDB Query 或 SQL 片段：

```typescript
type RoleRuleInput = {
  type: 'allow' | 'deny';
  action: string;
  resource: string;
  where?: RowCondition;
};
```

这样做的好处是：

- 规则结构可以直接持久化
- 运行时还能继续走统一 API
- 后续如果你要把条件翻译到不同数据库，也有统一中间表示

## 当前边界

- 支持行级权限，但不支持把条件写成 MongoDB Query、SQL 片段或 JS callback
- 支持顶层字段条件，不支持 `owner.department.id` 这类嵌套路径
- permission-core 负责表达和判断，不负责自动拦截 ORM 或数据库查询

## 下一步看什么

- 想先理解资源格式为什么保持不变：看 [资源路径模型](/zh/guide/resource-paths)
- 想看集合、行、字段三层在运行时怎么串起来：看 [权限鉴权](/zh/guide/check-permission)
- 想直接看 `getRowScope()` / `canRow()` / `assertRow()` / `filterRows()` 串起来的真实代码：看 [行级权限示例](/zh/examples/row-level)
- 想看字段收口怎么落地：看 [字段过滤](/zh/guide/field-filter)