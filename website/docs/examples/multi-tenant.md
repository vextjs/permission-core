# Multi-Tenant
<!-- docs:inline-parity `userId` `roleId` `examples/multi-tenant.mjs` `docs:multi-tenant:start` `docs:multi-tenant:end` `ok: true` `tenantA.ownResource` `tenantB.ownResource` `true` `crossTenantResource` `false` `manager` `scope` `core.scope(scopeA)` `{ tenantId: 'tenant-a', appId: 'admin' }` `roles.create` `roles.allow` `userRoles.assign` `same-user` `tenantA` `core.scope(scopeB)` `{ tenantId: 'tenant-b', appId: 'admin' }` `tenantB.directRoles` `appId` `tenantId` `forSubject` `userRoles.getDirect` `can` `identity` `forSubject({ userId, scope })` `userRoles.getDirect(userId)` `VersionedResult<UserRoleBindingSet>` `data.roleIds` `subject.can(action, resource)` `printExample()` `getDirect` `directRoles` `tenantB` `scopeFields` -->

## Scenario

This example creates the same `userId` and `roleId` in two scopes. Each subject can read only the resource granted inside its own complete tenant/application scope, proving that IDs are not global authorization identities.

## Run

```bash
npm run example:multi-tenant
```

The canonical source is the `docs:multi-tenant:start` to `docs:multi-tenant:end` block in `examples/multi-tenant.mjs`.

## First Check the Result

A successful run confirms `ok: true`, both own-resource checks are `true`, and both `crossTenantResource` checks are `false`.

## Source walkthrough

```js
const scopeA = { tenantId: 'tenant-a', appId: 'admin' };
const scopeB = { tenantId: 'tenant-b', appId: 'admin' };
const tenantA = core.scope(scopeA);
const tenantB = core.scope(scopeB);

await tenantA.roles.create({ id: 'manager', label: 'Tenant A manager' });
await tenantA.roles.allow('manager', {
  action: 'read', resource: 'ui:page:tenant-a-dashboard',
});
await tenantA.userRoles.assign('same-user', 'manager');

await tenantB.roles.create({ id: 'manager', label: 'Tenant B manager' });
await tenantB.roles.allow('manager', {
  action: 'read', resource: 'ui:page:tenant-b-dashboard',
});
await tenantB.userRoles.assign('same-user', 'manager');

const subjectA = core.forSubject({ userId: 'same-user', scope: scopeA });
const subjectB = core.forSubject({ userId: 'same-user', scope: scopeB });
const rolesA = await tenantA.userRoles.getDirect('same-user');
const rolesB = await tenantB.userRoles.getDirect('same-user');
const aOwn = await subjectA.can('read', 'ui:page:tenant-a-dashboard');
const aCross = await subjectA.can('read', 'ui:page:tenant-b-dashboard');
const bOwn = await subjectB.can('read', 'ui:page:tenant-b-dashboard');
const bCross = await subjectB.can('read', 'ui:page:tenant-a-dashboard');
```

Each scope owns its own `manager` definition and binding set. A cross-tenant check reads the current subject scope, so it returns false by default.

### 1. Build tenant A authorization state

<!-- docs:operation id=tenant-state-a calls=scope,roles.create,roles.allow,userRoles.assign outputs=tenantA -->

**Purpose and target.** This operation explains `scope`, `roles.create`, `roles.allow`, `userRoles.assign` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `tenantA`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [core-and-contexts](/api/core-and-contexts), [roles](/api/roles), [user-roles](/api/user-roles) for exact signatures, response wrappers, and public error codes.

### 2. Build tenant B authorization state

<!-- docs:operation id=tenant-state-b calls=scope,roles.create,roles.allow,userRoles.assign outputs=tenantB -->

**Purpose and target.** This operation explains `scope`, `roles.create`, `roles.allow`, `userRoles.assign` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `tenantB`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [core-and-contexts](/api/core-and-contexts), [roles](/api/roles), [user-roles](/api/user-roles) for exact signatures, response wrappers, and public error codes.

### 3. Compare own-scope and cross-scope decisions

<!-- docs:operation id=tenant-decisions calls=forSubject,userRoles.getDirect,can outputs=identity,tenantA,tenantB -->

**Purpose and target.** This operation explains `forSubject`, `userRoles.getDirect`, `can` in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.

**State, arguments, and result.** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to `identity`, `tenantA`, `tenantB`.

**Failure and next step.** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.

**API reference.** See [core-and-contexts](/api/core-and-contexts), [user-roles](/api/user-roles) for exact signatures, response wrappers, and public error codes.


## Expected output

The following JSON is the **Example summary output** generated by `printExample()`. It combines selected fields from several API calls and is not the raw response of one method.

```json
{
  "example": "multi-tenant",
  "ok": true,
  "identity": "the same userId and roleId are scoped independently",
  "tenantA": {
    "directRoles": ["manager"],
    "ownResource": true,
    "crossTenantResource": false
  },
  "tenantB": {
    "directRoles": ["manager"],
    "ownResource": true,
    "crossTenantResource": false
  }
}
```

<!-- docs:output group=identity producer=tenant-decisions -->

**`identity` provenance.** This output group is produced by the tenant-decisions walkthrough and should be read together with `can`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=tenantA producer=tenant-state-a -->

**`tenantA` provenance.** This output group is produced by the tenant-state-a walkthrough and should be read together with `getDirect`. It is a selected, documented example field rather than a new API response shape.

<!-- docs:output group=tenantB producer=tenant-state-b -->

**`tenantB` provenance.** This output group is produced by the tenant-state-b walkthrough and should be read together with `can`. It is a selected, documented example field rather than a new API response shape.


## Production boundary

Fixture scopes are fixed test data. Production scopes must come from authenticated server state or a trusted resolver, and business collections must map every active scope dimension through `scopeFields`.

## Related

See [Multi-Tenant Model](/guide/multi-tenant), [Authentication Boundary](/guide/authentication-boundary), and [Authorized Collection API](/api/authorized-collection).
