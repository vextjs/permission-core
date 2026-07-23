# Check Permissions
<!-- docs:inline-parity `pc.forSubject(input)` `pc.forSubject(input, context)` `userId` `scope` `claims` `subject.can(action, resource)` `pc.can(subject, action, resource, context?)` `Promise<boolean>` `subject.cannot(...)` `can` `!can(...)` `subject.assert(...)` `Promise<void>` `cannot` `assert` `PERMISSION_DENIED` `api:GET:/orders/:id` `explain()` `SubjectRuntimeResult<PermissionExplanation>` `data` `detailBudget` `can()` `action` `invoke` `resource` `context` `valueFrom` `can/assert` `allow` `explicit-deny` `no-allow` `policy-unknown` `role-disabled` `context-missing` `roles.get(roleId)` `VersionedResult<Role>` `roles.getOwnRules(roleId)` `VersionedResult<PermissionRuleView[]>` `roles.getEffectiveRules(roleId)` `roles.getChain(roleId)` `getOwnRules` `getEffectiveRules` `getChain` `assign()` `set()` `getDirect/getEffective` `userRoles.assign(userId, roleId, options?)` `UserRoleBindingSet` `userRoles.getDirect(userId)` `set` `userRoles.set(userId, roleIds, options)` `expectedRevision` `userRoles.getEffective(userId)` `assign` `permissions/invokeResources` `subject.getPermissions()` `subject.getResources(action?)` `conditional=true` `getPermissions()` `getResources(action?)` -->

This page answers one practical question: **which method should application code call to check permissions?**

For normal requests, bind the current user with `pc.forSubject(input)`, then call `can()`, `cannot()`, or `assert()` for the operation being performed. If conditional rules need policy context, bind it with `pc.forSubject(input, context)` or call the core-level `pc.can(subject, action, resource, context)` helper; do not pass context to the subject facade. The role, rule, and snapshot reads later in this page are for admin screens and diagnostics; they are not required on every business request.

| Goal | Method | Return |
|---|---|---|
| Need a boolean for UI or business branching | `subject.can(action, resource)` | `Promise<boolean>` |
| Want to write the inverse condition naturally | `subject.cannot(...)` | `Promise<boolean>`, equivalent to `!can(...)` |
| Backend API must stop when unauthorized | `subject.assert(...)` | no value when allowed; throws `PERMISSION_DENIED` when denied |
| Need to understand why access was denied | `subject.explain(...)` | diagnostic result with reason and bounded match details |

## Boolean Checks and Enforcement

Use `can()` when the caller needs a boolean, `cannot()` when you want the inverse, and `assert()` when a blocked request should throw `PERMISSION_DENIED`. All three read the current subject scope and never create permissions.

```ts
const subject = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme' },
});

const allowed = await subject.can('invoke', 'api:GET:/api/orders');
const blocked = await subject.cannot('invoke', 'api:DELETE:/api/orders');
await subject.assert('invoke', 'api:GET:/api/orders');
```
```json
{ "allowed": true, "blocked": true, "assertResult": "void" }
```

The JSON above is a tutorial summary of three separate calls, not the raw response of a single method.

If a rule uses `valueFrom: 'context.xxx'`, do not pass `context` to `subject.can()`. Bind it when creating the subject:

```ts
const subject = pc.forSubject(
  { userId: 'u-1', scope: { tenantId: 'acme' } },
  { orderAmount: 1200 },
);
```

You can also call the core-level helper directly: `pc.can(subjectInput, action, resource, context)`. The subject facade signatures remain `subject.can(action, resource)` and `subject.assert(action, resource)`, and `explain` uses the same bound subject context.

## Explain One Decision

Use `explain()` when a decision is surprising. It returns the same allow/deny result plus the reason and bounded evaluation details, so diagnostics do not need to guess why a rule matched or missed.

```ts
const explanation = await subject.explain(
  'invoke',
  'api:DELETE:/api/orders',
);
```
```json
{
  "data": {
    "allowed": false,
    "action": "invoke",
    "resource": "api:DELETE:/api/orders",
    "reason": "no-allow",
    "evaluations": [
      { "action": "invoke", "allowed": false, "reason": "no-allow" }
    ]
  },
  "detailBudget": { "limit": 100, "returned": 0, "truncated": false, "digest": "..." }
}
```
## Diagnostics: Read Roles and Rules

Use role reads for admin and support screens. `getOwnRules()` shows rules written directly on the role; `getEffectiveRules()` includes inherited rules; `getChain()` explains which parent roles contributed.

```ts
const scoped = pc.scope({ tenantId: 'acme' });
const role = await scoped.roles.get('order-reader');
const own = await scoped.roles.getOwnRules('order-reader');
const effective = await scoped.roles.getEffectiveRules('order-reader');
const chain = await scoped.roles.getChain('order-reader');
```
```json
{
  "role": { "id": "order-reader", "parentId": null, "revision": 2 },
  "ownRules": [
    { "effect": "allow", "action": "invoke", "resource": "api:GET:/api/orders" }
  ],
  "effectiveRuleCount": 1,
  "chain": [{ "role": { "id": "order-reader" }, "depth": 0, "included": true }]
}
```
## Diagnostics: Read and Replace User Roles

Use `assign()` for an additive grant and `set()` for saving the complete direct-role set from an admin form. Read `getDirect()` first and pass `expectedRevision` so stale edits are rejected.

```ts
await scoped.userRoles.assign('u-1', 'order-reader');
await scoped.userRoles.assign('u-1', 'operator');

const direct = await scoped.userRoles.getDirect('u-1');
const saved = await scoped.userRoles.set('u-1', ['order-reader'], {
  expectedRevision: direct.data.revision,
});
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
```
```json
{
  "beforeSet": ["operator", "order-reader"],
  "afterSet": ["order-reader"],
  "effective": ["order-reader"]
}
```
## Diagnostics: Read a User Permission Snapshot

Use these snapshot reads when you need to display the subject's resolved permissions or debug a route guard. Results may be bounded by `detailBudget`, so callers should treat them as diagnostics rather than a replacement for `can()` or `assert()`.

```ts
const permissions = await subject.getPermissions();
const invokeResources = await subject.getResources('invoke');
```
```json
{
  "permissions": {
    "data": {
      "subject": { "userId": "u-1", "scope": { "tenantId": "acme" } },
      "directRoleIds": ["order-reader"],
      "roles": {
        "total": 1,
        "items": [{
          "role": { "id": "order-reader", "status": "enabled", "parentId": null },
          "direct": true,
          "viaRoleIds": ["order-reader"],
          "depth": 0,
          "included": true
        }],
        "truncated": false,
        "digest": "..."
      },
      "rules": {
        "total": 1,
        "items": [{
          "effect": "allow",
          "action": "invoke",
          "resource": "api:GET:/api/orders",
          "sourceRoleId": "order-reader",
          "inherited": false,
          "depth": 0
        }],
        "truncated": false,
        "digest": "..."
      },
      "conflicts": { "total": 0, "items": [], "truncated": false, "digest": "..." }
    },
    "detailBudget": { "limit": 100, "returned": 2, "truncated": false, "digest": "..." }
  },
  "invokeResources": {
    "data": [{
      "action": "invoke",
      "resource": "api:GET:/api/orders",
      "conditional": false,
      "sourceRoleIds": {
        "total": 1,
        "items": ["order-reader"],
        "truncated": false,
        "digest": "..."
      }
    }],
    "detailBudget": { "limit": 100, "returned": 1, "truncated": false, "digest": "..." }
  }
}
```
Continue with [Data Permissions](/guide/data-permissions).
