# Basic RBAC

## Scenario

This is the first complete RBAC path: create roles and a rule, assign a user, check allow/default-deny behavior, compare additive `assign` with replacement `set`, and read own/effective authorization state.

## Run

```bash
npm run example:basic
```

The canonical source is `examples/basic.mjs`, between `docs:basic:start` and `docs:basic:end`. It uses the shared host fixture in `examples/_support/host.mjs`.

## Source walkthrough

```js
await scoped.userRoles.assign('u-1', 'order-reader');
const subject = core.forSubject({ userId: 'u-1', scope });
const allowed = await subject.can('invoke', 'GET:/api/orders');
const cannotDelete = await subject.cannot('invoke', 'DELETE:/api/orders');

const before = await scoped.userRoles.getDirect('u-1');
await scoped.userRoles.set('u-1', ['order-reader'], {
  expectedRevision: before.data.revision,
});
```

`cannotDelete: true` means the corresponding `can()` result is false because no delete allow exists. It does not mean a delete permission was granted or that a separate deny was assigned.

## Expected output

```json
{
  "example": "basic",
  "ok": true,
  "userRoles": {
    "afterAssign": ["order-reader"],
    "beforeSet": ["operator", "order-reader"],
    "afterSet": ["order-reader"],
    "effective": ["order-reader"]
  },
  "permissionChecks": {
    "allowed": true,
    "cannotDelete": true,
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

## Production boundary

The example starts an in-memory MongoDB replica set only for repeatability. In production, the host supplies its connected MonSQLize 3.1 instance, trusted tenant/user identity, token secret, and process lifecycle. The example closes PermissionCore before closing the host database.

## Related

See [Quick Start](/guide/quick-start), [Check Permissions](/guide/check-permission), and [User Roles](/api/user-roles).
