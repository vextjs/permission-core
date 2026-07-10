# Row-level Example

```typescript
await pc.roles.create('merchant-auditor', { label: 'Merchant Auditor' });
await pc.roles.allow('merchant-auditor', 'read', 'db:transactions', {
  where: {
    field: 'merchantId',
    op: 'eq',
    valueFrom: 'merchantId',
  },
});
await pc.users.setUserRoles('u-1', ['merchant-auditor']);

const visible = await pc.filterRows('u-1', 'read', 'db:transactions', rows, {
  merchantId: 'm-100',
});
```

For large datasets, convert `getRowScope()` into the database query first, then keep `filterRows()` as a final safety net.

## List query flow

```typescript
const context = { merchantId: 'm-100' };
const rowScope = await pc.getRowScope('u-1', 'read', 'db:transactions', context);

if (rowScope.type === 'deny') return [];
const rows = await repository.findMany({ where: rowScope.where });
return pc.filterRows('u-1', 'read', 'db:transactions', rows, context);
```

Translate the returned condition through a structured query builder. Do not concatenate it into SQL or a Mongo query string.

## Detail flow

```typescript
const transaction = await repository.findById(id);
if (!transaction) return null;

await pc.assertRow(
  'u-1',
  'read',
  'db:transactions',
  transaction,
  { merchantId: 'm-100' },
);
```

Row rules restrict records; field rules still decide which properties may be returned. Missing context variables do not broaden access.

Common mistakes are loading an unbounded dataset before filtering, treating `filterRows()` as database pagination, or using the request body as trusted authorization context.
