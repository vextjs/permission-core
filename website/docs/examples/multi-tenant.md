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

## Expected output

```json
{
  "example": "multi-tenant",
  "ok": true,
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

## Production boundary

The fixture scopes are fixed test data. Production scope must come from authenticated server state or a trusted resolver, never directly from a request header/body. Business collections must also map every active scope dimension through `scopeFields`.

## Related

See [Multi-Tenant Model](/guide/multi-tenant), [Authentication Boundary](/guide/authentication-boundary), and [Authorized Collection](/api/authorized-collection).
