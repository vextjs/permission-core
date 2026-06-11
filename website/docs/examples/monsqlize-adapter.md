# MonSQLize Adapter Example

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'permission_core',
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

Use this path when role rules and user bindings must be durable and shared across service instances.
