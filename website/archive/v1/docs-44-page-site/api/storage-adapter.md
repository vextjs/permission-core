# StorageAdapter

`StorageAdapter` is the persistence contract used by `PermissionCore`, RBAC managers, and the checker.

## Purpose and import

```typescript
import { StorageAdapter } from 'permission-core';
```

Extend it when built-in memory, file, or MonSQLize persistence does not fit your database.

## Construction and types

`StorageAdapter` is abstract and has no constructor options. Implementations store `RoleData`, string user-role bindings, and `PermissionRule[]`.

To support real multi-tenant persistence, also implement `ScopedStorageAdapter`; otherwise the runtime wraps the adapter and permits only `defaultScope`.

## Signature index

| Area | Abstract methods |
|---|---|
| Lifecycle | `init`; `close` |
| Roles | `getRoles`; `getRole`; `setRole`; `deleteRole` |
| User bindings | `getUserRoles`; `setUserRoles`; `getUsersByRole` |
| Rules | `getRules`; `setRules`; `deleteRules` |

Scoped implementations add the same operations with a leading `PermissionScope` argument.

## Behavior and defaults

Manager methods own validation, inheritance rules, deduplication, and cache invalidation. The adapter persists exactly the values it receives and returns empty collections/`null` for missing data according to each signature.

`setUserRoles()` and `setRules()` are replacement writes. `init()` prepares resources; `close()` releases only resources the adapter owns.

## Errors and limits

Do not move authorization semantics into storage or expose low-level replacement writes as management APIs. Wrap persistence failures as `PermissionCoreError(STORAGE_ERROR, ...)` with internal cause data where appropriate.

The adapter does not execute business queries or implement `MenuPermissionStorageAdapter`. Multi-instance consistency, transactions, locking, migrations, and backups remain implementation/operations responsibilities.

## Minimal example

```typescript
class CustomAdapter extends StorageAdapter {
  async init() {}
  async close() {}
  // Implement role, binding, reverse-index, and rule methods.
}

const pc = new PermissionCore({ storage: new CustomAdapter() });
```

## Related

See [Custom Adapter](/guide/custom-adapter), [Storage Adapters](/guide/adapters), and [MonSQLizeStorageAdapter](/api/monsqlize-storage-adapter).
