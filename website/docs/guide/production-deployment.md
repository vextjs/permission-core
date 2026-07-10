# Production Deployment

Production deployment should make permissions explicit, observable, and easy to invalidate.

## Recommended stack

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';
import {
  MonSQLizeMenuStorageAdapter,
  createMenuPermission,
} from 'permission-core/menu';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'permission_core',
  config: { uri: process.env.MONGO_URI! },
  cache: { defaultTtl: 300_000, maxEntries: 1000 },
});

await msq.connect();

const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({
    msq,
    namespace: 'permission_core',
    ownsConnection: true,
  }),
  cache: msq.getCache(),
});

await pc.init();

const menu = createMenuPermission({
  core: pc,
  storage: new MonSQLizeMenuStorageAdapter({
    msq,
    namespace: 'permission_core_menu',
    ownsConnection: false,
  }),
  strictApiBindings: true,
});

await menu.init();
```

`MonSQLizeStorageAdapter` stores roles, rules, inheritance, and user-role bindings. `MonSQLizeMenuStorageAdapter` separately stores the menu tree, button/API bindings, manifest revision, and menu audit events. They can share one connected MonSQLize instance, but they do not share collections or lifecycle ownership.

## Storage and lifecycle contract

| Component | Production responsibility | Ownership rule |
|---|---|---|
| `PermissionCore` | Authorization rules and user-role bindings | Close it during application shutdown |
| `MenuPermissionManager` | Menu snapshot, imports, bindings, revision, and audit | Close before the core when it uses the core |
| `MonSQLizeStorageAdapter` | Durable core authorization data | `ownsConnection:true` only when it owns the shared connection |
| `MonSQLizeMenuStorageAdapter` | Durable menu and API-binding data | Use `ownsConnection:false` when sharing the core connection |

Shut down in dependency order:

```typescript
try {
  await startServer();
} finally {
  await menu.close();
  await pc.close();
}
```

`MemoryAdapter` and `MemoryMenuStorageAdapter` are for tests and examples. File adapters are a single-process persistence option; they do not provide distributed locking, multi-instance propagation, or database backup semantics.

## Change, recovery, and migration

- Treat manifest imports as revisioned configuration changes. Prefer `replace` for an authoritative frontend manifest and `merge` only for deliberate partial ownership.
- Run `validate()` before promotion. A missing page parent, duplicate code, invalid API binding, or unknown resource scheme should block deployment.
- Persist and monitor menu audit events. Record actor, reason, previous revision, new revision, and the resulting diff in your change ticket or deployment log.
- If a core role/rule save succeeds but cache invalidation fails, the manager reports the failure instead of pretending the operation was fully applied. Retry invalidation or roll the write back according to your operational policy.
- Back up both core authorization collections and menu collections before schema or namespace migration. Restore them as one logical authorization release.
- During rolling upgrades, deploy readers that accept both old and new records before writing the new shape; invalidate permission caches after the data change.

## Operational checklist

- Call `await pc.init()` during service startup.
- Call `await pc.close()` during graceful shutdown.
- Call `await menu.close()` before `pc.close()` when the menu module is enabled.
- Keep exactly one owner for a shared MonSQLize connection.
- Use matched route templates for route resources.
- Send user-role binding changes through `pc.users`, or call `pc.invalidate(userId)` when you bypass it.
- Send role-rule and inheritance changes through `pc.roles`, or call `pc.invalidateAll()` when you bypass it.
- Keep permission-denied logs searchable, but do not log sensitive values.
- Treat `getResources()` as UI visibility, not final authorization.
- Validate imported menu manifests and retain revision/audit evidence.
- Alert on compensation failures, cache invalidation failures, and unexpected revision changes.

## Payment and finance notes

For payment flows, model high-risk operations explicitly:

- `POST:/api/refunds`
- `POST:/api/payouts`
- `db:transactions`
- `db:transactions:amount`
- `db:refunds:internalNote`

Avoid broad wildcards for money movement, refund approval, payout release, or ledger mutation unless the role is intentionally privileged and reviewed.
