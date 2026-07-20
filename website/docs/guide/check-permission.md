# Check Permissions
<!-- docs:inline-parity `pc.forSubject(input)` `userId` `scope` `claims` `subject.can(action, resource, context?)` `Promise<boolean>` `subject.cannot(...)` `can` `!can(...)` `subject.assert(...)` `Promise<void>` `cannot` `assert` `PERMISSION_DENIED` `GET:/orders/:id` `explain()` `SubjectRuntimeResult<PermissionExplanation>` `data` `detailBudget` `can()` `action` `invoke` `resource` `context?` `valueFrom` `can/assert` `allow` `explicit-deny` `no-allow` `policy-unknown` `role-disabled` `context-missing` `roles.get(roleId)` `VersionedResult<Role>` `roles.getOwnRules(roleId)` `VersionedResult<PermissionRuleView[]>` `roles.getEffectiveRules(roleId)` `roles.getChain(roleId)` `getOwnRules` `getEffectiveRules` `getChain` `assign()` `set()` `getDirect/getEffective` `userRoles.assign(userId, roleId, options?)` `UserRoleBindingSet` `userRoles.getDirect(userId)` `set` `userRoles.set(userId, roleIds, options)` `expectedRevision` `userRoles.getEffective(userId)` `assign` `permissions/invokeResources` `subject.getPermissions(options?)` `subject.getResources(action?, options?)` `conditional=true` `getPermissions()` `getResources(action?)` -->

Use a subject context for request-time decisions and a scoped context for management reads. Both facades read the same tenant-scoped authorization state.

## Boolean Checks and Enforcement

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const subject = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme' },
});

const allowed = await subject.can('invoke', 'GET:/api/orders');
const blocked = await subject.cannot('invoke', 'DELETE:/api/orders');
await subject.assert('invoke', 'GET:/api/orders');
```
```json
{ "allowed": true, "blocked": true, "assertResult": "void" }
```
## Explain One Decision

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const explanation = await subject.explain(
  'invoke',
  'DELETE:/api/orders',
);
```
```json
{
  "data": {
    "allowed": false,
    "action": "invoke",
    "resource": "DELETE:/api/orders",
    "reason": "no-allow",
    "evaluations": [
      { "action": "invoke", "allowed": false, "reason": "no-allow" }
    ]
  },
  "detailBudget": { "limit": 100, "returned": 0, "truncated": false, "digest": "..." }
}
```
## Read Roles and Rules

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
    { "effect": "allow", "action": "invoke", "resource": "GET:/api/orders" }
  ],
  "effectiveRuleCount": 1,
  "chain": [{ "role": { "id": "order-reader" }, "depth": 0, "included": true }]
}
```
## Read and Replace User Roles

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
## Read a User Permission Snapshot

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
          "resource": "GET:/api/orders",
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
      "resource": "GET:/api/orders",
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
