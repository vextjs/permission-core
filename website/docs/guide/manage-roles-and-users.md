# Manage Roles and User Assignments
<!-- docs:inline-parity `pc.init()` `scope` `scoped` `acme` `u-1` `userRoles.assign(userId, roleId)` `userRoles.set(userId, roleIds, options)` `userRoles.getDirect(userId)` `userRoles.getEffective(userId)` `roles.create()` `created.data.id` `created.data.revision` `roles.allow(roleId, rule)` `order-reader` `GET:/api/orders` `assign()` `userId` `roleId` `set()` `assign(userId, roleId)` `set(userId, roleIds, options)` `roleIds` `getDirect(userId)` `set/clear` `set('u-1', ['operator'], ...)` `operator` `REVISION_CONFLICT` `getDirect()` `roles.get()` `data.id/label/status/parentId/revision` `roles.getEffectiveRules()` `data.chain/rules/conflicts` `userRoles.getDirect()` `data.roleIds/revision` `userRoles.getEffective()` `data.direct/effective` `expectedRevision` `previewAccessUpdate()` `previewReplaceRules()` `getRemovalImpact()` `ROLE_NOT_FOUND` `tenantId` `can()` `assert()` `explain()` -->

This page covers the everyday admin workflow: create a role, add one permission, bind the role to a user, and read direct versus effective authorization state.

```ts
const scope = { tenantId: 'acme' };
const scoped = pc.scope(scope);
```
## Remember Four Methods First

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## 1. Create a Role

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const created = await scoped.roles.create({
  id: 'order-reader',
  label: '订单只读',
  description: '可以查看订单列表',
});
```
## 2. Add One Permission to the Role

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const granted = await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'GET:/api/orders',
});
```
## 3. Bind the Role to a User

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const assigned = await scoped.userRoles.assign('u-1', 'order-reader');
console.log(assigned.data.roleIds); // ['order-reader']
```
```ts
const before = await scoped.userRoles.getDirect('u-1');
const saved = await scoped.userRoles.set(
  'u-1',
  ['order-reader', 'report-reader'],
  { expectedRevision: before.data.revision },
);
```
## 4. Read the Final State

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const role = await scoped.roles.get('order-reader');
const effectiveRules = await scoped.roles.getEffectiveRules('order-reader');
const directRoles = await scoped.userRoles.getDirect('u-1');
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
```
## Common Questions

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

### What is the difference between assign and set?
### Why read direct before set?
### Where do updates and removals live?
## What to Check When It Fails

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

Continue with [Check Permissions](/guide/check-permission).
