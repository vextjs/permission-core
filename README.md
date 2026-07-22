# permission-core

[Documentation](https://vextjs.github.io/permission-core/) | [Quick Start](./website/docs/guide/quick-start.md) | [Examples](./examples/README.md) | [Changelog](./CHANGELOG.md)

permission-core is a tenant-aware authorization core for Node.js. It persists RBAC state through the host's MonSQLize 3.1 instance and uses one `action + resource` model for routes, menus, backend APIs, database rows, and fields.

## Install

```bash
npm install permission-core monsqlize@3.1.0
```

The root and `permission-core/match` entries support Node.js `>=18.0.0`. The optional `permission-core/plugins/vext` entry inherits Vext 0.3.26's stricter Node.js `>=20.19.0` requirement.

```ts
import MonSQLize from 'monsqlize';
import { PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://127.0.0.1:27017' },
});
await msq.connect();

const pc = new PermissionCore({ monsqlize: msq });
await pc.init();

const scope = { tenantId: 'acme' };
const scoped = pc.scope(scope, {
  actorId: 'quick-start',
  requestId: 'req-quick-start',
});
await scoped.roles.create({ id: 'order-reader', label: 'Order reader' });
await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/api/orders',
});
await scoped.userRoles.assign('u-1', 'order-reader');

const subject = pc.forSubject({ userId: 'u-1', scope });
console.log(await subject.can('invoke', 'api:GET:/api/orders')); // true
console.log(await subject.cannot('invoke', 'api:DELETE:/api/orders')); // true

await pc.close();
await msq.close();
```

`cannot(...)` is the logical negation of `can(...)`; the DELETE result is true because no allow rule exists, not because a blocked permission was assigned.

`pc.scope(scope, defaults)` binds trusted management context once. With `actorId/requestId` defaults present, ordinary writes reuse the same audit context and derive their own idempotency keys; hand-written `idempotencyKey` values are only for advanced gateway or queue integrations.

## Included capabilities

- scoped roles, direct user-role bindings, single-parent inheritance, allow/deny rules, and effective permission reads
- high-level menu config, page/action/API ownership, previewed role-menu grants, view trees, action maps, view state, and response field projection
- authorized Mongo collections that compose business filters, exact tenant fields, row conditions, field permissions, and bounded writes
- optimistic revisions, idempotency, audit evidence, health reporting, and optional MonSQLize-backed semantic caching
- optional native Vext integration from `permission-core/plugins/vext` for hosts on Node.js `>=20.19.0`

## Ownership boundary

The application owns authentication, trusted subject construction, the MonSQLize connection, business data, HTTP serialization, and operational policy. permission-core owns authorization state and decisions. It does not implement login, expose a generic database adapter layer, or close the host database connection.

## Runnable examples

```bash
npm run example:basic
npm run example:multi-tenant
npm run example:data-guard
npm run example:menu-admin
npm run example:vext
```

Run all five with `npm run example:all`. Each emits stable JSON and uses an in-memory Mongo replica set only as a repository fixture; production applications pass their existing connected MonSQLize 3.1 instance.

## Documentation map

- [Quick Start](./website/docs/guide/quick-start.md): installation through a first role check, plus the next menu/API/response-field path
- [Permission lifecycle](./website/docs/guide/permission-lifecycle.md): transaction, revision, audit, cache, and fail-closed behavior
- [API reference](./website/docs/api/core-and-contexts.md): exact public managers, responses, errors, and limits
- [Troubleshooting](./website/docs/guide/troubleshooting.md): recovery by error code and details discriminator

Repository validation and release commands are documented separately in [CONTRIBUTING.md](./CONTRIBUTING.md). Security reports follow [SECURITY.md](./SECURITY.md).
