# UserRoleManager

`UserRoleManager` manages direct user-to-role bindings inside one permission scope.

## Purpose and import

```typescript
import type { UserRoleManager } from 'permission-core';
```

Use `pc.users` for the default scope or `pc.scope(scope).users` for a tenant scope. The manager is created by `PermissionCore`.

## Construction and types

Bindings use string `userId` values and arrays of string role IDs. The manager validates role existence through the same scoped storage as its parent core.

No public constructor configuration is required. Cache invalidation and scope are inherited from the parent runtime.

## Signature index

| Method | Purpose |
|---|---|
| `assign(userId, roleId)` | Add one role if not already bound |
| `revoke(userId, roleId)` | Remove one role |
| `getUserRoles(userId)` | Read direct role IDs |
| `setUserRoles(userId, roleIds)` | Replace all direct role IDs |
| `clearUserRoles(userId)` | Remove every direct role binding |

All writes return `Promise<void>`; reads return `Promise<string[]>`.

## Behavior and defaults

`setUserRoles()` deduplicates input and validates every role before one replacement write. `assign()` is idempotent for an existing binding. Public writes invalidate only the affected user's rule cache in the current scope.

Use replacement saves for admin forms and targeted assign/revoke for small commands. Returned roles are direct bindings, not expanded inherited permissions.

## Errors and limits

Empty user/role IDs throw `INVALID_ARGUMENT`; assigning or replacing with a missing role throws `ROLE_NOT_FOUND`. Storage failures propagate as storage errors.

The manager does not authenticate users, create roles, or return effective rules. Concurrent form saves require an application-level revision strategy if last-write-wins is not acceptable.

## Minimal example

```typescript
await pc.users.setUserRoles('u-1', ['support', 'auditor']);
const roleIds = await pc.users.getUserRoles('u-1');
await pc.users.revoke('u-1', 'auditor');
```

## Related

See [RoleManager](/api/role-manager), [Management Console](/guide/site-preview-release), and [Scoped Permissions](/api/scoped-permissions).
