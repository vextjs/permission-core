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

## Constructor and behavior

```typescript
new MemoryAdapter()
```

- `init()` and `close()` are lifecycle-compatible no-ops.
- Roles, rules, user-role bindings, and reverse role-user indexes live in process memory.
- Returned data is cloned so callers cannot mutate stored state by changing a result object.
- Native scoped methods partition data by the complete permission scope key.
- Overwrite methods such as `setRules()` and `setUserRoles()` preserve the `StorageAdapter` replacement contract.

This makes it useful for deterministic unit tests, runnable documentation, and short-lived development. It is also the default when `PermissionCore` is created without a storage option.

## Boundary

Data disappears when the process exits. Do not use it as production persistence.

The menu module has a separate `MemoryMenuStorageAdapter`. Creating a core `MemoryAdapter` does not automatically persist or share menu nodes and API bindings.
