# Field Permission Example

```typescript
await pc.roles.create('refund-support', { label: 'Refund Support' });
await pc.roles.allow('refund-support', 'read', 'db:refunds');
await pc.roles.allow('refund-support', 'read', 'db:refunds:id');
await pc.roles.allow('refund-support', 'read', 'db:refunds:status');
await pc.roles.allow('refund-support', 'read', 'db:refunds:reason');

const safeRefund = await pc.filterFields(
  'u-1',
  'read',
  'db:refunds',
  refund,
);
```

Fields without an allowed field resource are removed from the returned object.
