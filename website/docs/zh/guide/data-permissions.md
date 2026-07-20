# 数据权限

> **数据权限边界。** 业务 `filter`、完整 scope 条件、行规则和字段权限会在受保护集合内共同生效；不要绕过 `subject.data.collection()` 直接查询后再把权限条件交给调用方自行拼接。

`AuthorizedCollection` 是受支持的数据访问边界。它运行在宿主 MonSQLize 3.1 的事务运行时上，在操作到达 MongoDB 前把应用查询与授权条件组合起来。

<span id="data-filter-vs-where"></span>
## `filter` 与 `where` 职责不同

- `filter` 是调用方针对一次操作提供的 Mongo 风格业务查询，例如 `{ status: 'paid' }`。
- `where` 是持久化在 allow 或 deny 规则上的策略条件，例如“merchantId 等于 subject claim”。
- `scopeFields` 把可信 scope 维度映射到每个业务文档中的精确标量字段。

```ts
await scoped.roles.allow('merchant-reader', {
  action: 'read',
  resource: 'db:orders',
  where: { field: 'merchantId', op: 'eq', valueFrom: 'claims.merchantId' },
});

const orders = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme' },
  claims: { merchantId: 'm-1' },
}).data.collection('orders', {
  resource: 'db:orders',
  scopeFields: { tenantId: 'tenantId' },
});

const rows = await orders.find({ status: 'paid' });
```

这里的 `scopeFields: { tenantId: 'tenantId' }` 不是把租户固定为 `tenantId`，也不是写入租户值。左侧 `tenantId` 指 `subject.scope.tenantId`，右侧 `'tenantId'` 指业务文档里的字段路径。因此当当前 subject 的 scope 是 `{ tenantId: 'acme' }` 时，集合会在每次真实 Mongo 操作中强制加入“文档 `tenantId` 字段等于 `acme`”这一类精确条件。

如果写成 `scopeFields: { tenantId: 'acme' }`，含义会变成把 `subject.scope.tenantId` 映射到文档字段 `acme`，也就是检查文档的 `acme` 字段，而不是检查文档的 `tenantId` 字段。只有当业务文档真的有这个字段时才有意义；通常这不是想要的多租户映射。

| 调用 | 参数与来源 | 状态/原始返回 |
|---|---|---|
| [`roles.allow(roleId, rule)`](/zh/api/roles#roles-allow) | `where` 是持久化策略 AST；`valueFrom='claims.merchantId'` 在请求时读取可信 claim | 写入角色规则并返回 mutation envelope |
| [`pc.forSubject(input)`](/zh/api/core-and-contexts#core-for-subject) | user/scope/claims 必须来自认证边界 | 同步返回 subject，不访问数据库 |
| [`subject.data.collection(name, options)`](/zh/api/authorized-collection#authorized-collection-factory) | 物理 collection `orders`；逻辑资源和 scope 字段映射 | 同步返回受保护 facade，不返回数据 |
| [`orders.find(filter, options?)`](/zh/api/authorized-collection#authorized-find) | 本次业务 filter `{ status:'paid' }` | 返回授权与字段裁剪后的原始文档数组，无 management envelope |

最终 Mongo 条件在逻辑上等于：

```text
调用方 filter AND 精确租户条件 AND 命中的 allow AND NOT 命中的 deny
```

公开 API 不会只返回一个授权 filter 让调用方之后选择是否使用。集合会直接执行组合后的条件，调用方无法忘记或替换权限条件。

也不会接受 `rows: (subject) => ...` 一类持久化函数。函数无法稳定序列化、审计、跨进程重放或比较版本；需要计算的业务值应先由认证/业务层写入可信 `claims` 或本次 `context`，再由 `valueFrom` 引用。

## 多个策略条件

策略组合使用可序列化的 `all`、`any` 和 `not` 节点：

```ts
where: {
  all: [
    { field: 'status', op: 'in', value: ['open', 'paid'] },
    {
      any: [
        { field: 'merchantId', op: 'eq', valueFrom: 'claims.merchantId' },
        { field: 'ownerId', op: 'eq', valueFrom: 'subject.userId' },
      ],
    },
    { not: { field: 'risk', op: 'eq', value: 'blocked' } },
  ],
}
```

叶子操作符包括 `eq`、`ne`、`in`、`nin`、`gt`、`gte`、`lt`、`lte`、`contains` 和 `exists`。`valueFrom` 可以读取可信 subject、claims 或显式策略上下文。缺少动态上下文时条件为 unknown，并收紧授权而不会扩大权限。

规则有意不支持持久化任意 JavaScript 行函数。函数无法规范化持久化、审计、比较、跨进程缓存，也无法由另一个服务实例稳定复现。应用特有计算应放入可信 claims/context，再从持久化条件 AST 引用其标量结果。

## Mongo 风格调用方查询

调用方 filter 支持有界的纯数据 Mongo 操作符，包括 `$and`、`$or`、`$nor`、比较与集合操作符、`$exists`、可选 `i` 的字面量 `$regex`、`$not`、`$elemMatch`、`$all` 和 `$size`。JavaScript 谓词、Proxy、访问器、`$where` 和任意操作符会被拒绝。

安全 filter 最多 12 层、256 个节点、每个逻辑节点 32 个子项和 128 KiB 规范化字节，用于限制授权审查与数据库成本。

## 字段权限

一旦存在字段规则，每个投影、过滤、排序或修改字段都必须获得对应操作授权，防止调用方通过过滤或排序推断隐藏值。

```ts
await scoped.roles.allow('merchant-reader', {
  action: 'read', resource: 'db:orders:field:status',
});
await scoped.roles.allow('merchant-reader', {
  action: 'read', resource: 'db:orders:field:publicValue',
});
await scoped.roles.deny('merchant-reader', {
  action: 'read', resource: 'db:orders:field:secret',
});

const safe = await orders.find(
  { status: 'paid' },
  { projection: ['publicValue'] },
);
```

```json
[{ "publicValue": "shown" }]
```

这是 `orders.find()` 的原始数组响应。两次字段 `roles.allow()` 各自返回独立 mutation envelope，示例没有展示它们的返回，是因为本节关注读取结果；生产初始化应检查写入错误。

`projection: ['publicValue']` 是调用方期望字段，最终仍受字段 allow/deny 收紧。filter 中的 `status` 也需要 read 字段权限，即使它没有出现在响应 projection 中。

请求 `secret`、用它过滤，或在没有无条件查询授权时按条件字段排序，都会抛出 `FIELD_PERMISSION_DENIED`。

## 受保护的读写操作

门面支持 `find`、`findOne`、`count`、`findAndCount`、签名游标 `findPage`、`insertOne`、`updateOne`、`updateMany`、`deleteOne` 和 `deleteMany`。插入会校验授权后的 post-image，并从可信 subject 注入 scope 字段。更新同时检查 pre-image 与 post-image，包括字段规则和 scope 保持。

| 任务 | 方法 | 原始返回 |
|---|---|---|
| 多条/单条读取 | [`find`](/zh/api/authorized-collection#authorized-find) / [`findOne`](/zh/api/authorized-collection#authorized-find-one) | 裁剪后的文档数组 / 文档或 `null` |
| 统计/列表统计 | [`count`](/zh/api/authorized-collection#authorized-count) / [`findAndCount`](/zh/api/authorized-collection#authorized-find-and-count) | number / `{ data, total }` |
| 游标分页 | [`findPage`](/zh/api/authorized-collection#authorized-find-page) | `{ items, pageInfo, total? }` |
| 创建 | [`insertOne`](/zh/api/authorized-collection#authorized-insert-one) | `{ acknowledged, insertedId }` |
| 单条/批量更新 | [`updateOne`](/zh/api/authorized-collection#authorized-update-one) / [`updateMany`](/zh/api/authorized-collection#authorized-update-many) | `{ acknowledged, matchedCount, modifiedCount }` |
| 单条/批量删除 | [`deleteOne`](/zh/api/authorized-collection#authorized-delete-one) / [`deleteMany`](/zh/api/authorized-collection#authorized-delete-many) | `{ acknowledged, deletedCount }` |

```ts
await scoped.roles.allow('owner-writer', {
  action: 'update',
  resource: 'db:orders',
  where: { field: 'ownerId', op: 'eq', valueFrom: 'subject.userId' },
});

const result = await orders.updateOne(
  { ownerId: 'u-1' },
  { $set: { status: 'paid' } },
);
```

```json
{ "acknowledged": true, "matchedCount": 1, "modifiedCount": 1 }
```

这是 `updateOne()` 的完整业务结果对象。`matchedCount=0` 表示授权组合后没有候选；如果调用方试图修改无权限字段或 scope 字段，则会显式抛错，而不是悄悄返回 0。

批量更新和删除必须提供 1～1000 的 `maxAffected`，实际 pre-image 数量超过上限时事务中止。支持的更新操作符为 `$set`、`$unset`、`$inc`、`$mul`、`$min`、`$max`、`$addToSet`、`$push` 和 `$pull`。

## 事务与所有权边界

每个操作都使用真实 MonSQLize 事务。可选借用的 MonSQLize `Transaction` 必须属于同一运行时，其所有权仍在调用方；permission-core 不会替调用方提交或回滚借用事务。物理集合名属于应用配置，逻辑 `resource` 才是授权契约。

完整响应与边界请查看可运行的[数据保护示例](/zh/examples/data-guard)和[授权集合 API](/zh/api/authorized-collection)。
