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

### 1. Create the role state

<!-- docs:operation id=basic-role-state calls=roles.create,roles.allow outputs=role,reads.ownRules -->

**Purpose and target.** `roles.create` creates `order-reader` inside the current `acme` scope, and `roles.allow` attaches the one rule that may invoke `GET:/api/orders` to that role.

**State, arguments, and result.** The role input supplies the durable ID and label; the rule input supplies an `action` and typed `resource`. These are two committed mutations. The example later reads the saved role and its own rules into `role` and `reads.ownRules`, so the output describes database state rather than the arguments echoed from memory.

**Failure and next step.** A duplicate role, unknown role, invalid rule, or unavailable database rejects the affected call. Because creation and rule assignment are separate mutations, inspect the error before retrying the failed step; do not assume the pair is one transaction.

**API reference.** See [Roles](/api/roles) for mutation envelopes, role reads, rule inputs, and errors.

### 2. Add a role, then replace the direct-role set

<!-- docs:operation id=basic-assignment calls=userRoles.assign,userRoles.getDirect,userRoles.set outputs=userRoles.afterAssign,userRoles.beforeSet,userRoles.afterSet -->

**Purpose and target.** `userRoles.assign` adds one direct role to `u-1`; `userRoles.set` replaces that user's complete direct-role set. They are deliberately shown together because additive and replacement operations must not be treated as synonyms.

**State, arguments, and result.** `userRoles.getDirect` returns the current role IDs plus their revision. The canonical source adds `operator` before this read, which is why `beforeSet` contains two roles. `userRoles.set(..., { expectedRevision })` then commits only `order-reader`, producing `afterSet` with one role while inherited roles remain a separate concept.

**Failure and next step.** A stale `expectedRevision` rejects the replacement instead of overwriting a concurrent administrator change. Re-read with `getDirect`, decide whether the new role set is still correct, and retry with the new revision.

**API reference.** See [User Roles](/api/user-roles) for additive assignment, replacement semantics, direct/effective reads, and revision errors.

### 3. Evaluate the concrete operation

<!-- docs:operation id=basic-decision calls=forSubject,can,cannot,explain outputs=permissionChecks -->

**Purpose and target.** `forSubject` binds trusted user and scope identity to a request-time context. `can` checks the allowed GET operation, `cannot` checks the ungranted DELETE operation, and `explain` records why DELETE is blocked.

**State, arguments, and result.** `can` returns `true` only when the effective rules allow that exact action/resource pair. `cannot` is the boolean inverse of the same decision, not a permission assignment. With no matching delete allow, the explanation reason is `no-allow`, which is default deny rather than an explicit deny rule.

**Failure and next step.** Missing trusted scope, unavailable authorization state, or invalid policy context fails closed. Use `explain` for diagnostics, then correct the subject/rules; keep `can` or `assert` as the enforcement call for the real operation.

**API reference.** See [Core and Contexts](/api/core-and-contexts) for subject factories, decisions, explanations, and fail-closed errors.

### 4. Read effective authorization state

<!-- docs:operation id=basic-effective-reads calls=roles.get,roles.getOwnRules,roles.getEffectiveRules,roles.getChain,userRoles.getEffective,getPermissions,getResources outputs=role,userRoles.effective,reads -->

**Purpose and target.** `roles.get`, `roles.getOwnRules`, `roles.getEffectiveRules`, and `roles.getChain` inspect the role; `userRoles.getEffective`, `getPermissions`, and `getResources` inspect the user's effective authorization state.

**State, arguments, and result.** `roles.getOwnRules` excludes inherited sources; `roles.getEffectiveRules` resolves inherited and generated sources; `roles.getChain` explains the parent chain. `userRoles.getEffective` resolves direct roles into effective roles, while `getPermissions` and `getResources('invoke')` provide bounded diagnostic snapshots for the subject.

**Failure and next step.** These reads can reveal missing, disabled, conflicted, or truncated state, but they are not authorization substitutes. Inspect their metadata for diagnosis and still call `can` or `assert` immediately before the protected operation.

**API reference.** See [Roles](/api/roles), [User Roles](/api/user-roles), and [Core and Contexts](/api/core-and-contexts).

## Expected output

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

**`role` provenance.** `roles.get` reads `order-reader`, whose state was created by `roles.create` and advanced by `roles.allow`; revision `2` proves the rule mutation changed the durable role state.

<!-- docs:output group=userRoles producer=basic-assignment -->

**`userRoles` provenance.** The three arrays come from the `assign`, pre-`set` `getDirect`, and successful `set` responses. `effective` comes from `getEffective`, and `semantics` states how to interpret the two write methods.

<!-- docs:output group=permissionChecks producer=basic-decision -->

**`permissionChecks` provenance.** `allowed` and `cannotDelete` are the two boolean decisions; `deleteReason` comes from `explain`. Read all four fields together so `cannotDelete: true` is not mistaken for a granted delete permission.

<!-- docs:output group=reads producer=basic-effective-reads -->

**`reads` provenance.** `roles.getOwnRules`, `roles.getEffectiveRules`, `roles.getChain`, `getPermissions`, and `getResources` produce this diagnostic group; none of these fields replaces a concrete authorization check.

## Production boundary

The example starts an in-memory MongoDB replica set only for repeatability. In production, the host supplies its connected MonSQLize 3.1 instance, trusted tenant/user identity, token secret, and process lifecycle. The example closes PermissionCore before closing the host database.

## Related

See [Quick Start](/guide/quick-start), [Check Permissions](/guide/check-permission), and [User Roles](/api/user-roles).
