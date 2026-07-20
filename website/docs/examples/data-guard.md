# Data Guard
<!-- docs:inline-parity `where` `examples/data-guard.mjs` `docs:data-guard:start` `docs:data-guard:end` `matchedCount: 1` `deniedFieldCode: 'FIELD_PERMISSION_DENIED'` `writeGuard.deniedWriteCode: 'PERMISSION_DENIED'` `persistedRows: 5` `tenantId` `merchantId = claims.merchantId` `roles.create` `merchant-reader` `roles.allow` `roles.deny` `secret` `userRoles.assign` `u-data` `claims.merchantId` `subject.userId` `composition` `valueFrom` `roles.create(input)` `MutationResult<Role>` `roles.allow(roleId, rule)` `roles.deny(roleId, rule)` `userRoles.assign(userId, roleId)` `forSubject` `data.collection` `example_orders` `db:orders` `scope` `claims` `scopeFields` `forSubject(input)` `userId/scope/claims` `data.collection(name, options)` `find()` `find` `merchantId` `publicValue` `matchedRows` `matchedCount` `FIELD_PERMISSION_DENIED` `find(filter, options)` `rows` `PermissionCoreError` `code` `insertOne` `updateOne` `ownerId: 'another-user'` `writeGuard.inserted/updated` `PERMISSION_DENIED` `insertOne()` `{ acknowledged, insertedId }` `updateOne()` `{ acknowledged, matchedCount, modifiedCount }` `deniedWriteCode` `printExample()` `deniedFieldCode` `writeGuard` `persistedRows` `AuthorizedCollection` -->

## Scenario

This example uses a real MonSQLize collection and composes caller Mongo filters, exact tenant isolation, role `where` conditions, field projection, insert/update ownership checks, and denied field/write probes.

## Run

```bash
npm run example:data-guard
```

The canonical source is the `docs:data-guard:start` to `docs:data-guard:end` block in `examples/data-guard.mjs`.

## First Check the Result

A successful run confirms `matchedCount: 1`, `deniedFieldCode: 'FIELD_PERMISSION_DENIED'`, `writeGuard.deniedWriteCode: 'PERMISSION_DENIED'`, and `persistedRows: 5`.

## Source walkthrough

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

The protected route or companion source used by this scenario is:

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

The caller `filter` is combined with `tenantId`, the persisted `merchantId = claims.merchantId` condition, and field projection permissions before MongoDB is called.

### 1. Define row, field, and write policy

<!-- docs:operation id=data-policy calls=roles.create,roles.allow,roles.deny,userRoles.assign outputs=composition -->

**Purpose and target.** This operation explains `roles.create`, `roles.allow`, `roles.deny`, `userRoles.assign` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `composition`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [roles](/api/roles) for exact signatures, response wrappers, and public error codes.

### 2. Create the authorized collection

<!-- docs:operation id=data-collection calls=forSubject,data.collection outputs=matchedRows,matchedCount,deniedFieldCode,writeGuard,persistedRows -->

**Purpose and target.** This operation explains `forSubject`, `data.collection` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `matchedRows`, `matchedCount`, `deniedFieldCode`, `writeGuard`, `persistedRows`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [authorized-collection](/api/authorized-collection) for exact signatures, response wrappers, and public error codes.

### 3. Read with composed constraints

<!-- docs:operation id=data-read calls=find outputs=matchedRows,matchedCount,deniedFieldCode -->

**Purpose and target.** This operation explains `find` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `matchedRows`, `matchedCount`, `deniedFieldCode`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [authorized-collection](/api/authorized-collection) for exact signatures, response wrappers, and public error codes.

### 4. Enforce ownership before and after writes

<!-- docs:operation id=data-write calls=insertOne,updateOne outputs=writeGuard,persistedRows -->

**Purpose and target.** This operation explains `insertOne`, `updateOne` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `writeGuard`, `persistedRows`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [authorized-collection](/api/authorized-collection) for exact signatures, response wrappers, and public error codes.


## Expected output

The following JSON is the **Example summary output** generated by `printExample()`. It combines selected fields from several API calls and is not the raw response of one method.

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

**`composition` provenance.** This output group is produced by the data-policy walkthrough and should be read together with `roles.allow`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=matchedRows producer=data-read -->

**`matchedRows` provenance.** This output group is produced by the data-read walkthrough and should be read together with `find`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=matchedCount producer=data-read -->

**`matchedCount` provenance.** This output group is produced by the data-read walkthrough and should be read together with `find`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=deniedFieldCode producer=data-read -->

**`deniedFieldCode` provenance.** This output group is produced by the data-read walkthrough and should be read together with `find`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=writeGuard producer=data-write -->

**`writeGuard` provenance.** This output group is produced by the data-write walkthrough and should be read together with `insertOne`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=persistedRows producer=data-write -->

**`persistedRows` provenance.** This output group is produced by the data-write walkthrough and should be read together with `insertOne`. It is a selected, documented example field rather than a new API response shape.


## Production boundary

Raw fixture writes happen only before the guard is used. Production reads and writes should go through `AuthorizedCollection`; shared business transactions should pass a host-owned transaction.

## Related

See [Data Permissions](/guide/data-permissions), [Authorized Collection API](/api/authorized-collection), and [Resources and Rules](/guide/resources-and-rules).
