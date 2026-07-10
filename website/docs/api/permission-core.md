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
| `defaultScope` | Scope used by legacy `userId` APIs and root managers |
| `resourceSchemes` | Custom resource validators and matchers registered at startup |

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
| `canSubject()` / `assertSubject()` | subject-aware result | Exact-scope authorization |
| `scope(scope)` | `PermissionCoreScopeContext` | Scope-bound roles, users, and checks |
| `resourceSchemes` | `ResourceSchemeRegistry` | Shared custom resource registry |

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

## Decision and assertion results

```typescript
const allowed = await pc.can(userId, 'invoke', 'GET:/api/orders');
const denied = await pc.cannot(userId, 'invoke', 'POST:/api/payouts');

try {
  await pc.assert(userId, 'invoke', 'POST:/api/payouts');
} catch (error) {
  // PermissionCoreError with code PERMISSION_DENIED
}
```

`getPermissions()` returns the effective merged rule objects, including deny and row conditions. `getResources(action?)` returns visible allow resource strings after strict deny filtering and is suitable for UI hints, not final authorization.

## Row and field results

```typescript
const scope = await pc.getRowScope(userId, 'read', 'db:orders', { merchantId });
const oneAllowed = await pc.canRow(userId, 'read', 'db:orders', order, { merchantId });
const visibleRows = await pc.filterRows(userId, 'read', 'db:orders', orders, { merchantId });
const visibleFields = await pc.filterFields(userId, 'read', 'db:orders', order);
```

Row scope and field filtering are independent. Apply the row scope to the database query when datasets are large, then use `canRow()`/`filterRows()` as a final check. Field filtering only handles top-level fields in v1.

## Scoped and subject APIs

```typescript
const scope = { tenantId: 'tenant-a', appId: 'admin' };
const subject = { ...scope, userId: 'u-1' };
const tenant = pc.scope(scope);

await tenant.roles.create('operator', { label: 'Operator' });
await tenant.users.assign(subject.userId, 'operator');
await pc.assertSubject(subject, 'invoke', 'api:GET:/api/orders');
await pc.invalidateSubject(subject);
await pc.invalidateScope(scope);
```

Missing tenants and subject/bound-scope conflicts fail with `INVALID_ARGUMENT`. See [Scoped Permissions API](/api/scoped-permissions) for the full contract.

## Cache and lifecycle

`invalidate(userId)` removes one default-scope user result. `invalidateAll()` removes permission-core rule-cache keys without clearing unrelated entries from a shared cache-hub instance. `close()` closes the storage and the internally created cache; after close, public calls fail with `NOT_INITIALIZED` until `init()` runs again.
