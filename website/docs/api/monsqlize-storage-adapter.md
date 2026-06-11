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

## Boundary

This adapter persists permission configuration. It does not make permission-core MongoDB-only and does not replace your transaction or ledger database model.
