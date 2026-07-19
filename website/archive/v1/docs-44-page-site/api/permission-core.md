# PermissionCore

`PermissionCore` is the public runtime that combines storage, cache, RBAC managers, resource schemes, and authorization checks.

## Purpose and import

```typescript
import { PermissionCore } from 'permission-core';
```

Use it for runtime decisions and access to `roles`, `users`, and scoped contexts. Authentication and business-data queries remain application responsibilities.

## Construction and types

`new PermissionCore(options?: PermissionCoreOptions)` accepts:

| Option | Type | Default |
|---|---|---|
| `storage` | `StorageAdapter` | `MemoryAdapter` |
| `cache` | `CacheLike \| CacheOptions` | internal `PermissionCache` |
| `strict` | `boolean` | `true` |
| `defaultScope` | `PermissionScope` | built-in default scope |
| `resourceSchemes` | `ResourceSchemeDefinition[]` | built-in schemes only |

Public properties are `roles: RoleManager`, `users: UserRoleManager`, and `resourceSchemes: ResourceSchemeRegistry`.

## Signature index

| Group | Signatures |
|---|---|
| Lifecycle | `init(): Promise<void>`; `close(): Promise<void>` |
| Basic checks | `can/cannot(userId, action, resource)`; `assert(userId, action, resource)` |
| Rows | `getRowScope`; `canRow/cannotRow`; `assertRow`; `filterRows` |
| Fields | `filterFields(userId, action, resource, data, context?)` |
| Readback | `getPermissions(userId)`; `getResources(userId, action?)` |
| Subject | `canSubject/cannotSubject`; `assertSubject`; `getPermissionsForSubject`; `getResourcesForSubject` |
| Context | `for(userId)`; `forSubject(subject)`; `scope(scope)` |
| Cache | `invalidate(userId)`; `invalidateSubject`; `invalidateScope`; `invalidateAll` |

Boolean methods return `Promise<boolean>`. Assertions return `Promise<void>`. Row and field filters return new arrays/partial objects.

## Behavior and defaults

Call `init()` before any manager or authorization method. Strict mode is on by default, deny wins over allow, and request-side `write` requires both create and update permission. Legacy `userId` methods and root managers operate in `defaultScope`; subject APIs require an explicit tenant scope.

`getResources()` is visibility output, not a replacement for final `can()` or `assert()`. Apply collection authorization before row filtering and row authorization before field filtering.

## Errors and limits

Calls before initialization throw `NOT_INITIALIZED`. Assertions can throw `PERMISSION_DENIED`; invalid actions, resources, subjects, or scope conflicts use `INVALID_ACTION`, `INVALID_RESOURCE_PATH`, or `INVALID_ARGUMENT`. Storage failures use `STORAGE_ERROR`.

Field filtering is top-level only. Context variables do not replace the API user or subject. `close()` closes owned runtime resources; ownership of injected storage/cache remains defined by those implementations.

## Minimal example

```typescript
const pc = new PermissionCore();
await pc.init();

await pc.roles.create('reader', { label: 'Reader' });
await pc.roles.allow('reader', 'read', 'db:orders');
await pc.users.assign('u-1', 'reader');

const allowed = await pc.can('u-1', 'read', 'db:orders');
await pc.close();
```

## Related

See [Permission Checks](/guide/check-permission), [Scoped Permissions](/api/scoped-permissions), [RoleManager](/api/role-manager), and [Error Codes](/api/errors).
