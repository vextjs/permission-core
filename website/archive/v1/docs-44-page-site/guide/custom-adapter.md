# Custom Adapter

Implement `StorageAdapter` when you want to store permission data in a database that is not covered by the built-in adapters.

## What to implement

Your adapter must persist:

- roles
- role rules
- role inheritance
- user-role bindings

It should also provide predictable initialization and cleanup behavior.

## Keep semantics unchanged

A custom adapter should not reinterpret permission rules. The runtime owns deny priority, role merging, row-scope evaluation, and field filtering semantics.

## Next step

Read [StorageAdapter API](/api/storage-adapter) before writing the adapter.
