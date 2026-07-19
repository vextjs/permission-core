# Data Guard

## Scenario

This example composes a caller Mongo filter, exact tenant isolation, a role `where` condition, field projection, insert/update ownership checks, and denied-field/write failures against a real MonSQLize collection.

## Run

```bash
npm run example:data-guard
```

The canonical source is `examples/data-guard.mjs`, between `docs:data-guard:start` and `docs:data-guard:end`.

## Source walkthrough

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
```

The caller filter is AND-ed with `tenantId`, the durable `merchantId = claims.merchantId` condition, and allowed-field projection. Writes separately prove pre/post ownership enforcement.

### 1. Define row, field, and write policy

<!-- docs:operation id=data-policy calls=roles.create,roles.allow,roles.deny,userRoles.assign outputs=composition -->

**Purpose and target.** `roles.create` creates `merchant-reader`; repeated `roles.allow` calls permit collection/field reads and guarded writes; `roles.deny` blocks `secret`; `userRoles.assign` binds the policy to `u-data`.

**State, arguments, and result.** The collection-level read rule stores a serializable `where` condition that resolves `claims.merchantId`; create/update rules resolve `subject.userId` for ownership. Field resources independently control filtering, projection, and mutation. `composition` names the four constraint layers the later read demonstrates.

**Failure and next step.** Missing field permissions, an unavailable `valueFrom`, or an allow/deny conflict fails closed. Correct the role policy or trusted claims and retry the business operation; do not bypass the guard with the raw collection.

**API reference.** See [Roles](/api/roles) for rule mutations and [Resources and Rules](/guide/resources-and-rules) for `where`, field resources, and deny precedence.

### 2. Create the authorized collection

<!-- docs:operation id=data-collection calls=forSubject,data.collection outputs=matchedRows,matchedCount,deniedFieldCode,writeGuard,persistedRows -->

**Purpose and target.** `forSubject` creates the trusted subject, then `data.collection` wraps `example_orders` so every supported operation evaluates `db:orders` policy and maps the active tenant scope to the row's `tenantId` field.

**State, arguments, and result.** The subject carries trusted `scope` and `claims`; the collection options carry the permission resource and `scopeFields`. The wrapper is the enforcement boundary used by every later read and write, while the raw handle exists only to seed and count fixture data.

**Failure and next step.** Missing scope mappings, invalid subject context, unavailable policy state, or an unsupported operation rejects before unsafe data access. Fix the mapping/context and use the authorized wrapper again; raw MonSQLize access is not a fallback for application traffic.

**API reference.** See [Authorized Collection](/api/authorized-collection) for construction, scope mappings, supported operations, and failures.

### 3. Read with composed constraints

<!-- docs:operation id=data-read calls=find outputs=matchedRows,matchedCount,deniedFieldCode -->

**Purpose and target.** The first `find` requests paid orders and only `merchantId` plus `publicValue`; the second intentionally requests denied field `secret` to prove the projection guard.

**State, arguments, and result.** The caller filter is AND-ed with exact tenant equality and the role's merchant condition. Projection is intersected with allowed fields, so only one row matches. The accepted result produces `matchedRows`/`matchedCount`; the rejected projection supplies `FIELD_PERMISSION_DENIED`.

**Failure and next step.** A forbidden filter/projection field or unresolved policy value rejects the entire read instead of silently returning a broader shape. Request allowed fields or update reviewed policy; never catch the error and repeat the query without authorization.

**API reference.** See [Authorized Collection](/api/authorized-collection) for `find`, Mongo filter composition, projection rules, and field errors.

### 4. Enforce ownership before and after writes

<!-- docs:operation id=data-write calls=insertOne,updateOne outputs=writeGuard,persistedRows -->

**Purpose and target.** `insertOne` accepts an order owned by `u-data`; `updateOne` changes that user's row; a second insert with `ownerId: 'another-user'` is expected to fail.

**State, arguments, and result.** The guard injects trusted scope fields and checks create/update `where` policy against the resulting row. Acknowledged insert and one modified row become `writeGuard.inserted/updated`; the rejected insert supplies `PERMISSION_DENIED` and does not increase storage.

**Failure and next step.** Ownership mismatch, forbidden field mutation, stale policy, or transaction failure rejects the write. Return the authorization error or correct trusted input; do not rewrite ownership merely to make the guard pass.

**API reference.** See [Authorized Collection](/api/authorized-collection) for write guards, transaction options, result shapes, and denied mutations.

## Expected output

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

**`composition` provenance.** The example summarizes the policy created by `roles.allow`/`roles.deny` and the accepted `find`: caller filter, tenant scope, role `where`, then field projection.

<!-- docs:output group=matchedRows producer=data-read -->

**`matchedRows` provenance.** The accepted authorized `find` returns the one row satisfying all row constraints, already reduced to the two requested and allowed fields.

<!-- docs:output group=matchedCount producer=data-read -->

**`matchedCount` provenance.** This is the length of `matchedRows` returned by `find`, making the single accepted result explicit rather than reporting the collection's total size.

<!-- docs:output group=deniedFieldCode producer=data-read -->

**`deniedFieldCode` provenance.** The example catches only the deliberate `find` projection of `secret` and records its permission error code; a null value would mean the negative probe did not work.

<!-- docs:output group=writeGuard producer=data-write -->

**`writeGuard` provenance.** The first two booleans come from accepted `insertOne`/`updateOne` results. `deniedWriteCode` comes from the deliberately mismatched owner insert.

<!-- docs:output group=persistedRows producer=data-write -->

**`persistedRows` provenance.** A raw fixture-only count runs after both `insertOne` attempts. Four seeded rows plus one accepted insert equals five, proving the denied insert was not persisted.

## Production boundary

The example seeds raw fixture rows before using the guard; production application reads and writes should use `AuthorizedCollection`. Pass a host transaction when permission-guarded writes must share a business transaction. Do not persist arbitrary JavaScript row functions; use serializable `where` conditions and trusted context.

## Related

See [Data Permissions](/guide/data-permissions), [Authorized Collection](/api/authorized-collection), and [Resources and Rules](/guide/resources-and-rules).
