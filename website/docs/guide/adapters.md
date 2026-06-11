# Storage Adapters

Storage adapters persist roles, rules, and user-role bindings.

## Built-in adapters

| Adapter | Best for |
|---------|----------|
| `MemoryAdapter` | Tests, demos, examples |
| `FileAdapter` | Local fallback and single-process persistence |
| `MonSQLizeStorageAdapter` | Official production persistence path |

## Adapter boundary

The adapter stores permission configuration. It does not execute your business database queries and does not replace your payment ledger or transaction store.

## Choosing an adapter

- Start with `MemoryAdapter` for tests and examples.
- Use `FileAdapter` for simple local persistence only.
- Use `MonSQLizeStorageAdapter` when rules and bindings need durable storage.
- Implement `StorageAdapter` when you need another database.

## Next step

See [StorageAdapter API](/api/storage-adapter) and [Custom Adapter](/guide/custom-adapter).
