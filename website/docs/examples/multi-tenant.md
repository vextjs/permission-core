# Multi-Tenant

## Scenario

The same `userId` and `roleId` are created in two scopes. Each subject can read only the resource granted inside its own complete tenant/application scope, proving that IDs are not global authorization identities.

## Run

```bash
npm run example:multi-tenant
```

The canonical source is `examples/multi-tenant.mjs`, between `docs:multi-tenant:start` and `docs:multi-tenant:end`.

## Source walkthrough

```js
const scopeA = { tenantId: 'tenant-a', appId: 'admin' };
const scopeB = { tenantId: 'tenant-b', appId: 'admin' };
await core.scope(scopeA).userRoles.assign('same-user', 'manager');
await core.scope(scopeB).userRoles.assign('same-user', 'manager');

const subjectA = core.forSubject({ userId: 'same-user', scope: scopeA });
const cross = await subjectA.can('read', 'ui:page:tenant-b-dashboard');
```

Each scope has its own `manager` definition and binding set. The cross check uses tenant A authorization state and therefore returns false.

### 1. Build tenant A authorization state

<!-- docs:operation id=tenant-state-a calls=scope,roles.create,roles.allow,userRoles.assign outputs=tenantA -->

**Purpose and target.** `scope` (via `core.scope(scopeA)`) creates a management context for `{ tenantId: 'tenant-a', appId: 'admin' }`. Inside it, `roles.create` creates `manager`, `roles.allow` grants only tenant A's dashboard, and `userRoles.assign` binds `same-user`.

**State, arguments, and result.** The visible IDs are intentionally reusable; the normalized scope key is part of every role, rule, and user-role lookup. The resulting `tenantA` output therefore contains tenant A's direct role plus decisions made only from tenant A state.

**Failure and next step.** An incomplete/invalid scope, duplicate role in the same scope, unknown role, or failed mutation rejects that step. Correct the scoped record and retry there; never fall back to an unscoped lookup or borrow tenant B state.

**API reference.** See [Core and Contexts](/api/core-and-contexts), [Roles](/api/roles), and [User Roles](/api/user-roles).

### 2. Build tenant B authorization state

<!-- docs:operation id=tenant-state-b calls=scope,roles.create,roles.allow,userRoles.assign outputs=tenantB -->

**Purpose and target.** `scope` (via `core.scope(scopeB)`) selects `{ tenantId: 'tenant-b', appId: 'admin' }`; `roles.create`, `roles.allow`, and `userRoles.assign` repeat the same role/user IDs but grant tenant B's dashboard instead.

**State, arguments, and result.** Tenant B receives independent role, rule, revision, and assignment records. `tenantB.directRoles` can therefore also contain `manager` without sharing the role object or its allowed resource with tenant A.

**Failure and next step.** Handle failures within the full tenant B scope and verify all dimensions, including `appId`. Reusing only `tenantId` while dropping another active dimension would address a different scope and must fail rather than silently broaden access.

**API reference.** See [Core and Contexts](/api/core-and-contexts), [Roles](/api/roles), and [User Roles](/api/user-roles).

### 3. Compare own-scope and cross-scope decisions

<!-- docs:operation id=tenant-decisions calls=forSubject,userRoles.getDirect,can outputs=identity,tenantA,tenantB -->

**Purpose and target.** Two `forSubject` calls create request contexts for the same `userId` in different complete scopes. `userRoles.getDirect` reads each binding set, then `can` checks each subject's own dashboard and the other tenant's dashboard.

**State, arguments, and result.** Each own-resource result is `true`; each cross-resource result is `false` because that resource has no allow in the subject's scope. The `identity` string summarizes the invariant demonstrated by all four decisions.

**Failure and next step.** Scope must come from authenticated server state or a trusted resolver. If trusted sources disagree, reject the request as a scope conflict; do not choose a scope from an arbitrary header and do not retry in another tenant.

**API reference.** See [Core and Contexts](/api/core-and-contexts) for subject decisions and [User Roles](/api/user-roles) for scoped direct-role reads.

## Expected output

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

**`identity` provenance.** This summary is emitted after both `userRoles.getDirect` reads and all four `can` decisions; it is the interpretation of the evidence below, not a database field.

<!-- docs:output group=tenantA producer=tenant-state-a -->

**`tenantA` provenance.** `getDirect` supplies `directRoles`; tenant A's subject supplies its own and cross-tenant `can` results. The false cross result demonstrates default deny inside tenant A's authorization state.

<!-- docs:output group=tenantB producer=tenant-state-b -->

**`tenantB` provenance.** `userRoles.getDirect` and `can` run against tenant B's independent scope. Matching IDs alongside different resource decisions are the expected proof of isolation.

## Production boundary

The fixture scopes are fixed test data. Production scope must come from authenticated server state or a trusted resolver, never directly from a request header/body. Business collections must also map every active scope dimension through `scopeFields`.

## Related

See [Multi-Tenant Model](/guide/multi-tenant), [Authentication Boundary](/guide/authentication-boundary), and [Authorized Collection](/api/authorized-collection).
