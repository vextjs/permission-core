# MemoryAdapter

`MemoryAdapter` is the built-in in-memory implementation of core and scoped storage contracts.

## Purpose and import

```typescript
import { MemoryAdapter } from 'permission-core';
```

Use it for tests, examples, local prototyping, and the default zero-configuration `PermissionCore` runtime.

## Construction and types

`new MemoryAdapter()` has no options. It implements both `StorageAdapter` and `ScopedStorageAdapter`.

Data is held in process memory as role maps, user-role maps, rule maps, and a role-to-users reverse index.

## Signature index

| Area | Methods |
|---|---|
| Lifecycle | `init`; `close` |
| Roles | get/set/delete/list, with scoped variants |
| User bindings | get/set plus `getUsersByRole`, with scoped variants |
| Rules | get/set/delete, with scoped variants |

Every method is asynchronous to match the common adapter contract.

## Behavior and defaults

Each permission scope uses a separate internal key. Missing roles return `null`; missing bindings/rules return empty arrays. Replacement writes overwrite the previous binding or rule list.

`init()` and `close()` are no-op lifecycle methods. PermissionCore manager methods still provide validation and cache invalidation above this adapter.

## Errors and limits

No data survives process restart and no state is shared across processes. The adapter provides no locking, distributed propagation, backup, or external transaction semantics.

Do not treat it as durable production storage. Low-level writes bypass manager validation and cache invalidation just as they do with every adapter. Menu state uses the separate `MemoryMenuStorageAdapter`.

## Minimal example

```typescript
const pc = new PermissionCore({ storage: new MemoryAdapter() });
await pc.init();
await pc.roles.create('reader', { label: 'Reader' });
await pc.close();
```

## Related

See [Storage Adapters](/guide/adapters), [StorageAdapter](/api/storage-adapter), and [FileAdapter](/api/file-adapter).
