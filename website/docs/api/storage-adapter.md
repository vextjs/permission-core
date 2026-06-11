# StorageAdapter

`StorageAdapter` is the persistence contract for roles, role rules, inheritance, and user-role bindings.

## Built-in implementations

- `MemoryAdapter`
- `FileAdapter`
- `MonSQLizeStorageAdapter`

## Responsibility

The adapter stores permission configuration. It does not run your business queries or replace your domain database model.

## Custom adapters

When implementing a custom adapter, preserve runtime semantics:

- do not reinterpret deny priority
- do not flatten role inheritance in a way that changes results
- keep rule `where` data intact
- implement initialization and cleanup consistently

See [Custom Adapter](/guide/custom-adapter) for the recommended design boundary.
