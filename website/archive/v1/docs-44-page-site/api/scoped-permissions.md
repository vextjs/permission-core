# Scoped Permissions API

Scoped APIs isolate roles, bindings, rules, and cache keys by tenant/application scope.

## Purpose and import

```typescript
import type { PermissionScope, PermissionSubject } from 'permission-core';
```

Use subject methods for request authorization and `pc.scope(scope)` for scope-bound management operations.

## Construction and types

`PermissionScope` requires `tenantId` and optionally accepts `appId`, `moduleId`, and `namespace`. `PermissionSubject` extends it with `userId`, optional `roles`, and optional `claims`.

Create a bound context with `pc.scope(scope): PermissionCoreScopeContext`. Create a user-bound chain with `pc.forSubject(subject): PermissionCoreContext`. Do not construct either context class directly.

## Signature index

| Surface | Signatures |
|---|---|
| Subject checks | `canSubject`; `cannotSubject`; `assertSubject` |
| Subject reads | `getPermissionsForSubject`; `getResourcesForSubject` |
| Subject context/cache | `forSubject`; `invalidateSubject` |
| Scope context | `scope(scope)`; then `can/cannot/assert`, `for`, `forSubject` |
| Scoped management | `scoped.roles`; `scoped.users` |
| Scoped cache | `scoped.invalidate(userId)`; `scoped.invalidateScope()`; `pc.invalidateScope(scope)` |

## Behavior and defaults

Every scope field participates in the stable scope key. Root `roles`, root `users`, and legacy `pc.can(userId, ...)` use `defaultScope`. Subject APIs never infer a missing tenant from that default.

Native scoped adapters isolate every stored role, binding, and rule. A legacy third-party `StorageAdapter` is wrapped by `LegacyScopedStorageAdapter` and can serve only `defaultScope`.

## Errors and limits

Missing/empty `tenantId`, missing `userId`, or a subject that conflicts with a bound context throws `INVALID_ARGUMENT` before a permission decision. Invalid resources still throw `INVALID_RESOURCE_PATH`; denied assertions throw `PERMISSION_DENIED`.

`PermissionScope.namespace` is a logical authorization partition. An adapter `namespace` option is a physical collection prefix and does not create tenant isolation. Menu storage is a separate scoped contract.

## Minimal example

```typescript
const scope = { tenantId: 'tenant-a', appId: 'admin' };
const subject = { ...scope, userId: 'u-1' };
const scoped = pc.scope(scope);

await scoped.roles.create('admin', { label: 'Admin' });
await scoped.users.assign('u-1', 'admin');
await pc.assertSubject(subject, 'invoke', 'api:GET:/api/users');
```

## Related

See [Multi-tenant Permissions](/guide/multi-tenant), [PermissionCore](/api/permission-core), and [StorageAdapter](/api/storage-adapter).
