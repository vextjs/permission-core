# StorageAdapter

`StorageAdapter` is the persistence contract for roles, role rules, inheritance, and user-role bindings.

## Built-in implementations

- `MemoryAdapter`
- `FileAdapter`
- `MonSQLizeStorageAdapter`

## Responsibility

The adapter stores permission configuration. It does not run your business queries or replace your domain database model.

## Required methods

```typescript
abstract init(): Promise<void>;
abstract close(): Promise<void>;
abstract getRoles(): Promise<Map<string, RoleData>>;
abstract getRole(id: string): Promise<RoleData | null>;
abstract setRole(id: string, role: RoleData): Promise<void>;
abstract deleteRole(id: string): Promise<void>;
abstract getUserRoles(userId: string): Promise<string[]>;
abstract setUserRoles(userId: string, roleIds: string[]): Promise<void>;
abstract getUsersByRole(roleId: string): Promise<string[]>;
abstract getRules(roleId: string): Promise<PermissionRule[]>;
abstract setRules(roleId: string, rules: PermissionRule[]): Promise<void>;
abstract deleteRules(roleId: string): Promise<void>;
```

`getUsersByRole()` is required so role deletion can remove direct user bindings. Return cloned/stable data and make overwrite behavior explicit.

## Low-level write boundary

Adapter writes are overwrite-oriented persistence methods. `setUserRoles(userId, roleIds)` replaces one user's role bindings, and `setRules(roleId, rules)` replaces one role's stored rule snapshot.

Do not expose `StorageAdapter.setRules()` as a business role-rule batch API. Business code should normally use `RoleManager`, which validates roles, actions, resources, row-rule conditions, duplicate rules, deny-first conflict semantics, and cache invalidation. If you intentionally write through an adapter directly, your integration must provide those checks and call the appropriate cache invalidation API.

## Custom adapters

When implementing a custom adapter, preserve runtime semantics:

- do not reinterpret deny priority
- do not flatten role inheritance in a way that changes results
- keep rule `where` data intact
- implement initialization and cleanup consistently

Tenant-aware applications should implement `ScopedStorageAdapter`. A legacy unscoped adapter is wrapped for `defaultScope` only; attempts to use another scope fail with `INVALID_ARGUMENT` instead of mixing tenants.

Menu persistence is intentionally not part of this interface. `MenuPermissionStorageAdapter` separately owns menu nodes, API bindings, revisions, and audit entries.

See [Custom Adapter](/guide/custom-adapter) for the recommended design boundary.
