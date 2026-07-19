# MonSQLizeStorageAdapter

`MonSQLizeStorageAdapter` is the built-in durable core-storage path backed by a connected MonSQLize instance.

## Purpose and import

```typescript
import { MonSQLizeStorageAdapter } from 'permission-core';
```

Use it when roles, rules, inheritance, and user bindings must persist across processes and restarts.

## Construction and types

`new MonSQLizeStorageAdapter(options: MonSQLizeStorageAdapterOptions)` requires `msq`. `namespace` defaults to `permission_core`; `ownsConnection` defaults to `false`.

The adapter requires only MonSQLize `collection()` and optional `close()`. It implements both `StorageAdapter` and `ScopedStorageAdapter`.

## Signature index

| Area | Methods |
|---|---|
| Lifecycle | `init`; `close` |
| Roles | get/set/delete/list, with scoped variants |
| User bindings | get/set/reverse lookup, with scoped variants |
| Rules | get/set/delete, with scoped variants |

Initialization creates indexes for roles, user-role bindings, and rules.

## Behavior and defaults

Collections are `${namespace}_roles`, `${namespace}_user_roles`, and `${namespace}_rules`. Documents include a stable `scopeKey` and scope fields so the same logical IDs remain isolated by tenant/application.

`close()` closes MonSQLize only when `ownsConnection:true`. A shared core/menu connection should have one owner; the dependent adapter uses `false`.

## Errors and limits

Collection/index/read/write failures are wrapped as `STORAGE_ERROR`. The adapter does not create or connect the MonSQLize instance, and it does not own cache configuration unless the application passes `msq.getCache()` to `PermissionCore`.

It stores authorization configuration, not business rows. Menu assets use `MonSQLizeMenuStorageAdapter` from `permission-core/menu` and separate collections.

## Minimal example

```typescript
const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({
    msq,
    namespace: 'permission_core',
    ownsConnection: true,
  }),
  cache: msq.getCache(),
});
await pc.init();
```

## Related

See [Storage Adapters](/guide/adapters), [Production Deployment](/guide/production-deployment), and [MonSQLize Adapter Example](/examples/monsqlize-adapter).
