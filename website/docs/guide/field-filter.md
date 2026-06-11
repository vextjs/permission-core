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

## Collection permission still matters

Field rules do not bypass collection checks. In practice, grant the collection resource and then grant the allowed fields.

## Create and update

For write payloads, prefer explicit actions:

```typescript
await pc.filterFields('u-1', 'create', 'db:refunds', payload);
await pc.filterFields('u-1', 'update', 'db:refunds', payload);
```

Avoid request-side `write` unless you really require both create and update permissions.
