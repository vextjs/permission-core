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

## Production boundary

The example seeds raw fixture rows before using the guard; production application reads and writes should use `AuthorizedCollection`. Pass a host transaction when permission-guarded writes must share a business transaction. Do not persist arbitrary JavaScript row functions; use serializable `where` conditions and trusted context.

## Related

See [Data Permissions](/guide/data-permissions), [Authorized Collection](/api/authorized-collection), and [Resources and Rules](/guide/resources-and-rules).
