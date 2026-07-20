# Basic RBAC
<!-- docs:inline-parity `assign` `set` `examples/basic.mjs` `docs:basic:start` `docs:basic:end` `examples/_support/host.mjs` `finally` `ok` `true` `permissionChecks.allowed` `permissionChecks.cannotDelete` `userRoles.afterSet` `order-reader` `set()` `cannotDelete: true` `can()` `assigned` `replaced` `role` `roles.create` `acme` `roles.allow` `GET:/api/orders` `action` `resource` `reads.ownRules` `roles.create(input)` `{ id, label }` `1` `roles.get()` `roles.allow(roleId, rule)` `roles.get(roleId)` `id` `label` `revision` `roles.getOwnRules(roleId)` `userRoles.assign` `u-1` `userRoles.set` `userRoles.getDirect` `operator` `beforeSet` `userRoles.set(..., { expectedRevision })` `afterSet` `expectedRevision` `getDirect` `userRoles.assign(userId, roleId)` `data.roleIds` `userRoles.getDirect(userId)` `userRoles.set(userId, roleIds, options)` `actorId` `userRoles.getEffective(userId)` `forSubject` `can` `cannot` `explain` `no-allow` `assert` `core.forSubject(input)` `userId` `scope` `subject.can(action, resource)` `invoke` `subject.cannot(action, resource)` `subject.explain(action, resource)` `data.reason` `roles.get` `roles.getOwnRules` `roles.getEffectiveRules` `roles.getChain` `userRoles.getEffective` `getPermissions` `getResources` `getResources('invoke')` `roles.getEffectiveRules(roleId)` `getOwnRules` `data.rules.items` `roles.getChain(roleId)` `role.id` `subject.getPermissions()` `data.rules.total` `subject.getResources(action)` `printExample()` `2` `userRoles` `effective` `getEffective` `semantics` `permissionChecks` `allowed` `cannotDelete` `deleteReason` `reads` -->

## Scenario

This is the first complete RBAC path: create a role and rule, assign the role to a user, check allow/default-deny behavior, compare additive `assign` with replacing `set`, and read own/effective authorization state.

## Run

```bash
npm run example:basic
```

The canonical source is the `docs:basic:start` to `docs:basic:end` block in `examples/basic.mjs`, using the shared host fixture in `examples/_support/host.mjs`.

## First Check the Result

A successful run first confirms `ok` is `true`, `permissionChecks.allowed` is `true`, `permissionChecks.cannotDelete` is `true`, and `userRoles.afterSet` finally contains only `order-reader`.

## Source walkthrough

```js
await scoped.roles.create({ id: 'order-reader', label: 'Order reader' });
await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'GET:/api/orders',
});
await scoped.roles.create({ id: 'operator', label: 'Operator' });

const assigned = await scoped.userRoles.assign('u-1', 'order-reader');
const subject = core.forSubject({ userId: 'u-1', scope });
const allowed = await subject.can('invoke', 'GET:/api/orders');
const cannotDelete = await subject.cannot('invoke', 'DELETE:/api/orders');

await scoped.userRoles.assign('u-1', 'operator');
const beforeSet = await scoped.userRoles.getDirect('u-1');
const replaced = await scoped.userRoles.set('u-1', ['order-reader'], {
  expectedRevision: beforeSet.data.revision,
  actorId: 'admin',
});

const role = await scoped.roles.get('order-reader');
const ownRules = await scoped.roles.getOwnRules('order-reader');
const effectiveRules = await scoped.roles.getEffectiveRules('order-reader');
const roleChain = await scoped.roles.getChain('order-reader');
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
const permissions = await subject.getPermissions();
const resources = await subject.getResources('invoke');
const deleteExplanation = await subject.explain(
  'invoke',
  'DELETE:/api/orders',
);
```

`cannotDelete: true` means the matching `can()` result is false because there is no delete allow. It does not grant delete access and it does not create a separate deny rule.

### 1. Create the role state

<!-- docs:operation id=basic-role-state calls=roles.create,roles.allow outputs=role,reads.ownRules -->

**Purpose and target.** This operation explains `roles.create`, `roles.allow` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `role`, `reads.ownRules`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [roles](/api/roles) for exact signatures, response wrappers, and public error codes.

### 2. Add a role, then replace the direct-role set

<!-- docs:operation id=basic-assignment calls=userRoles.assign,userRoles.getDirect,userRoles.set outputs=userRoles.afterAssign,userRoles.beforeSet,userRoles.afterSet -->

**Purpose and target.** This operation explains `userRoles.assign`, `userRoles.getDirect`, `userRoles.set` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `userRoles.afterAssign`, `userRoles.beforeSet`, `userRoles.afterSet`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [user-roles](/api/user-roles) for exact signatures, response wrappers, and public error codes.

### 3. Evaluate the concrete operation

<!-- docs:operation id=basic-decision calls=forSubject,can,cannot,explain outputs=permissionChecks -->

**Purpose and target.** This operation explains `forSubject`, `can`, `cannot`, `explain` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `permissionChecks`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [core-and-contexts](/api/core-and-contexts) for exact signatures, response wrappers, and public error codes.

### 4. Read effective authorization state

<!-- docs:operation id=basic-effective-reads calls=roles.get,roles.getOwnRules,roles.getEffectiveRules,roles.getChain,userRoles.getEffective,getPermissions,getResources outputs=role,userRoles.effective,reads -->

**Purpose and target.** This operation explains `roles.get`, `roles.getOwnRules`, `roles.getEffectiveRules`, `roles.getChain`, `userRoles.getEffective`, `getPermissions`, `getResources` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `role`, `userRoles.effective`, `reads`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [roles](/api/roles), [user-roles](/api/user-roles), [core-and-contexts](/api/core-and-contexts) for exact signatures, response wrappers, and public error codes.


## Expected output

The following JSON is the **Example summary output** generated by `printExample()`. It combines selected fields from several API calls and is not the raw response of one method.

```json
{
  "example": "basic",
  "ok": true,
  "role": {
    "id": "order-reader",
    "label": "Order reader",
    "revision": 2
  },
  "userRoles": {
    "afterAssign": ["order-reader"],
    "beforeSet": ["operator", "order-reader"],
    "afterSet": ["order-reader"],
    "effective": ["order-reader"],
    "semantics": {
      "assign": "adds one direct role",
      "set": "replaces the complete direct-role set at the expected revision"
    }
  },
  "permissionChecks": {
    "allowed": true,
    "cannotDelete": true,
    "cannotMeaning": "true because can(...) is false; it is not a separate deny assignment",
    "deleteReason": "no-allow"
  },
  "reads": {
    "ownRules": ["allow:invoke:GET:/api/orders"],
    "effectiveRules": ["allow:invoke:GET:/api/orders"],
    "roleChain": ["order-reader"],
    "permissionRuleCount": 1,
    "resources": ["GET:/api/orders"]
  }
}
```

<!-- docs:output group=role producer=basic-role-state -->

**`role` provenance.** This output group is produced by the basic-role-state walkthrough and should be read together with `roles.get`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=userRoles producer=basic-assignment -->

**`userRoles` provenance.** This output group is produced by the basic-assignment walkthrough and should be read together with `assign`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=permissionChecks producer=basic-decision -->

**`permissionChecks` provenance.** This output group is produced by the basic-decision walkthrough and should be read together with `explain`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=reads producer=basic-effective-reads -->

**`reads` provenance.** This output group is produced by the basic-effective-reads walkthrough and should be read together with `getPermissions`. It is a selected, documented example field rather than a new API response shape.


## Production boundary

The example starts an in-memory MongoDB replica set for repeatability. Production applications provide a connected MonSQLize 3.1 instance, trusted tenant/user identity, token secret, and lifecycle ownership.

## Related

See [Quick Start](/guide/quick-start), [Check Permissions](/guide/check-permission), and [User Roles API](/api/user-roles).
