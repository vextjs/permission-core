# 字段过滤

字段过滤是 permission-core 中最直接体现“字段级数据权限”的能力之一。它通过 `filterFields()` 在对象级别删掉没有权限的字段。

## 它和集合权限是什么关系

字段过滤不是集合权限的替代品，而是第三层控制。

先有：

- `db:users`

再有：行级范围

- `where: { field: 'ownerId', op: 'eq', valueFrom: 'userId' }`

再有：

- `db:users:name`
- `db:users:email`

更合理的理解是：

- 集合权限决定“能不能处理这个对象”
- 行级权限决定“哪些记录还能继续进入后续流程”
- 字段权限决定“对象里哪些字段还能继续保留”

这也意味着：字段规则不能脱离集合权限单独工作。只有 `db:users:email` 但没有 `db:users` 时，`filterFields()` 不会因为字段规则存在就跳过集合门禁。

## 基本用法

```typescript
const safe = await pc.filterFields('user-002', 'read', 'db:users', user);
```

这会把每个字段转成新的资源路径，例如：

- `db:users:name`
- `db:users:email`
- `db:users:salary`

然后逐字段复用同一套鉴权逻辑。

这里还有一个实现细节：字段级 `where` 求值时，运行时会继续把整条对象作为 row 传入。也就是说，字段规则不仅能看当前字段名，还能引用同一对象里的其他字段，例如 `ownerId`、`departmentId`。

## 一个更完整的读场景

```typescript
await pc.assert('user-002', 'read', 'db:users');
await pc.assertRow('user-002', 'read', 'db:users', user);

const safe = await pc.filterFields('user-002', 'read', 'db:users', user);
```

推荐把它理解成两个阶段：

1. 先判断用户是否能读取 `db:users`
2. 如果规则带了 `where`，再判断这条记录是否可见
3. 最后判断这个对象的每个字段是否还能保留

## 适合场景

- 查询后做返回脱敏
- 写入前做字段白名单过滤
- 同一对象不同角色可见字段不同

## 写场景更要小心动作选择

写入过滤最常见的误区，是直接把动作写成 `write`。当前设计里，这通常会比预期更严格，因为请求侧 `write` 会展开成 `create && update`。

更推荐这样写：

```typescript
const createPayload = await pc.filterFields('user-002', 'create', 'db:users', data);
const updatePayload = await pc.filterFields('user-002', 'update', 'db:users', patch);
```

这样更贴近真实业务语义，也更容易解释为什么某个字段被过滤掉。

## 当前边界

- v1 只处理顶层字段
- 不支持嵌套字段
- 不自动代理数据库写入

再补一条容易被忽略的边界：字段过滤不会帮你自动决定“先查库还是先过滤”，这些步骤仍然需要业务层自己组织。

## `write` 不推荐直接用于过滤

因为请求侧 `write` 会展开成 `create && update`，在字段过滤里通常会过严。写入过滤更推荐明确用：

- `create`
- `update`

## 一个真实例子

```typescript
const safe = await pc.filterFields('user-002', 'read', 'db:employees', {
	name: 'Alice',
	title: 'Engineer',
	salary: 50000,
	internalLevel: 3,
});
```

如果当前角色只拥有：

- `db:employees`
- `db:employees:name`
- `db:employees:title`

那么最终只应保留：

- `name`
- `title`

而 `salary`、`internalLevel` 应该被过滤掉。

## 什么时候不该用字段过滤

- 只做接口权限时
- 只是想拦接口，不关心字段可见性时

如果你还需要控制“哪些记录能进入结果集”，先看 [行级权限](/zh/guide/row-level)。字段过滤负责的是记录已经进入之后的字段收口，不负责替代行级范围判断。

## 常见误区

- 只有字段权限，没有集合权限
- 希望它自动处理嵌套字段
- 把 `filterFields()` 当成数据库代理层

想了解数据和接口权限在运行时依赖什么存储，下一篇看 [存储适配器](/zh/guide/adapters)。

## 下一步看什么

- 想继续看接入前的确认项：看 [接入检查清单](/zh/guide/integration-checklist)
- 想看真实字段过滤落地方式：看 [字段权限示例](/zh/examples/field-permission)
- 想继续按接入顺序阅读：看 [接入阅读顺序](/zh/guide/implementation-reading-order)