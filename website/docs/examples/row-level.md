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
