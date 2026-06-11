# Basic Example

This example shows the smallest route-permission loop.

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

await pc.roles.create('operator');
await pc.roles.allow('operator', 'invoke', 'GET:/api/orders');
await pc.users.setUserRoles('u-1', ['operator']);

await pc.assert('u-1', 'invoke', 'GET:/api/orders');
```

Run the repository example:

```bash
npm run example:http
```
