# Authorized Collection

## Purpose and preconditions

`subject.data.collection()` wraps one MonSQLize collection with tenant scope, row policy, field permission, bounded Mongo-style filters, and write guards. Create it from a trusted subject after `init()`. Map every scope dimension present on the subject to an immutable scalar business-data field.

## Signatures

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

`AuthorizedCollectionOptions.scopeFields` maps `tenantId` and any active optional scope dimensions to business fields. `filter` is the caller's bounded Mongo query. Durable rule `where` conditions and exact scope equality are compiled and combined internally. Optional `transaction` is a MonSQLize transaction borrowed from the host.

## Responses and side effects

Reads return only fields allowed by field rules, intersected with caller projection. Inserts inject trusted scope fields and reject forbidden fields. Updates validate operator/path/value shape, pre-image policy, field writes, scope immutability, and post-image invariants. Bulk methods require an explicit maximum affected count.

```json
{
  "read": [{ "orderNo": "A-100", "merchantId": "m-7" }],
  "insert": { "acknowledged": true, "insertedId": "..." },
  "update": { "acknowledged": true, "matchedCount": 1, "modifiedCount": 1 },
  "delete": { "acknowledged": true, "deletedCount": 1 }
}
```

## Failures and limits

Important errors are `PERMISSION_DENIED`, `FIELD_PERMISSION_DENIED`, `POLICY_CONTEXT_MISSING`, `INVALID_FILTER`, `DATA_VALUE_UNSUPPORTED`, `DATA_OPERATION_UNSUPPORTED`, `SCOPE_FIELD_MAPPING_REQUIRED`, and `DATA_BULK_SCOPE_MUTATION_UNSAFE`. Filters are bounded to depth `12`, `256` nodes, `32` logical children, `100` set items, and `128 KiB`. Pages are at most `min(200, MonSQLize findMaxLimit)`. Updates allow `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$addToSet`, `$push`, and `$pull`, with `128` paths and `64 KiB` input bounds.

## Example

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

The caller filter, tenant equality, role `where`, and field projection all apply to this result.

## Related

See [Data Permissions](/guide/data-permissions), [Multi-Tenant Model](/guide/multi-tenant), and [Errors](/api/errors).
