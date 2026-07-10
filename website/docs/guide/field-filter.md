# Field Filtering

Field filtering removes fields the current user cannot access.

## Field resource shape

```text
db:<collection>:<field>
```

Examples:

```text
db:transactions:id
db:transactions:status
db:transactions:amount
db:refunds:internalNote
```

## Grant fields

```typescript
await pc.roles.allow('support', 'read', 'db:refunds:id');
await pc.roles.allow('support', 'read', 'db:refunds:status');
await pc.roles.allow('support', 'read', 'db:refunds:reason');
```

## Filter an object

```typescript
const safeRefund = await pc.filterFields(
  'u-1',
  'read',
  'db:refunds',
  refund,
);
```

The `action` argument is required so field filtering follows the same model as `can()`.

```typescript
await pc.roles.create('support', { label: 'Support' });
await pc.roles.allow('support', 'read', 'db:refunds');
await pc.roles.allow('support', 'read', 'db:refunds:id');
await pc.roles.allow('support', 'read', 'db:refunds:status');
await pc.users.assign('u-1', 'support');

const safeRefund = await pc.filterFields('u-1', 'read', 'db:refunds', refund);
```

## Collection permission still matters

Field rules do not bypass collection checks. In practice, grant the collection resource and then grant the allowed fields.

Apply row authorization before field filtering. A field grant must never make a row visible when the subject cannot access that row.

## Create and update

For write payloads, prefer explicit actions:

```typescript
await pc.filterFields('u-1', 'create', 'db:refunds', payload);
await pc.filterFields('u-1', 'update', 'db:refunds', payload);
```

Avoid request-side `write` unless you really require both create and update permissions.

## Current boundary

- v1 filters top-level object properties only.
- It returns a new partial object and does not mutate the source.
- Missing field grants remove fields; they do not replace values with `undefined`.
- Authorization context supplies rule variables but cannot replace the API subject/user.
- Field filtering is not validation, masking, encryption, or database projection by itself.

For large reads, select authorized fields in the database query when possible, then keep `filterFields()` at the serializer boundary as defense in depth.

## When not to use it

Do not use field filtering to decide whether a route is callable, whether a row exists for the subject, or whether a nested domain object is valid. Use route, collection, and row checks for those decisions and a schema validator for payload shape.

Common mistakes include returning the original object after calculating a safe copy, forgetting the collection grant, using UI-hidden fields as security, and passing `write` when the real operation is only `update`.

Continue with the [Field Permission Example](/examples/field-permission) and [PermissionCore API](/api/permission-core).
