# 授权集合 API

## 用途与前置条件

`subject.data.collection()` 用租户 scope、行策略、字段权限、有界 Mongo 风格 filter 和写守卫包装一个 MonSQLize collection。`init()` 后从可信主体创建。主体上出现的每个 scope 维度都必须映射到不可变的标量业务数据字段。

## 我想做什么

| 目标 | 入口 |
|---|---|
| 创建受保护集合门面 | [`subject.data.collection(name, options)`](#authorized-collection-factory) |
| 授权读取、统计或分页 | [`find()`](#authorized-find)、[`findAndCount()`](#authorized-find-and-count)、[`findPage()`](#authorized-find-page) |
| 授权创建、更新或删除业务文档 | [`insertOne()`](#authorized-insert-one)、[`updateOne()`](#authorized-update-one)、[`deleteOne()`](#authorized-delete-one) |
| 排查 filter、字段或 scope 失败 | [失败与限制](#failures-and-limits) |

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

## 参数对象

<!-- docs:params owner=AuthorizedCollectionOptions locale=zh -->

### `AuthorizedCollectionOptions`

| 字段 | 必填 | 作用与约束 |
|---|---|---|
| `resource` | 是 | 逻辑数据资源，例如 `db:orders`；方法会在此基础上检查 `read/create/update/delete` 及字段资源。它不必等于物理 collection 名。 |
| `scopeFields.tenantId` | 是 | 把可信 `subject.scope.tenantId` 映射到文档标量字段，例如 `tenantId`。所有读写都会强制该 equality。 |
| `scopeFields.appId/moduleId/namespace` | 条件必填 | subject scope 中存在相应维度时必须映射；不存在的维度不要虚构映射。 |

scope 字段由权限门面注入或校验，业务代码不能通过 filter/update 覆盖。collection 在创建 facade 时不会访问数据库；真正的权限编译和 MonSQLize 调用发生在每个方法中。

<!-- docs:params owner=AuthorizedReadOptions locale=zh -->

### 查询和写入选项

| 字段 | 适用方法 | 语义 |
|---|---|---|
| `filter` | 所有读/更新/删除 | 本次业务查询；会与 scope equality、allow where、deny 取反组合，绝不会替代授权条件。 |
| `projection` | `find/findOne/findAndCount/findPage` | 字段名数组或 Mongo `0/1` 投影；最终结果是调用方 projection 与字段权限的安全交集。 |
| `sort` | 同上（`count` 除外） | `{ field: 1|-1 }`；排序字段也必须可读取，避免侧信道。 |
| `limit` | `find/findAndCount` | 正整数并受 MonSQLize `findMaxLimit` 约束；`findPage` 使用 `first/last`。 |
| `maxTimeMS` | 读取方法 | 传给底层受控查询的超时预算。 |
| `transaction` | 全部方法 | 借用宿主 MonSQLize transaction；必须来自同一运行时，提交/回滚仍由调用方负责。 |
| `maxAffected` | `updateMany/deleteMany` | 必填 `1..1000`；授权后的候选 pre-image 超过上限时整个事务中止。 |

`SafeMongoFilter` 是纯数据 Mongo 风格对象，不接受函数、Proxy、访问器、`$where` 或任意扩展操作符。持久化策略仍使用可审计的 `where` AST；两者的职责见[数据权限](/zh/guide/data-permissions#data-filter-vs-where)。

## 方法详解

<span id="authorized-collection-factory"></span>
### `subject.data.collection(name, options)`

<!-- docs:method name=subject.data.collection locale=zh -->

- **用途**：为一个物理 MonSQLize collection 创建绑定当前 subject/scope/resource 的受保护 facade。
- **参数**：`name` 是宿主 collection 名；`options.resource/scopeFields` 是授权契约。
- **状态影响**：不读写数据库，也不缓存业务查询结果。
- **原始返回**：同步返回 `AuthorizedCollection` 对象；它不是 Promise，也不会返回 collection 数据。

<span id="authorized-find"></span>
### `find(filter?, options?)`

<!-- docs:method name=authorizedCollection.find locale=zh -->

- **用途**：读取符合业务 filter 且同时满足 scope、行规则和字段规则的多条文档。
- **参数**：filter 可省略为“全部业务行”，但授权条件仍强制；options 可传 projection/sort/limit/maxTimeMS/transaction。
- **状态影响**：只读。
- **原始返回**：`AuthorizedDocument<T>[]`，即可能因字段权限而只含 `T` 的部分字段；没有 envelope。
- **常见失败**：无 `read` 权限、filter/投影/排序字段无权限、查询结构超限或策略上下文缺失。

<span id="authorized-find-one"></span>
### `findOne(filter?, options?)`

<!-- docs:method name=authorizedCollection.findOne locale=zh -->

- **用途**：按相同授权组合读取第一条匹配文档。
- **参数**：与 `find` 相同，但 options 不接受 `limit`。
- **状态影响**：只读。
- **原始返回**：`AuthorizedDocument<T> | null`；`null` 可能表示业务数据不存在，也可能表示没有任何行满足有效 allow，不能据此推断其他租户数据。

<span id="authorized-count"></span>
### `count(filter?, options?)`

<!-- docs:method name=authorizedCollection.count locale=zh -->

- **用途**：统计授权后可见且匹配业务 filter 的文档数量。
- **参数**：filter；options 仅含 `maxTimeMS/transaction`。
- **状态影响**：只读。
- **原始返回**：`number`，不是全 collection 总量，也不会忽略行级 deny。

<span id="authorized-find-and-count"></span>
### `findAndCount(filter?, options?)`

<!-- docs:method name=authorizedCollection.findAndCount locale=zh -->

- **用途**：为传统 offset/limit 风格列表同时获得当前页数据和授权后的总数。
- **参数**：filter 与读取 options；`limit` 只限制 `data`，不改变 `total` 的授权统计范围。
- **状态影响**：只读。
- **原始返回**：`{ data: AuthorizedDocument<T>[], total: number }`；这不是 PermissionCore management envelope。

<span id="authorized-find-page"></span>
### `findPage(query?)`

<!-- docs:method name=authorizedCollection.findPage locale=zh -->

- **用途**：使用签名游标进行稳定、有界的前向或后向分页。
- **参数**：业务 `filter` 与 projection/sort/maxTimeMS/transaction；前向用 `first/after`，后向用 `last/before`，两组不能混用；`totals=true` 才计算 total。
- **状态影响**：只读。
- **原始返回**：`AuthorizedPageResult<T>`，含 `items/pageInfo`，仅请求 totals 时含 `total`；游标只能用于同一查询契约。

<span id="authorized-insert-one"></span>
### `insertOne(document, options?)`

<!-- docs:method name=authorizedCollection.insertOne locale=zh -->

- **用途**：在 `create` 权限与字段规则保护下插入一条文档。
- **参数**：业务创建对象；可选 transaction。调用方可省略 scope 字段，门面从可信 subject 注入；传入冲突值会被拒绝。
- **状态影响**：校验 post-image 后插入一条数据。
- **原始返回**：`{ acknowledged: true, insertedId }`。
- **常见失败**：缺少 create/字段权限、写入禁止字段、scope 冲突或 post-image 不满足行策略。

<span id="authorized-update-one"></span>
### `updateOne(filter, update, options?)`

<!-- docs:method name=authorizedCollection.updateOne locale=zh -->

- **用途**：更新第一条同时满足业务 filter、scope 和 update 行策略的文档。
- **参数**：filter 必填；update 只能使用受支持操作符和有界字段路径；可选 transaction。
- **状态影响**：在事务中检查 pre-image、字段写权限、scope 不可变和 post-image 后更新。
- **原始返回**：`{ acknowledged: true, matchedCount, modifiedCount }`；无授权匹配时通常为 `0`，无权修改字段则显式抛错。

<span id="authorized-update-many"></span>
### `updateMany(filter, update, options)`

<!-- docs:method name=authorizedCollection.updateMany locale=zh -->

- **用途**：批量更新授权后候选集合，同时给调用方明确的影响上限。
- **参数**：filter/update；`options.maxAffected` 必填，transaction 可选。
- **状态影响**：先在同一事务读取并验证全部候选 pre/post-image，数量超过上限或任何一项失败则整体中止。
- **原始返回**：`AuthorizedUpdateResult`；不返回修改后的文档。

<span id="authorized-delete-one"></span>
### `deleteOne(filter, options?)`

<!-- docs:method name=authorizedCollection.deleteOne locale=zh -->

- **用途**：删除第一条满足业务 filter、scope 和 delete 行策略的文档。
- **参数**：filter 必填；可选 transaction。
- **状态影响**：授权检查通过后删除至多一条。
- **原始返回**：`{ acknowledged: true, deletedCount }`。

<span id="authorized-delete-many"></span>
### `deleteMany(filter, options)`

<!-- docs:method name=authorizedCollection.deleteMany locale=zh -->

- **用途**：有界批量删除授权后的候选文档。
- **参数**：filter；`options.maxAffected` 必填并可附 transaction。
- **状态影响**：在事务内验证候选数量和每条 delete 策略；超过上限时不做部分删除。
- **原始返回**：`AuthorizedDeleteResult`；`deletedCount` 是本次实际删除数。

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
