# FileAdapter

`FileAdapter` stores core authorization data in one scoped JSON file.

## Purpose and import

```typescript
import { FileAdapter } from 'permission-core';
```

Use it for local fallback, demos, and simple single-process persistence where a database is unnecessary.

## Construction and types

`new FileAdapter(options?: FileAdapterOptions)` accepts `path?: string`. The default path is `./permission-core-data.json`.

It implements `StorageAdapter` and `ScopedStorageAdapter`; persisted schema version 2 stores separate role, user-binding, and rule data for each scope key.

## Signature index

| Area | Methods |
|---|---|
| Lifecycle | `init`; `close` |
| Roles | get/set/delete/list, with scoped variants |
| User bindings | get/set plus reverse lookup, with scoped variants |
| Rules | get/set/delete, with scoped variants |

## Behavior and defaults

Missing files are treated as an empty store at `init()`. Writes are serialized and debounced, then committed by atomic temporary-file replacement; `close()` waits for pending persistence. Legacy unscoped data is normalized into the default scope.

Replacement semantics match `StorageAdapter`. The adapter rebuilds and updates its role-to-users reverse index as bindings change.

## Errors and limits

Invalid JSON or unsupported data fails during initialization. A disk write failure is retained and blocks later reads/writes instead of letting memory and disk silently diverge. Persistence failures use `STORAGE_ERROR`.

One JSON file is not safe shared storage for multiple processes. The adapter provides no distributed lock, multi-instance cache propagation, or database-style backup/transaction guarantee. Menu persistence is a separate `FileMenuStorageAdapter` contract.

## Minimal example

```typescript
const pc = new PermissionCore({
  storage: new FileAdapter({ path: './var/permissions.json' }),
});

await pc.init();
await pc.close();
```

## Related

See [Storage Adapters](/guide/adapters), [StorageAdapter](/api/storage-adapter), and [Production Deployment](/guide/production-deployment).
