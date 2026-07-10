# MonSQLize Adapter Example

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'permission_core',
  config: { uri: process.env.MONGO_URI! },
  cache: { defaultTtl: 300_000, maxEntries: 1000 },
});

await msq.connect();

const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({
    msq,
    namespace: 'permission_core',
    ownsConnection: true,
  }),
  cache: msq.getCache(),
});

await pc.init();

try {
  // run the service
} finally {
  await pc.close();
}
```

Use this path when role rules and user bindings must be durable and shared across service instances.

## Responsibility split

- `PermissionCore` evaluates rules and exposes managers.
- `MonSQLizeStorageAdapter` persists scoped roles, rules, and user-role bindings.
- `msq.getCache()` supplies a shared cache-hub-compatible cache.
- Your service still owns authentication, business queries, migrations, logging, and backup.

`ownsConnection:true` is correct only when this core adapter owns the MonSQLize instance. When a menu adapter shares the same connection, give ownership to exactly one adapter and close dependents first.

## Menu persistence

```typescript
import {
  MonSQLizeMenuStorageAdapter,
  createMenuPermission,
} from 'permission-core/menu';

const menu = createMenuPermission({
  core: pc,
  storage: new MonSQLizeMenuStorageAdapter({
    msq,
    namespace: 'permission_core_menu',
    ownsConnection: false,
  }),
});
```

Core and menu data use different storage contracts and collection namespaces. Include both in backup and migration plans.

The currently verified built-in database path is MonSQLize backed by MongoDB. Other databases require a custom `StorageAdapter`; this does not change the framework-neutral permission model.
