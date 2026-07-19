# PermissionCoreContext

`PermissionCoreContext` binds a user or subject so repeated checks do not repeat identity arguments.

## Purpose and import

```typescript
import type { PermissionCoreContext } from 'permission-core';
```

Normally obtain it from `pc.for(userId)`, `pc.forSubject(subject)`, or a scoped context. The type import is useful for service signatures.

## Construction and types

Do not call the constructor directly. `pc.for(userId)` binds the default scope; `pc.forSubject(subject)` validates and binds the subject's exact scope. `pc.scope(scope).for(userId)` binds an explicit scope.

The context retains the bound identity and delegates to the same checker/resource registry as its parent `PermissionCore`.

## Signature index

| Group | Methods |
|---|---|
| Basic | `can`; `cannot`; `assert` |
| Rows | `getRowScope`; `canRow`; `cannotRow`; `assertRow`; `filterRows` |
| Fields | `filterFields` |
| Reads | `getPermissions`; `getResources(action?)` |

The bound identity is omitted from every method; action, resource, data, and optional context remain explicit.

## Behavior and defaults

Methods preserve strict/deny semantics and cache behavior from the parent core. A bound context is a convenience surface, not a new authorization model or cache partition.

Use it inside one request/service operation when many checks share the same subject. Keep role management and cache invalidation on `PermissionCore` or `PermissionCoreScopeContext`.

## Errors and limits

Creating a subject context validates tenant scope and can throw `INVALID_ARGUMENT`. Runtime methods can throw `NOT_INITIALIZED`, `INVALID_ACTION`, `INVALID_RESOURCE_PATH`, `PERMISSION_DENIED`, or `STORAGE_ERROR` under the same conditions as core methods.

An object named `userId` inside the optional context never replaces the bound identity. The context does not expose `roles`, `users`, `invalidate`, or lifecycle methods.

## Minimal example

```typescript
const auth = pc.forSubject({
  tenantId: 'tenant-a',
  appId: 'admin',
  userId: 'u-1',
});

await auth.assert('invoke', 'api:GET:/api/orders');
const fields = await auth.filterFields('read', 'db:orders', order);
```

## Related

See [PermissionCore](/api/permission-core), [Scoped Permissions](/api/scoped-permissions), and [Permission Checks](/guide/check-permission).
