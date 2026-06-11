# Quick Start

permission-core supports three official integration paths. Pick one before writing code:

- `HTTP-only`: route, menu, button, and API guard permissions.
- `DB-only`: collection, row, and field permissions inside Service / DAO code.
- `Full standard stack`: route permissions, data permissions, management APIs, cache, and persistent storage together.

## Choose a path

| Path | Resource type | Common APIs | Common storage | Typical use case |
|------|---------------|-------------|----------------|------------------|
| `HTTP-only` | `<METHOD>:<path>` | `assert`, `can`, `getResources` | `MemoryAdapter`, `FileAdapter`, `MonSQLizeStorageAdapter` | API guards, menus, buttons, route visibility |
| `DB-only` | `db:<collection>[:<field>]` | `can`, `assert`, `getRowScope`, `filterRows`, `filterFields` | Any adapter | Service-layer data permissions, row scopes, field masking |
| `Full standard stack` | Both | runtime checks plus `roles` / `users` | `MonSQLizeStorageAdapter` + `cache-hub` | Admin console, route + data permissions, production persistence |

## Rules to remember

- Call `await pc.init()` before using public APIs.
- Pass a string `userId`; handle anonymous requests before calling permission-core.
- Resource shape and storage choice are separate. HTTP-only can still use persistent storage, and DB-only can start with memory storage.

## HTTP-only

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

await pc.roles.create('operator', { label: 'Operator' });
await pc.roles.allow('operator', 'invoke', 'GET:/api/orders');
await pc.roles.allow('operator', 'invoke', 'POST:/api/orders');

await pc.users.setUserRoles('u-1', ['operator']);

await pc.assert('u-1', 'invoke', 'GET:/api/orders');
const resources = await pc.getResources('u-1', 'invoke');
```

`getResources()` returns resource strings that are useful for menu or button visibility:

```json
[
  "GET:/api/orders",
  "POST:/api/orders"
]
```

Use matched route templates when possible. Prefer `DELETE:/api/orders/:id` over `DELETE:/api/orders/123`.

## DB-only

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

await pc.roles.create('auditor');
await pc.roles.allow('auditor', 'read', 'db:transactions', {
  field: 'merchantId',
  op: 'eq',
  valueFrom: 'merchantId',
});
await pc.roles.allow('auditor', 'read', 'db:transactions:id');
await pc.roles.allow('auditor', 'read', 'db:transactions:status');

await pc.users.setUserRoles('u-2', ['auditor']);

const scope = await pc.getRowScope('u-2', 'read', 'db:transactions', {
  merchantId: 'm-100',
});

const visibleRows = await pc.filterRows('u-2', 'read', 'db:transactions', rows, {
  merchantId: 'm-100',
});

const safeRow = await pc.filterFields('u-2', 'read', 'db:transactions', visibleRows[0]);
```

Use `getRowScope()` before querying when you can push the scope into SQL or MongoDB. Use `filterRows()` as a runtime safety net for already-loaded records.

## Full standard stack

```typescript
import { MemoryCache } from 'cache-hub';
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
  cache: new MemoryCache({ defaultTtl: 300_000 }),
});

await pc.init();
```

This path fits payment and finance consoles where route access, ledger rows, sensitive fields, role management, and cache invalidation must stay auditable.

## Where to go next

- Resource model: [Resource Paths](/guide/resource-paths)
- Runtime checks: [Permission Checks](/guide/check-permission)
- Row scopes: [Row-level Permissions](/guide/row-level)
- Field filtering: [Field Filtering](/guide/field-filter)
- Management console: [Management Console](/guide/site-preview-release)
