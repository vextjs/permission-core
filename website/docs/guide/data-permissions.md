# Data Permissions

`AuthorizedCollection` is the supported data-access boundary. It executes on the host's MonSQLize 3.1 transaction runtime and combines application filters with authorization before MongoDB receives the operation.

## `filter` and `where` have different jobs

- `filter` is the caller's Mongo-style business query for one operation, such as `{ status: 'paid' }`.
- `where` is a durable policy condition stored on an allow or deny rule, such as “merchantId equals the subject claim.”
- `scopeFields` maps trusted scope dimensions to exact scalar fields in every business document.

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

The effective Mongo predicate is logically:

```text
caller filter AND exact tenant filter AND (matching allows) AND NOT (matching denies)
```

No public method returns an authorization filter for optional later use. The collection executes the composed predicate so the caller cannot forget or replace it.

## Multiple policy conditions

Use serializable `all`, `any`, and `not` nodes for policy composition:

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

Leaf operators are `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `contains`, and `exists`. `valueFrom` can read trusted subject, claims, or explicit policy context. Missing dynamic context produces an unknown condition and closes authorization rather than widening it.

Arbitrary JavaScript row functions are intentionally not stored as rules. Functions cannot be canonically persisted, audited, compared, cached across processes, or reproduced by another service instance. Put application-specific computation into trusted claims/context, then reference its scalar result from the durable condition AST.

## Mongo-style caller filters

Caller filters support bounded plain-data Mongo operators including `$and`, `$or`, `$nor`, comparison and set operators, `$exists`, literal `$regex` with optional `i`, `$not`, `$elemMatch`, `$all`, and `$size`. JavaScript predicates, proxies, accessors, `$where`, and arbitrary operators are rejected.

The safe filter is limited to 12 levels, 256 nodes, 32 logical children per node, and 128 KiB canonical bytes. These constraints keep authorization review and database cost bounded.

## Field permissions

Once field-specific rules exist, every projected, filtered, sorted, or changed field must be authorized for that operation. This prevents a caller from inferring a hidden value through filtering or ordering.

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

Requesting `secret`, filtering by it, or sorting by a conditional field without an unconditional query-time grant throws `FIELD_PERMISSION_DENIED`.

## Protected reads and writes

The facade supports `find`, `findOne`, `count`, `findAndCount`, signed-cursor `findPage`, `insertOne`, `updateOne`, `updateMany`, `deleteOne`, and `deleteMany`. Inserts are checked against the authorized post-image and receive scope fields from the trusted subject. Updates check both pre-image and post-image, including field rules and scope preservation.

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

Bulk update and delete require `maxAffected` from 1 to 1000 and abort when the actual pre-image count exceeds it. Supported update operators are `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$addToSet`, `$push`, and `$pull`.

## Transaction and ownership boundary

Every operation uses a real MonSQLize transaction. An optional borrowed MonSQLize `Transaction` remains owned by the caller and is validated against the same runtime; permission-core never commits or aborts a borrowed transaction on the caller's behalf. The physical collection name is application configuration, while the logical `resource` is the authorization contract.

See the runnable [Data Guard example](/examples/data-guard) and the [Authorized Collection API](/api/authorized-collection) for complete responses and limits.
