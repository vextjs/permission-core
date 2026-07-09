# Production Deployment

Production deployment should make permissions explicit, observable, and easy to invalidate.

## Recommended stack

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

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
```

## Operational checklist

- Call `await pc.init()` during service startup.
- Call `await pc.close()` during graceful shutdown.
- Use matched route templates for route resources.
- Send user-role binding changes through `pc.users`, or call `pc.invalidate(userId)` when you bypass it.
- Send role-rule and inheritance changes through `pc.roles`, or call `pc.invalidateAll()` when you bypass it.
- Keep permission-denied logs searchable, but do not log sensitive values.
- Treat `getResources()` as UI visibility, not final authorization.

## Payment and finance notes

For payment flows, model high-risk operations explicitly:

- `POST:/api/refunds`
- `POST:/api/payouts`
- `db:transactions`
- `db:transactions:amount`
- `db:refunds:internalNote`

Avoid broad wildcards for money movement, refund approval, payout release, or ledger mutation unless the role is intentionally privileged and reviewed.
