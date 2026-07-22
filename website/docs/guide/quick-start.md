# Quick Start
<!-- docs:inline-parity `quick-start.mjs` `msq.connect()` `pc.init()` `roles.create(input)` `id` `label` `tenantId` `MutationResult<Role>` `data` `roles.allow(roleId, rule)` `action/resource` `MutationResult<PermissionRuleView>` `userRoles.assign(userId, roleId)` `u-1` `MutationResult<UserRoleBindingSet>` `pc.scope(scope, defaults)` `acme` `actorId/requestId` `roles.create()` `roles.allow()` `userRoles.assign()` `pc.forSubject({ userId, scope })` `subject.can(action, resource)` `allowed: true` `invoke + api:GET:/api/orders` `deleteAllowed: false` `api:DELETE:/api/orders` `false` `can()` `MONGODB_URI` `pc.close()` `msq.close()` `finally` `scope` `subject` -->

This page does one thing: create a role, give the user permission to read the orders API, and show one allowed result plus one default-denied result. After this first path works, continue to the role admin, menu, or data-permission guides.

## 1. Install and Prepare MongoDB

Use Node.js 18 or newer and a transaction-capable MongoDB deployment. Install permission-core with its only database dependency, MonSQLize 3.1:

```bash
npm install permission-core monsqlize@3.1.0
```

Put the MongoDB URI in an environment variable. The command below is local development only; production applications should use the host application's own configuration mechanism.

```bash
MONGODB_URI=mongodb://127.0.0.1:27017 node quick-start.mjs
```

## 2. Connect and Initialize

Create `quick-start.mjs` with this complete code:

<!-- docs:first-success:start -->
```js
import MonSQLize from 'monsqlize';
import { PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: process.env.MONGODB_DATABASE ?? 'permission_core_quick_start',
  config: {
    uri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
  },
});

await msq.connect();
const pc = new PermissionCore({ monsqlize: msq });

try {
  await pc.init();

  const scope = { tenantId: 'acme' };
  const scoped = pc.scope(scope, {
    actorId: 'quick-start',
    requestId: 'req-quick-start-first-success',
  });

  await scoped.roles.create({
    id: 'order-reader',
    label: '订单只读',
  });
  await scoped.roles.allow('order-reader', {
    action: 'invoke',
    resource: 'api:GET:/api/orders',
  });
  await scoped.userRoles.assign('u-1', 'order-reader');

  const subject = pc.forSubject({ userId: 'u-1', scope });
  const allowed = await subject.can('invoke', 'api:GET:/api/orders');
  const deleteAllowed = await subject.can('invoke', 'api:DELETE:/api/orders');

  console.log(JSON.stringify({ allowed, deleteAllowed }, null, 2));
} finally {
  await pc.close();
  await msq.close();
}
```
<!-- docs:first-success:end -->

`msq.connect()` creates the database connection owned by the host application. `pc.init()` creates or verifies the collections and indexes required by permission-core. permission-core uses the supplied MonSQLize runtime, but does not own it, so shutdown closes both resources explicitly.

## 3. Create the Role and Bind the User

The three write methods in the middle of the code create the smallest useful authorization state:

| Call | What the arguments mean | What changes | Raw return |
|---|---|---|---|
| `roles.create(input)` | `id` is the stable role ID used by code; `label` is the display name | Creates a role under the current `tenantId` | `MutationResult<Role>`, with the role in `data` |
| `roles.allow(roleId, rule)` | The first argument selects the role; `action/resource` describes the allowed operation | Adds one allow rule to the role | `MutationResult<PermissionRuleView>` |
| `userRoles.assign(userId, roleId)` | `u-1` comes from the host user system; the second argument is an existing role | Adds one direct role to the user | `MutationResult<UserRoleBindingSet>` |

`pc.scope(scope, defaults)` keeps these management operations inside the `acme` tenant. It does not write to the database by itself. The `actorId/requestId` defaults are reused by later management writes for audit and idempotency context, so normal code does not pass `actorId` or `idempotencyKey` to every `roles.create()`, `roles.allow()`, or `userRoles.assign()` call. permission-core does not create or log in `u-1`; it stores only the relationship between that user ID and the role.

## 4. Verify Allow and Default Deny

`pc.forSubject({ userId, scope })` binds a trusted user and scope into a decision context. `subject.can(action, resource)` returns a boolean and does not modify authorization state.

Running the file should print:

```json
{
  "allowed": true,
  "deleteAllowed": false
}
```

This is the **raw example output** printed by the program:

- `allowed: true`: the role has the `invoke + api:GET:/api/orders` allow rule.
- `deleteAllowed: false`: no rule allows `api:DELETE:/api/orders`, so the system denies it by default.

The example does not assign a DELETE permission to the user, and it does not create a separate deny rule. `false` is simply the normal result of calling `can()` for an unauthorized operation.

If the first run fails, check that MongoDB is reachable, that it supports transactions, and that `MONGODB_URI` points at the expected instance. If you reuse a non-empty example database, the role may already exist; use a clean database or remove the example data before rerunning.

## 5. Close and Continue

> **Resource shutdown.** permission-core uses the host MonSQLize connection but does not own it; the fixed order is `pc.close()` first, then host-owned `msq.close()`.

`finally` guarantees that success and failure both drain permission-core before the host closes the database connection.

You now have the first successful core RBAC path:

- To build a role management backend, continue to [Manage Roles and User Assignments](/guide/manage-roles-and-users).
- To handle interruption, diagnostics, and permission snapshots in business code, continue to [Check Permissions](/guide/check-permission).
- If `scope`, `subject`, direct, or effective state is still unclear, read [Core Terms and Mental Model](/guide/core-concepts).
