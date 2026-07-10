# FileAdapter

`FileAdapter` stores permission data in a local file.

## Use cases

- local persistence
- simple demos
- single-process fallback setups

## Example

```typescript
import { FileAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new FileAdapter({
    path: './permission-data.json',
  }),
});

await pc.init();
try {
  // use pc
} finally {
  await pc.close();
}
```

## Constructor

```typescript
new FileAdapter(options?: { path?: string })
```

`path` defaults to `./permission-core-data.json`. The schema is versioned and partitions roles, rules, and user bindings by permission scope.

## Runtime behavior

- A missing file on first startup is treated as an empty store.
- Invalid JSON fails during `init()` with `STORAGE_ERROR` instead of silently resetting data.
- Writes are serialized and flushed through atomic file replacement.
- `close()` waits for pending writes and flushes the latest state.
- Once a disk write fails, later reads/writes report the stored failure so callers cannot continue on an unpersisted in-memory state.
- The adapter implements native scoped storage; tenant/app partitions are retained in the file schema.

## Boundary

Do not use this adapter for shared multi-instance writes. If multiple service instances need the same permission data, use a real shared store.

Use a unique path per environment, include the file in backup policy, and allow exactly one process/writer. Menu assets use the separate `FileMenuStorageAdapter`; the core file does not persist menu nodes, API bindings, revisions, or audits.
