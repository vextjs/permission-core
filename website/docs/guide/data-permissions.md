# Data Permissions
<!-- docs:inline-parity `filter` `subject.data.collection()` `AuthorizedCollection` `where` `{ status: 'paid' }` `scopeFields` `roles.allow(roleId, rule)` `valueFrom='claims.merchantId'` `pc.forSubject(input)` `subject.data.collection(name, options)` `orders` `orders.find(filter, options?)` `{ status:'paid' }` `rows: (subject) => ...` `claims` `context` `valueFrom` `all` `any` `not` `eq` `ne` `in` `nin` `gt` `gte` `lt` `lte` `contains` `exists` `$and` `$or` `$nor` `$exists` `i` `$regex` `$not` `$elemMatch` `$all` `$size` `$where` `orders.find()` `roles.allow()` `projection: ['publicValue']` `status` `secret` `FIELD_PERMISSION_DENIED` `find` `findOne` `count` `findAndCount` `findPage` `insertOne` `updateOne` `updateMany` `deleteOne` `deleteMany` `null` `{ data, total }` `{ items, pageInfo, total? }` `{ acknowledged, insertedId }` `{ acknowledged, matchedCount, modifiedCount }` `{ acknowledged, deletedCount }` `updateOne()` `matchedCount=0` `maxAffected` `$set` `$unset` `$inc` `$mul` `$min` `$max` `$addToSet` `$push` `$pull` `Transaction` `resource` -->

The supported data boundary is `AuthorizedCollection`. It combines the caller's Mongo-style `filter`, exact scope fields, persisted policy `where`, and field permissions before touching MongoDB.

It is not a transparent MonSQLize collection proxy. It is permission-core's protected data facade: callers provide a safe, auditable, cost-bounded query subset. If a workflow needs the full MonSQLize expression surface, keep that work explicit in the application repository layer instead of passing arbitrary query objects through an authorized collection.

<span id="data-filter-vs-where"></span>
## `filter` and `where` Have Different Jobs

The caller `filter` is a safe Mongo-style business query for one operation, such as `{ status: 'paid' }`; it is not the complete MonSQLize query syntax. Persisted `where` belongs to allow or deny policy rules, and `scopeFields` maps trusted scope dimensions to exact scalar fields in each business document.

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

`pc.forSubject(...).data.collection(...)` synchronously creates an `AuthorizedCollection`. It binds the current subject, physical collection `orders`, logical resource `db:orders`, and scope field mapping. It does not touch the database when created; real MonSQLize reads and writes happen later through methods such as `find`, `findPage`, `updateOne`, and `deleteMany`.

`scopeFields: { tenantId: 'tenantId' }` does not hard-code the tenant value to `tenantId`, and it does not write a tenant value. The left `tenantId` means `subject.scope.tenantId`; the right `'tenantId'` is the field path inside each business document. When the current subject scope is `{ tenantId: 'acme' }`, every real Mongo operation also requires the document `tenantId` field to equal `acme`.

If you write `scopeFields: { tenantId: 'acme' }`, permission-core maps `subject.scope.tenantId` to the document field named `acme`. That is only meaningful when your documents really contain an `acme` field; it is usually not the intended tenant mapping.

```text
caller filter AND exact tenant condition AND matched allow AND NOT matched deny
```

In this example, `orders.find({ status: 'paid' })` is logically close to:

```ts
rawOrders.find({
  $and: [
    { status: 'paid' },
    { tenantId: 'acme' },
    { merchantId: 'm-1' },
  ],
});
```

The real implementation also adds scalar scope guards, field permission checks, deny inversion, transactions, and query budgets; this snippet is only the mental model for permission composition.

The public API does not return a filter and ask the caller to remember to use it. The collection executes the combined conditions directly.

It also does not accept persisted functions such as `rows: (subject) => ...`. Functions cannot be serialized, audited, replayed across processes, or version-compared reliably. Put application-specific computed values into trusted `claims` or request `context`, then reference them with `valueFrom`.
## Multiple Policy Conditions

Use serializable `all`, `any`, and `not` nodes to compose policy conditions:

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

Leaf operators include `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `contains`, and `exists`. `valueFrom` can read trusted subject, claims, or explicit policy context. Missing dynamic context evaluates to unknown and tightens authorization instead of widening it.
## Mongo-Style Caller Queries

Caller filters use `SafeMongoFilter`. They support bounded pure-data Mongo operators including `$and`, `$or`, `$nor`, comparison and set operators, `$exists`, literal `$regex` with optional `i`, `$not`, `$elemMatch`, `$all`, and `$size`. JavaScript predicates, Proxy values, accessors, `$where`, and arbitrary operators are rejected.

Safe filters are capped at 12 levels, 256 nodes, 32 children per logical node, and 128 KiB of normalized bytes. Treat them as "Mongo-like authorized query input", not as query objects passed through unchanged to the underlying MonSQLize collection.

## Field Permissions

Once field rules exist, every projected, filtered, sorted, or modified field must be authorized for the corresponding operation. That prevents callers from inferring hidden values through filters or sort order.

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
This is the raw array returned by `orders.find()`. The field `roles.allow()` calls each return their own mutation envelope; the example omits those responses because this section focuses on the read result. Production initialization should still check write failures.

`projection: ['publicValue']` is the caller's requested field set. The final result is still tightened by field allow/deny rules. The `status` field used by the filter also needs read permission even when it is not returned in the projection.
## Protected Read and Write Operations

The facade supports `find`, `findOne`, `count`, `findAndCount`, signed-cursor `findPage`, `insertOne`, `updateOne`, `updateMany`, `deleteOne`, and `deleteMany`. Inserts validate the authorized post-image and inject trusted scope fields. Updates check both pre-image and post-image, including field rules and scope stability.

Signed cursor pagination is available directly through `findPage()`. The first request provides the business filter, stable sort, and page size; the next request submits the cursor returned by the previous page:

```ts
const page = await orders.findPage({
  filter: { status: 'paid' },
  sort: { createdAt: -1 },
  first: 20,
  totals: true,
});

const next = await orders.findPage({
  filter: { status: 'paid' },
  sort: { createdAt: -1 },
  first: 20,
  after: page.pageInfo.endCursor!,
});
```

```json
{
  "items": [],
  "pageInfo": {
    "hasNext": false,
    "hasPrev": false,
    "startCursor": null,
    "endCursor": null
  },
  "total": 0
}
```

The cursor binds the query contract, scope, subject, claims/context fingerprints, and policy revision. Changing user, scope, filter/sort, or tampering with the cursor prevents reuse. `total` is returned only when `totals: true` is requested.

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
This is the complete business result object from `updateOne()`. `matchedCount=0` means the authorized combination found no candidate. Trying to modify unauthorized fields or scope fields throws explicitly instead of silently returning 0.
## Transaction and Ownership Boundary

Every operation uses a real MonSQLize transaction. A borrowed MonSQLize `Transaction` must belong to the same runtime; ownership remains with the caller, and permission-core does not commit or roll back borrowed transactions. The physical collection name belongs to application configuration, while logical `resource` is the authorization contract.

Continue with [Manage Menus](/guide/menu-management).
