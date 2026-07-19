# 授权集合 API

## 用途与前置条件

`subject.data.collection()` 用租户 scope、行策略、字段权限、有界 Mongo 风格 filter 和写守卫包装一个 MonSQLize collection。`init()` 后从可信主体创建。主体上出现的每个 scope 维度都必须映射到不可变的标量业务数据字段。

## 签名

```ts
subject.data.collection<TDocument extends object, TCreate extends object = Omit<TDocument, '_id'>>(
  name: string,
  options: AuthorizedCollectionOptions,
): AuthorizedCollection<TDocument, TCreate>

find(filter?: SafeMongoFilter, options?: AuthorizedReadOptions): Promise<AuthorizedDocument<TDocument>[]>
findOne(filter?: SafeMongoFilter, options?: AuthorizedFindOneOptions): Promise<AuthorizedDocument<TDocument> | null>
count(filter?: SafeMongoFilter, options?: Pick<AuthorizedReadOptions, 'maxTimeMS' | 'transaction'>): Promise<number>
findAndCount(filter?: SafeMongoFilter, options?: AuthorizedReadOptions): Promise<{ data: AuthorizedDocument<TDocument>[]; total: number }>
findPage(query?: AuthorizedPageQuery): Promise<AuthorizedPageResult<TDocument>>
insertOne(document: TCreate, options?: { transaction?: Transaction }): Promise<AuthorizedInsertResult>
updateOne(filter: SafeMongoFilter, update: SafeMongoUpdate, options?: { transaction?: Transaction }): Promise<AuthorizedUpdateResult>
updateMany(filter: SafeMongoFilter, update: SafeMongoUpdate, options: AuthorizedBulkWriteOptions): Promise<AuthorizedUpdateResult>
deleteOne(filter: SafeMongoFilter, options?: { transaction?: Transaction }): Promise<AuthorizedDeleteResult>
deleteMany(filter: SafeMongoFilter, options: AuthorizedBulkWriteOptions): Promise<AuthorizedDeleteResult>
```

`AuthorizedCollectionOptions.scopeFields` 将 `tenantId` 及已启用的可选 scope 维度映射到业务字段。`filter` 是调用者的有界 Mongo 查询。持久化规则 `where` 条件与精确 scope equality 会在内部编译并组合。可选 `transaction` 是从宿主借用的 MonSQLize transaction。

## 响应与副作用

读取只返回字段规则允许的字段，并与调用者 projection 取交集。插入注入可信 scope 字段并拒绝禁止字段。更新校验 operator/path/value 结构、pre-image 策略、字段写权限、scope 不可变性和 post-image 不变量。批量方法要求显式最大影响数量。

```json
{
  "read": [{ "orderNo": "A-100", "merchantId": "m-7" }],
  "insert": { "acknowledged": true, "insertedId": "..." },
  "update": { "acknowledged": true, "matchedCount": 1, "modifiedCount": 1 },
  "delete": { "acknowledged": true, "deletedCount": 1 }
}
```

## 失败与限制

重要错误包括 `PERMISSION_DENIED`、`FIELD_PERMISSION_DENIED`、`POLICY_CONTEXT_MISSING`、`INVALID_FILTER`、`DATA_VALUE_UNSUPPORTED`、`DATA_OPERATION_UNSUPPORTED`、`SCOPE_FIELD_MAPPING_REQUIRED`、`DATA_BULK_SCOPE_MUTATION_UNSAFE`。Filter 限制为深度 `12`、`256` 个节点、`32` 个逻辑子项、`100` 个集合项和 `128 KiB`。分页最大为 `min(200, MonSQLize findMaxLimit)`。Update 支持 `$set`、`$unset`、`$inc`、`$mul`、`$min`、`$max`、`$addToSet`、`$push`、`$pull`，限制 `128` 个路径和 `64 KiB` 输入。

## 示例

```ts
const orders = subject.data.collection('orders', {
  resource: 'db:orders',
  scopeFields: { tenantId: 'tenantId' },
});
const result = await orders.find(
  { status: { $in: ['paid', 'shipped'] } },
  { projection: ['orderNo', 'merchantId'], limit: 20 },
);
```

```json
[{ "orderNo": "A-100", "merchantId": "m-7" }]
```

调用者 filter、租户 equality、角色 `where` 和字段 projection 会同时作用于该结果。

## 相关内容

参见[数据权限](/zh/guide/data-permissions)、[多租户模型](/zh/guide/multi-tenant)和[错误 API](/zh/api/errors)。
