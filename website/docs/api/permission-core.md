# PermissionCore

`PermissionCore` is the main runtime entry. Initialization, shutdown, permission checks, row scopes, field filtering, resource listing, and cache invalidation all start here.

## Minimal example

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

try {
  const ok = await pc.can('user-001', 'invoke', 'GET:/api/users');
} finally {
  await pc.close();
}
```

All public APIs must run after `await pc.init()`.

## Constructor

```typescript
new PermissionCore(options?: PermissionCoreOptions)
```

| Option | Description |
|--------|-------------|
| `storage` | Storage implementation for roles, rules, and user bindings |
| `cache` | cache-hub compatible cache instance or cache config |
| `strict` | Strict mode; deny rules take priority over allow rules |

## API overview

| API | Returns | Purpose |
|-----|---------|---------|
| `init()` | `Promise<void>` | Initialize runtime and storage |
| `close()` | `Promise<void>` | Release adapter resources |
| `can()` | `Promise<boolean>` | Boolean permission decision |
| `cannot()` | `Promise<boolean>` | Semantic negative wrapper |
| `assert()` | `Promise<void>` | Throw when permission is missing |
| `getRowScope()` | `Promise<RowScope>` | Resolve row-level scope |
| `canRow()` | `Promise<boolean>` | Check one row |
| `cannotRow()` | `Promise<boolean>` | Negative row check |
| `assertRow()` | `Promise<void>` | Throw when a row is not allowed |
| `filterRows()` | `Promise<Record<string, unknown>[]>` | Filter row arrays |
| `filterFields()` | `Promise<Partial<Record<string, unknown>>>` | Filter object fields |
| `getPermissions()` | `Promise<PermissionRule[]>` | Read full effective rules |
| `getResources()` | `Promise<string[]>` | Read visible resource strings |
| `for(userId)` | `PermissionCoreContext` | Create a user-bound context |
| `invalidate(userId)` | `Promise<void>` | Clear one user's cache |
| `invalidateAll()` | `Promise<void>` | Clear all permission-core rule cache entries |
| `roles` | `RoleManager` | Role and rule management |
| `users` | `UserRoleManager` | User-role bindings |

## Integration paths

- HTTP-only: use `assert()`, `can()`, and `getResources()`.
- DB-only: use `can()`, `assert()`, `getRowScope()`, `filterRows()`, and `filterFields()`.
- Full standard stack: combine route permissions, data permissions, row scopes, management APIs, and cache invalidation.

## Constraints

- Anonymous requests should be rejected before calling permission-core.
- `filterFields(userId, action, resource, data)` requires an explicit action.
- Request-side `write` means `create && update`.
- Row permissions and field filtering are separate layers.
- `context` provides variables for rules, but does not override the API-level `userId`.
