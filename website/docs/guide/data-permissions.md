# Data Permissions
<!-- docs:inline-parity `filter` `subject.data.collection()` `AuthorizedCollection` `where` `{ status: 'paid' }` `scopeFields` `roles.allow(roleId, rule)` `valueFrom='claims.merchantId'` `pc.forSubject(input)` `subject.data.collection(name, options)` `orders` `orders.find(filter, options?)` `{ status:'paid' }` `rows: (subject) => ...` `claims` `context` `valueFrom` `all` `any` `not` `eq` `ne` `in` `nin` `gt` `gte` `lt` `lte` `contains` `exists` `$and` `$or` `$nor` `$exists` `i` `$regex` `$not` `$elemMatch` `$all` `$size` `$where` `orders.find()` `roles.allow()` `projection: ['publicValue']` `status` `secret` `FIELD_PERMISSION_DENIED` `find` `findOne` `count` `findAndCount` `findPage` `insertOne` `updateOne` `updateMany` `deleteOne` `deleteMany` `null` `{ data, total }` `{ items, pageInfo, total? }` `{ acknowledged, insertedId }` `{ acknowledged, matchedCount, modifiedCount }` `{ acknowledged, deletedCount }` `updateOne()` `matchedCount=0` `maxAffected` `$set` `$unset` `$inc` `$mul` `$min` `$max` `$addToSet` `$push` `$pull` `Transaction` `resource` -->

The supported data boundary is `AuthorizedCollection`. It combines the caller's Mongo-style `filter`, exact scope fields, persisted policy `where`, and field permissions before touching MongoDB.

<span id="data-filter-vs-where"></span>
## `filter` and `where` Have Different Jobs

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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

`scopeFields: { tenantId: 'tenantId' }` does not hard-code the tenant value to `tenantId`, and it does not write a tenant value. The left `tenantId` means `subject.scope.tenantId`; the right `'tenantId'` is the field path inside each business document. When the current subject scope is `{ tenantId: 'acme' }`, every real Mongo operation also requires the document `tenantId` field to equal `acme`.

If you write `scopeFields: { tenantId: 'acme' }`, permission-core maps `subject.scope.tenantId` to the document field named `acme`. That is only meaningful when your documents really contain an `acme` field; it is usually not the intended tenant mapping.

```text
调用方 filter AND 精确租户条件 AND 命中的 allow AND NOT 命中的 deny
```
## Multiple Policy Conditions

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
## Mongo-Style Caller Queries

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Field Permissions

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
## Protected Read and Write Operations

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
## Transaction and Ownership Boundary

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

Continue with [Manage Menus](/guide/menu-management).
