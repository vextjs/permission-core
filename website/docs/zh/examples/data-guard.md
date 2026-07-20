# 数据保护

## 场景

该示例针对真实 MonSQLize collection 组合调用者 Mongo filter、精确租户隔离、角色 `where` 条件、字段 projection、insert/update 所有权检查，以及字段/写入拒绝。

## 运行

```bash
npm run example:data-guard
```

规范源码是 `examples/data-guard.mjs` 中 `docs:data-guard:start` 到 `docs:data-guard:end` 的内容。

## 先看结果

运行成功先确认 `matchedCount: 1`、`deniedFieldCode: 'FIELD_PERMISSION_DENIED'`、`writeGuard.deniedWriteCode: 'PERMISSION_DENIED'` 和 `persistedRows: 5`。它们分别证明行条件、字段拒绝、写入拒绝与“拒绝数据未落库”。

## 源码解读

先建立角色的行、字段和写入规则：

```js
await scoped.roles.create({ id: 'merchant-reader', label: 'Merchant reader' });
await scoped.roles.allow('merchant-reader', {
  action: 'read',
  resource: 'db:orders',
  where: { field: 'merchantId', op: 'eq', valueFrom: 'claims.merchantId' },
});
for (const field of ['merchantId', 'publicValue', 'status', 'ownerId']) {
  await scoped.roles.allow('merchant-reader', {
    action: 'read', resource: `db:orders:field:${field}`,
  });
}
await scoped.roles.deny('merchant-reader', {
  action: 'read', resource: 'db:orders:field:secret',
});
for (const action of ['create', 'update']) {
  await scoped.roles.allow('merchant-reader', {
    action,
    resource: 'db:orders',
    where: { field: 'ownerId', op: 'eq', valueFrom: 'subject.userId' },
  });
}
await scoped.roles.allow('merchant-reader', {
  action: 'update', resource: 'db:orders:field:ownerId',
});
await scoped.roles.allow('merchant-reader', {
  action: 'update', resource: 'db:orders:field:status',
});
await scoped.userRoles.assign('u-data', 'merchant-reader');
```

下面创建受保护 collection 并执行成功/失败探针：

```js
const orders = core.forSubject({
  userId: 'u-data', scope, claims: { merchantId: 'm-1' },
}).data.collection('example_orders', {
  resource: 'db:orders',
  scopeFields: { tenantId: 'tenantId' },
});

const rows = await orders.find(
  { status: 'paid' },
  { projection: ['merchantId', 'publicValue'] },
);

let deniedFieldCode = null;
try {
  await orders.find({}, { projection: ['secret'] });
} catch (error) {
  deniedFieldCode = error.code;
}

const inserted = await orders.insertOne({
  merchantId: 'm-1', ownerId: 'u-data', status: 'draft', publicValue: 'new order',
});
const updated = await orders.updateOne(
  { ownerId: 'u-data' },
  { $set: { status: 'paid' } },
);
let deniedWriteCode = null;
try {
  await orders.insertOne({
    merchantId: 'm-1', ownerId: 'another-user',
    status: 'draft', publicValue: 'must not persist',
  });
} catch (error) {
  deniedWriteCode = error.code;
}
```

调用者 filter 会与 `tenantId`、持久化的 `merchantId = claims.merchantId` 条件及允许字段 projection 做 AND 组合。写入另外证明 pre/post ownership 约束。

### 1. 定义行、字段与写入策略

<!-- docs:operation id=data-policy calls=roles.create,roles.allow,roles.deny,userRoles.assign outputs=composition -->

**目的与目标。** `roles.create` 创建 `merchant-reader`；多次 `roles.allow` 允许 collection/field 读取和受保护写入；`roles.deny` 阻止 `secret`；`userRoles.assign` 把策略绑定给 `u-data`。

**状态、参数与结果。** collection 级读取规则存储可序列化 `where` 条件，用于解析 `claims.merchantId`；create/update 规则解析 `subject.userId` 以检查 ownership。字段 resource 独立控制 filter、projection 与 mutation。`composition` 列出后续读取实际展示的四层约束。

**失败与下一步。** 缺少字段权限、`valueFrom` 无法解析或 allow/deny 冲突时会 fail closed。应修正角色策略或可信 claims 后重试业务操作，不能用 raw collection 绕过 guard。

**API 参考。** 参见[角色 API](/zh/api/roles)了解规则 mutation，并参见[资源与规则](/zh/guide/resources-and-rules)了解 `where`、字段 resource 与 deny precedence。

| 方法 | 关键参数 | 原始返回/状态 |
|---|---|---|
| `roles.create(input)` | 角色 id/label | `MutationResult<Role>`，建立空角色 |
| `roles.allow(roleId, rule)` | action/resource，可选 where | 每次追加一条 manual allow，并返回规则 mutation envelope |
| `roles.deny(roleId, rule)` | 本例字段 secret read | 追加显式 deny；不删除 collection allow |
| `userRoles.assign(userId, roleId)` | `u-data` + 角色 ID | 返回提交后的直接角色 binding set |

### 2. 创建授权集合

<!-- docs:operation id=data-collection calls=forSubject,data.collection outputs=matchedRows,matchedCount,deniedFieldCode,writeGuard,persistedRows -->

**目的与目标。** `forSubject` 创建可信 subject，再由 `data.collection` 包装 `example_orders`，使每个受支持操作都检查 `db:orders` 策略，并把活动租户 scope 映射到行的 `tenantId` 字段。

**状态、参数与结果。** subject 携带可信 `scope` 与 `claims`；collection option 携带权限 resource 与 `scopeFields`。该 wrapper 是后续所有读写的强制边界；raw handle 只用于准备和统计 fixture 数据。

**失败与下一步。** 缺少 scope mapping、subject context 无效、策略状态不可用或操作不受支持时，会在不安全数据访问前拒绝。修正 mapping/context 后重新使用授权 wrapper；raw MonSQLize 访问不是应用流量的 fallback。

**API 参考。** 参见[授权集合 API](/zh/api/authorized-collection)，了解构造方式、scope mapping、支持操作与失败。

`forSubject(input)` 同步绑定可信 `userId/scope/claims`；`data.collection(name, options)` 也同步返回 facade。二者都不查询业务数据，第一次数据库读写发生在 `find()`。

### 3. 使用组合约束读取

<!-- docs:operation id=data-read calls=find outputs=matchedRows,matchedCount,deniedFieldCode -->

**目的与目标。** 第一次 `find` 请求 paid order，并只投影 `merchantId` 与 `publicValue`；第二次故意请求被拒绝的 `secret` 字段，用于证明 projection guard 生效。

**状态、参数与结果。** 调用者 filter 会与精确租户相等条件及角色 merchant 条件做 AND；projection 再与允许字段求交，因此只有一行匹配。成功结果生成 `matchedRows`/`matchedCount`，被拒绝的 projection 提供 `FIELD_PERMISSION_DENIED`。

**失败与下一步。** filter/projection 字段无权或策略值无法解析时，整个读取会被拒绝，不会静默返回更宽数据。应请求允许字段或更新经审查的策略，不能捕获错误后去掉授权重新查询。

**API 参考。** 参见[授权集合 API](/zh/api/authorized-collection)，了解 `find`、Mongo filter 组合、projection 规则与字段错误。

成功 `find(filter, options)` 的原始返回就是裁剪后的数组 `rows`；故意读取 secret 的第二次 `find()` 不返回数组，而是 reject `PermissionCoreError`，示例只提取其 `code`。

### 4. 在写入前后强制所有权

<!-- docs:operation id=data-write calls=insertOne,updateOne outputs=writeGuard,persistedRows -->

**目的与目标。** `insertOne` 接受归 `u-data` 所有的 order；`updateOne` 修改该用户的行；第二次 insert 使用 `ownerId: 'another-user'`，预期失败。

**状态、参数与结果。** guard 注入可信 scope 字段，并针对最终行检查 create/update `where` 策略。insert acknowledged 和恰好一个 modified row 分别成为 `writeGuard.inserted/updated`；被拒绝的 insert 提供 `PERMISSION_DENIED`，且不会增加持久化数据。

**失败与下一步。** ownership 不匹配、字段 mutation 被禁止、策略过期或事务失败时会拒绝写入。应返回授权错误或修正可信输入，不能为了通过 guard 而改写 ownership。

**API 参考。** 参见[授权集合 API](/zh/api/authorized-collection)，了解写 guard、transaction option、结果形态与拒绝 mutation。

`insertOne()` 原始返回 `{ acknowledged, insertedId }`；`updateOne()` 返回 `{ acknowledged, matchedCount, modifiedCount }`。错误 owner 的 insert reject，`deniedWriteCode` 是 catch 后的摘要字段，并非方法返回。

## 预期输出

以下 JSON 是 `printExample()` 将多个管理响应、业务数组、错误和 fixture 计数组合后的**示例汇总输出**，不是任何单个 API 的原始响应。

```json
{
  "example": "data-guard",
  "ok": true,
  "composition": ["caller filter", "tenant scope", "role where", "field projection"],
  "matchedRows": [{ "merchantId": "m-1", "publicValue": "visible" }],
  "matchedCount": 1,
  "deniedFieldCode": "FIELD_PERMISSION_DENIED",
  "writeGuard": {
    "inserted": true,
    "updated": true,
    "deniedWriteCode": "PERMISSION_DENIED"
  },
  "persistedRows": 5
}
```

<!-- docs:output group=composition producer=data-policy -->

**`composition` 来源。** 示例汇总由 `roles.allow`/`roles.deny` 建立、并由成功 `find` 应用的约束：caller filter、tenant scope、role `where`，最后是 field projection。

<!-- docs:output group=matchedRows producer=data-read -->

**`matchedRows` 来源。** 成功的授权 `find` 返回唯一满足全部行约束的记录，并已经缩减为请求且允许的两个字段。

<!-- docs:output group=matchedCount producer=data-read -->

**`matchedCount` 来源。** 该值是 `find` 返回的 `matchedRows` length，用于明确成功结果只有一条，而不是 collection 总记录数。

<!-- docs:output group=deniedFieldCode producer=data-read -->

**`deniedFieldCode` 来源。** 示例只捕获故意用 `find` 投影 `secret` 的失败并记录权限错误码；若值为 null，说明负向探针没有生效。

<!-- docs:output group=writeGuard producer=data-write -->

**`writeGuard` 来源。** 前两个布尔值来自成功的 `insertOne`/`updateOne` 结果；`deniedWriteCode` 来自故意使用错误 owner 的 insert。

<!-- docs:output group=persistedRows producer=data-write -->

**`persistedRows` 来源。** 两次 `insertOne` 完成后使用仅限 fixture 的 raw count。四条 seed row 加一条成功 insert 等于五，证明拒绝的 insert 未持久化。

## 生产边界

示例在使用 guard 前写入 raw fixture 数据；生产应用读写应使用 `AuthorizedCollection`。权限保护写入需要与业务事务共享时，传入宿主 transaction。不要持久化任意 JavaScript 行函数；应使用可序列化 `where` 条件和可信 context。

## 相关内容

参见[数据权限](/zh/guide/data-permissions)、[授权集合 API](/zh/api/authorized-collection)和[资源与规则](/zh/guide/resources-and-rules)。
