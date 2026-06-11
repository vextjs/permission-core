# Row-level Permissions

Row-level permissions restrict which records a user can read or operate on.

## Define a scoped rule

```typescript
await pc.roles.allow('merchant-auditor', 'read', 'db:transactions', {
  field: 'merchantId',
  op: 'eq',
  valueFrom: 'merchantId',
});
```

The `where` DSL describes the allowed row condition. `valueFrom` reads from the context you pass to runtime checks.

## Get a query scope

```typescript
const scope = await pc.getRowScope('u-1', 'read', 'db:transactions', {
  merchantId: 'm-100',
});
```

Use the scope before querying when your data layer can translate it into SQL, MongoDB, or another filter.

## Check one row

```typescript
const ok = await pc.canRow('u-1', 'read', 'db:transactions', row, {
  merchantId: 'm-100',
});
```

Use `canRow()` or `assertRow()` when you already have a record and need a final per-row guard.

## Filter rows

```typescript
const visible = await pc.filterRows('u-1', 'read', 'db:transactions', rows, {
  merchantId: 'm-100',
});
```

`filterRows()` is useful as a safety net after loading data. For large datasets, prefer pushing `getRowScope()` into the query first.
