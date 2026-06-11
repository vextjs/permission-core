# MemoryAdapter

`MemoryAdapter` stores all permission data in process memory.

## Use cases

- unit tests
- local demos
- documentation examples
- short-lived development flows

## Example

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();
```

## Boundary

Data disappears when the process exits. Do not use it as production persistence.
