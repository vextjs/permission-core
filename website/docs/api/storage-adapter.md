# StorageAdapter

`StorageAdapter` is the persistence contract for roles, role rules, inheritance, and user-role bindings.

## Built-in implementations

- `MemoryAdapter`
- `FileAdapter`
- `MonSQLizeStorageAdapter`

## Responsibility

The adapter stores permission configuration. It does not run your business queries or replace your domain database model.

## Low-level write boundary

Adapter writes are overwrite-oriented persistence methods. `setUserRoles(userId, roleIds)` replaces one user's role bindings, and `setRules(roleId, rules)` replaces one role's stored rule snapshot.

Do not expose `StorageAdapter.setRules()` as a business role-rule batch API. Business code should normally use `RoleManager`, which validates roles, actions, resources, row-rule conditions, duplicate rules, deny-first conflict semantics, and cache invalidation. If you intentionally write through an adapter directly, your integration must provide those checks and call the appropriate cache invalidation API.

## Custom adapters

When implementing a custom adapter, preserve runtime semantics:

- do not reinterpret deny priority
- do not flatten role inheritance in a way that changes results
- keep rule `where` data intact
- implement initialization and cleanup consistently

See [Custom Adapter](/guide/custom-adapter) for the recommended design boundary.
