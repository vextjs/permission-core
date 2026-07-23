# Authorized Collection
<!-- docs:inline-parity `subject.data.collection()` `init()` `AuthorizedCollectionOptions.scopeFields` `tenantId` `filter` `where` `transaction` `AuthorizedCollectionOptions` `resource` `db:orders` `read/create/update/delete` `scopeFields.tenantId` `subject.scope.tenantId` `scopeFields.appId/moduleId/namespace` `projection` `find/findOne/findAndCount/findPage` `0/1` `sort` `count` `{ field: 1|-1 }` `limit` `find/findAndCount` `findMaxLimit` `findPage` `first/last` `maxTimeMS` `maxAffected` `updateMany/deleteMany` `1..1000` `SafeMongoFilter` `$where` `subject.data.collection(name, options)` `name` `options.resource/scopeFields` `AuthorizedCollection` `find(filter?, options?)` `AuthorizedDocument<T>[]` `T` `read` `findOne(filter?, options?)` `find` `AuthorizedDocument<T> | null` `null` `count(filter?, options?)` `maxTimeMS/transaction` `number` `findAndCount(filter?, options?)` `data` `total` `{ data: AuthorizedDocument<T>[], total: number }` `findPage(query?)` `first/after` `last/before` `totals=true` `AuthorizedPageResult<T>` `items/pageInfo` `insertOne(document, options?)` `create` `{ acknowledged: true, insertedId }` `updateOne(filter, update, options?)` `{ acknowledged: true, matchedCount, modifiedCount }` `0` `updateMany(filter, update, options)` `options.maxAffected` `AuthorizedUpdateResult` `deleteOne(filter, options?)` `{ acknowledged: true, deletedCount }` `deleteMany(filter, options)` `AuthorizedDeleteResult` `deletedCount` `PERMISSION_DENIED` `FIELD_PERMISSION_DENIED` `POLICY_CONTEXT_MISSING` `INVALID_FILTER` `DATA_VALUE_UNSUPPORTED` `DATA_OPERATION_UNSUPPORTED` `SCOPE_FIELD_MAPPING_REQUIRED` `DATA_BULK_SCOPE_MUTATION_UNSAFE` `12` `256` `32` `100` `128 KiB` `min(200, MonSQLize findMaxLimit)` `$set` `$unset` `$inc` `$mul` `$min` `$max` `$addToSet` `$push` `$pull` `128` `64 KiB` -->

`subject.data.collection()` creates the guarded data facade that combines caller filters, scope fields, policy `where`, field permissions, and MonSQLize operations.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want To Do

| Goal | Entry point |
|---|---|
| Create a protected collection facade | [`subject.data.collection(name, options)`](#authorized-collection-factory) |
| Read, count, or paginate authorized rows | [`find()`](#authorized-find), [`findAndCount()`](#authorized-find-and-count), [`findPage()`](#authorized-find-page) |
| Create, update, or delete business documents | [`insertOne()`](#authorized-insert-one), [`updateOne()`](#authorized-update-one), [`deleteOne()`](#authorized-delete-one) |
| Diagnose filter, field, or scope failures | [Failures and limits](#failures-and-limits) |

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

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
## Parameter Objects

The table explains object fields that are easy to confuse at call sites. Required fields are validated before the method mutates persistent authorization state.

<!-- docs:params owner=AuthorizedCollectionOptions locale=en -->
### `AuthorizedCollectionOptions`
<!-- docs:params owner=AuthorizedReadOptions locale=en -->
### Query and Write Options
## Method Details

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

<span id="authorized-collection-factory"></span>
### `subject.data.collection(name, options)`
<!-- docs:method name=subject.data.collection locale=en -->

- **Purpose**: Create an `AuthorizedCollection` bound to the subject, collection name, scope mapping, and optional field policy.
- **Parameters**: Pass trusted host state only: normalized scope, authenticated user ID, claims/context, and collection options that map every active scope field.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-find"></span>
### `find(filter?, options?)`
<!-- docs:method name=authorizedCollection.find locale=en -->

- **Purpose**: Run a scoped find query after permission-core merges tenant scope, row filters, and field projection.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-find-one"></span>
### `findOne(filter?, options?)`
<!-- docs:method name=authorizedCollection.findOne locale=en -->

- **Purpose**: Read the first authorized document that matches the caller's filter after scope and row rules are applied.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-count"></span>
### `count(filter?, options?)`
<!-- docs:method name=authorizedCollection.count locale=en -->

- **Purpose**: Count only the documents visible to the subject after scope and row filters are merged.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-find-and-count"></span>
### `findAndCount(filter?, options?)`
<!-- docs:method name=authorizedCollection.findAndCount locale=en -->

- **Purpose**: Fetch authorized rows and the matching authorized count in one helper for offset-style pages.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-find-page"></span>
### `findPage(query?)`
<!-- docs:method name=authorizedCollection.findPage locale=en -->

- **Purpose**: Fetch a signed-cursor page while preserving the same permission scope and filter constraints across page turns.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `PageResult<T>` or the documented paged business result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-insert-one"></span>
### `insertOne(document, options?)`
<!-- docs:method name=authorizedCollection.insertOne locale=en -->

- **Purpose**: Insert one document only when the subject has write permission and the payload satisfies scope and field rules.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-update-one"></span>
### `updateOne(filter, update, options?)`
<!-- docs:method name=authorizedCollection.updateOne locale=en -->

- **Purpose**: Update one authorized document after merging scope filters and checking writeable fields.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-update-many"></span>
### `updateMany(filter, update, options)`
<!-- docs:method name=authorizedCollection.updateMany locale=en -->

- **Purpose**: Update many authorized documents while applying the same scope, row, and field checks to the bulk operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-delete-one"></span>
### `deleteOne(filter, options?)`
<!-- docs:method name=authorizedCollection.deleteOne locale=en -->

- **Purpose**: Delete one document only if it is visible to the subject and the subject has delete permission.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="authorized-delete-many"></span>
### `deleteMany(filter, options)`
<!-- docs:method name=authorizedCollection.deleteMany locale=en -->

- **Purpose**: Delete multiple authorized documents while fail-closed scope and row filters prevent cross-tenant deletion.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "read": [{ "orderNo": "A-100", "merchantId": "m-7" }],
  "insert": { "acknowledged": true, "insertedId": "..." },
  "update": { "acknowledged": true, "matchedCount": 1, "modifiedCount": 1 },
  "delete": { "acknowledged": true, "deletedCount": 1 }
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

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
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Audit and Health](/api/audit-and-health).
