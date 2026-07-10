# MonSQLizeStorageAdapter

`MonSQLizeStorageAdapter` is the documented production persistence path for permission-core.

## Example

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'permission_core_demo',
  config: { uri: process.env.MONGO_URI! },
});

await msq.connect();

const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({
    msq,
    namespace: 'permission_core',
    ownsConnection: true,
  }),
});

await pc.init();
```

## Options

| Option | Description |
|--------|-------------|
| `msq` | Connected MonSQLize instance |
| `namespace` | Storage namespace for permission data |
| `ownsConnection` | Whether the adapter should close the MonSQLize connection |

`namespace` defaults to `permission_core`. The adapter creates separate scoped collections for roles, user-role bindings, and role rules, plus indexes for scope-aware reads and reverse role-user lookup.

## Lifecycle and errors

- Pass an already configured MonSQLize instance. The adapter uses the minimal `collection()`/`close()` structural contract and does not runtime import application-specific models.
- `ownsConnection` defaults to `false`; use `true` only when this adapter is the sole lifecycle owner.
- `init()` obtains collections and creates required indexes.
- `close()` closes MonSQLize only when `ownsConnection:true`.
- Driver and collection failures are wrapped as `STORAGE_ERROR` while preserving the original cause for operational logging.
- Every document carries the complete scope fields and a stable `scopeKey`; adapter `namespace` is only a physical collection prefix, not a tenant boundary.

When core and menu persistence share one MonSQLize instance, use a separate `MonSQLizeMenuStorageAdapter` namespace and only one connection owner.

## Boundary

This adapter persists permission configuration. It does not make permission-core MongoDB-only and does not replace your transaction or ledger database model.

Back up roles, rules, and user bindings together. If the same release changes menu configuration, include menu nodes, API bindings, revision, and audit collections in the same migration/rollback plan.
