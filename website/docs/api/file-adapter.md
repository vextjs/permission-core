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
    filePath: './permission-data.json',
  }),
});

await pc.init();
```

## Boundary

Do not use this adapter for shared multi-instance writes. If multiple service instances need the same permission data, use a real shared store.
