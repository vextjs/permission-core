# Basic Example

This example shows the smallest route-permission loop.

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

await pc.roles.create('operator', { label: 'Operator' });
await pc.roles.allow('operator', 'invoke', 'GET:/api/orders');
await pc.users.setUserRoles('u-1', ['operator']);

await pc.assert('u-1', 'invoke', 'GET:/api/orders');
await pc.close();
```

Run the repository example:

```bash
npm run example:http
```

The maintained example proves initialization, role creation, rule creation, user assignment, an allowed request, and graceful shutdown. Authentication still belongs to the host application.

Continue with [Resource Paths](/guide/resource-paths) before adding wildcards. Add [Row-level Permissions](/guide/row-level) and [Field Filtering](/guide/field-filter) only when the service also owns data authorization.
