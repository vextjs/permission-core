# vext Integration

The runnable example uses the built-in adapter inside a real `vextjs/testing` host. It does not mock a request object or hand-roll permission middleware.

```javascript
import { createTestApp } from 'vextjs/testing';
import { PermissionCore } from 'permission-core';
import { createVextPermissionPlugin } from 'permission-core/adapters/vext';

const pc = new PermissionCore();
const permissionPlugin = createVextPermissionPlugin({
  core: pc,
  init: false,
  tenantRequired: true,
});

const app = await createTestApp({
  rootDir: new URL('../../../examples/vext-adapter/app/', import.meta.url),
});

app.use(async (req, _res, next) => {
  req.auth = {
    isAuthenticated: true,
    userId: String(req.headers['x-user-id']),
    tenantId: String(req.headers['x-tenant-id']),
  };
  await next();
});
app.use(permissionPlugin.middleware);
```

Route options declare the permissions consumed by the adapter guard:

```javascript
app.get('/api/users', {
  auth: {
    permissions: [{ action: 'invoke', resource: 'api:GET:/api/users' }],
    mode: 'all',
  },
}, async (_req, res) => res.json({ ok: true }));
```

Run it from the repository root:

```bash
npm run example:vext
```

The example proves an allowed `200` request and a denied `403 AUTH_FORBIDDEN` request. Authentication must run before the permission middleware. Keep collection, row, and field authorization in the service layer.

See the [vext Adapter guide](/guide/vext-adapter) and [API reference](/api/vext-adapter) for tenant conflict handling, resource resolution, `any/all` groups, manifest limits, and lifecycle ownership.
