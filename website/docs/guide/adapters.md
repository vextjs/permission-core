# Storage Adapters

Storage adapters persist roles, rules, and user-role bindings. The optional menu module has a separate storage contract for menu nodes, API bindings, revisions, and audit events.

## Built-in adapters

| Adapter | Best for |
|---------|----------|
| `MemoryAdapter` | Tests, demos, examples |
| `FileAdapter` | Local fallback and single-process persistence |
| `MonSQLizeStorageAdapter` | Official production persistence path |

Menu-module counterparts are imported from `permission-core/menu`:

| Adapter | Best for |
|---|---|
| `MemoryMenuStorageAdapter` | Tests and short-lived examples |
| `FileMenuStorageAdapter` | Local, single-process menu persistence |
| `MonSQLizeMenuStorageAdapter` | Durable production menu and API-binding persistence |

## Adapter boundary

The core adapter stores authorization configuration. It does not execute your business database queries and does not replace your payment ledger or transaction store.

The menu adapter stores presentation and binding configuration. It does not make final backend authorization decisions. A visible button still needs an API binding and a server-side `assertSubject()` or framework guard.

## Choosing an adapter

- Start with `MemoryAdapter` for tests and examples.
- Use `FileAdapter` for simple local persistence only.
- Use `MonSQLizeStorageAdapter` when rules and bindings need durable storage.
- Implement `StorageAdapter` when you need another database.
- Choose the matching menu adapter independently when `permission-core/menu` is enabled.

## Production setup with both stores

```typescript
const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({
    msq,
    namespace: 'permission_core',
    ownsConnection: true,
  }),
  cache: msq.getCache(),
});

const menu = createMenuPermission({
  core: pc,
  storage: new MonSQLizeMenuStorageAdapter({
    msq,
    namespace: 'permission_core_menu',
    ownsConnection: false,
  }),
});

await pc.init();
await menu.init();
```

Only one adapter should own a shared MonSQLize connection. Close dependents first: `await menu.close()`, then `await pc.close()`.

## Consistency boundaries

- Core authorization saves invalidate permission caches through the public managers.
- Menu imports are revisioned snapshots and produce audit events.
- A menu write that cannot complete its related authorization save reports compensation failure; it does not silently claim success.
- Back up and migrate core and menu collections together when one release changes both contracts.
- File adapters are not a distributed consistency mechanism. Memory adapters are not durable production storage.

## Next step

See [StorageAdapter API](/api/storage-adapter), [Menu Module API](/api/menu), [Production Deployment](/guide/production-deployment), and [Custom Adapter](/guide/custom-adapter).
