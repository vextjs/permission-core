# Scoped Permissions API

Import from `permission-core`.

```ts
const scope = { tenantId: "tenant-a", appId: "admin" };
const subject = { ...scope, userId: "u-1" };

await pc.canSubject(subject, "read", "ui:menu:system.user");
await pc.assertSubject(subject, "invoke", "api:GET:/api/users");
await pc.getResourcesForSubject(subject, "read");

const scoped = pc.scope(scope);
await scoped.roles.create("admin", { label: "Admin" });
await scoped.users.assign("u-1", "admin");
```

Core additions:

| API | Purpose |
|---|---|
| `PermissionScope` | Tenant/app/module/namespace boundary |
| `PermissionSubject` | Scope plus `userId`, optional roles and claims |
| `canSubject()` / `assertSubject()` | Subject-aware checks |
| `forSubject()` | Chain context bound to a subject |
| `scope()` | Scope-aware roles/users/checking context |
| `invalidateSubject()` | Clear one subject cache entry |
| `invalidateScope()` | Clear all rule cache entries in one scope |

Legacy APIs such as `can(userId, action, resource)` and `roles.allow()` still use the default scope.

## Types

```ts
interface PermissionScope {
  tenantId: string;
  appId?: string;
  moduleId?: string;
  namespace?: string;
}

interface PermissionSubject extends PermissionScope {
  userId: string;
  roles?: string[];
  claims?: Record<string, unknown>;
}
```

`tenantId` is required at runtime, including calls from untyped JavaScript. The other fields create additional partitions inside one tenant. All fields participate in the stable `scopeKey`.

## Subject methods

```ts
canSubject(subject, action, resource): Promise<boolean>
cannotSubject(subject, action, resource): Promise<boolean>
assertSubject(subject, action, resource): Promise<void>
getPermissionsForSubject(subject): Promise<PermissionRule[]>
getResourcesForSubject(subject, action?): Promise<string[]>
forSubject(subject): PermissionCoreContext
invalidateSubject(subject): Promise<void>
```

These methods validate the subject and execute against its exact scope. `assertSubject()` throws `PERMISSION_DENIED`; invalid or missing scope fields throw `INVALID_ARGUMENT` or `INVALID_RESOURCE_PATH` before a permission decision.

## Bound scope context

```ts
const scoped = pc.scope(scope);

scoped.can(userId, action, resource): Promise<boolean>
scoped.assert(userId, action, resource): Promise<void>
scoped.getPermissions(userId): Promise<PermissionRule[]>
scoped.getResources(userId, action?): Promise<string[]>
scoped.for(userId): PermissionCoreContext
scoped.forSubject(subject): PermissionCoreContext
scoped.roles: RoleManager
scoped.users: UserRoleManager
scoped.invalidate(userId): Promise<void>
scoped.invalidateScope(): Promise<void>
```

`forSubject()` requires every scope field to match the bound scope. It throws instead of silently authorizing the subject in a different tenant.

## Storage and cache behavior

Native scoped adapters persist each role, user binding, and rule under its scope key. A legacy third-party `StorageAdapter` is wrapped by `LegacyScopedStorageAdapter` and supports only `defaultScope`; another scope fails with `INVALID_ARGUMENT`.

Rule cache keys include the scope. `invalidateSubject()` removes one subject entry, while `invalidateScope()` removes every permission rule entry in one scope. Neither method clears another tenant.

## Compatibility rules

- Legacy `pc.can(userId, ...)`, root `pc.roles`, and root `pc.users` use `defaultScope`.
- Subject and scoped APIs never infer a missing `tenantId` from legacy defaults.
- `PermissionScope.namespace` is a logical authorization partition. Adapter `namespace` options are physical collection prefixes and do not create tenant isolation.
- Menu storage is a separate contract; configure a scope-aware menu adapter when using `permission-core/menu`.

See [Multi-tenant Permissions](/guide/multi-tenant) for the runnable setup and failure recovery flow.
