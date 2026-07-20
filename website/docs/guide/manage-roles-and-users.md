# Manage Roles and User Assignments
<!-- docs:inline-parity `pc.init()` `scope` `scoped` `acme` `u-1` `userRoles.assign(userId, roleId)` `userRoles.set(userId, roleIds, options)` `userRoles.getDirect(userId)` `userRoles.getEffective(userId)` `roles.create()` `created.data.id` `created.data.revision` `roles.allow(roleId, rule)` `order-reader` `api:GET:/api/orders` `assign()` `userId` `roleId` `set()` `assign(userId, roleId)` `set(userId, roleIds, options)` `roleIds` `getDirect(userId)` `set/clear` `set('u-1', ['operator'], ...)` `operator` `REVISION_CONFLICT` `getDirect()` `roles.get()` `data.id/label/status/parentId/revision` `roles.getEffectiveRules()` `data.chain/rules/conflicts` `userRoles.getDirect()` `data.roleIds/revision` `userRoles.getEffective()` `data.direct/effective` `expectedRevision` `previewAccessUpdate()` `previewReplaceRules()` `getRemovalImpact()` `ROLE_NOT_FOUND` `tenantId` `can()` `assert()` `explain()` -->

This page covers the everyday admin workflow: create a role, add one permission, bind the role to a user, and read direct versus effective authorization state.

```ts
const scope = { tenantId: 'acme' };
const scoped = pc.scope(scope);
```
## Remember Four Methods First

`scoped` manages only data inside the `acme` tenant. permission-core does not create users; `u-1` is a stable ID from the host user system.

## 1. Create a Role

`roles.create()` creates a role in the current scope. The commonly used return fields are `created.data.id` and `created.data.revision`; the full envelope is described in the core response contract.

```ts
const created = await scoped.roles.create({
  id: 'order-reader',
  label: '订单只读',
  description: '可以查看订单列表',
});
```
## 2. Add One Permission to the Role

`roles.allow(roleId, rule)` writes one allow rule to the role. The `action` describes what the subject wants to do, and the `resource` names the thing being protected.

```ts
const granted = await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/api/orders',
});
```
`roles.allow(roleId, rule)` means "this role may perform this action on this resource." In this example, `order-reader` can invoke `api:GET:/api/orders`. Missing allow rules are denied by default, so most APIs do not need explicit deny rules for every blocked operation.
## 3. Bind the Role to a User

Use `assign()` when adding one role. Use `set()` when saving the complete result of a role multi-select field.

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

Use direct/own reads for editing screens and effective reads for diagnostics. Do not save effective results back as direct bindings.

```ts
const role = await scoped.roles.get('order-reader');
const effectiveRules = await scoped.roles.getEffectiveRules('order-reader');
const directRoles = await scoped.userRoles.getDirect('u-1');
const effectiveRoles = await scoped.userRoles.getEffective('u-1');
```
## Common Questions

`assign()` appends one role. `set()` replaces the complete direct-role set. A multi-select form should use `set()`, while a single "grant role" action should use `assign()`.

### What is the difference between assign and set?
### Why read direct before set?
### Where do updates and removals live?
## What to Check When It Fails

When a call fails, first check scope and revision. `ROLE_NOT_FOUND` usually means the role ID is not in the current `tenantId`; `REVISION_CONFLICT` means the edit form used stale data.

Continue with [Check Permissions](/guide/check-permission).
