# Field Permission Example

```typescript
await pc.roles.create('refund-support', { label: 'Refund Support' });
await pc.roles.allow('refund-support', 'read', 'db:refunds');
await pc.roles.allow('refund-support', 'read', 'db:refunds:id');
await pc.roles.allow('refund-support', 'read', 'db:refunds:status');
await pc.roles.allow('refund-support', 'read', 'db:refunds:reason');
await pc.users.assign('u-1', 'refund-support');

const safeRefund = await pc.filterFields(
  'u-1',
  'read',
  'db:refunds',
  refund,
);
```

Fields without an allowed field resource are removed from the returned object.

The collection rule allows the read operation; field rules define the returned top-level properties. The source object is not your authorization result, so return `safeRefund` rather than the original value.

## Write flow

Use an explicit operation for payload filtering:

```typescript
const safePatch = await pc.filterFields(
  'u-1',
  'update',
  'db:refunds',
  req.body,
);
await refundRepository.update(id, safePatch);
```

Request-side `write` means `create && update`, so it is often stricter than a concrete create or update operation. v1 filters top-level fields only; validate nested business objects separately.

Apply field filtering in the service/serializer boundary, after row authorization and before returning or persisting data. Do not use UI-hidden fields as a security control.
