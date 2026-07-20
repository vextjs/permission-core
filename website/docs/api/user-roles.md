# User Roles
<!-- docs:inline-parity `scoped.userRoles` `MutationOptions` `RequiredRevisionOptions` `MutationResult` `VersionedResult` `PageResult` `userId` `string` `roleId` `roleIds` `readonly string[]` `options.expectedRevision` `number` `getDirect().data.revision` `query.first` `listUsersByRole` `query.after` `pageInfo.endCursor` `UserRoleBindingSet` `revision` `persisted` `createdAt/updatedAt` `assign(userId, roleId, options?)` `options` `MutationResult<UserRoleBindingSet>` `data.roleIds` `changed` `set` `revoke(userId, roleId, options?)` `clear` `set(userId, roleIds, options)` `getDirect(userId)` `before.data.revision` `expectedRevision` `ROLE_NOT_FOUND` `REVISION_CONFLICT` `clear(userId, options)` `data.roleIds=[]` `set(userId, [], options)` `VersionedResult<UserRoleBindingSet>` `data.revision` `getEffective` `getEffective(userId)` `VersionedResult<UserEffectiveRoles>` `data.direct` `data.effective.items` `direct/viaRoleIds/depth/included/excludedReason` `subject.getPermissions()` `listUsersByRole(roleId, query?)` `query.first/after` `PageResult<UserRoleBindingSet>` `items` `pageInfo` `assign` `getDirect` `revoke` `data` `128` `1024` `20000` `50000` `8 MiB` `set()` `replaced.data.roleIds` `operator` -->

`scoped.userRoles` stores direct role assignments for host user IDs. It distinguishes incremental assignment from full replacement and can read direct or effective role sets.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want To Do

| Goal | Entry point |
|---|---|
| Incrementally add or remove one role | [`assign()`](#user-roles-assign), [`revoke()`](#user-roles-revoke) |
| Save a complete role checkbox state | [`getDirect()`](#user-roles-get-direct) then [`set()`](#user-roles-set) |
| Clear all direct roles for a user | [`clear()`](#user-roles-clear) |
| Read direct roles and inherited effective roles | [`getDirect()`](#user-roles-get-direct), [`getEffective()`](#user-roles-get-effective) |
| List users assigned to a role | [`listUsersByRole()`](#user-roles-list-users-by-role) |

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
assign(userId: string, roleId: string, options?: MutationOptions): Promise<MutationResult<UserRoleBindingSet>>
revoke(userId: string, roleId: string, options?: MutationOptions): Promise<MutationResult<UserRoleBindingSet>>
set(userId: string, roleIds: readonly string[], options: RequiredRevisionOptions): Promise<MutationResult<UserRoleBindingSet>>
clear(userId: string, options: RequiredRevisionOptions): Promise<MutationResult<UserRoleBindingSet>>
getDirect(userId: string): Promise<VersionedResult<UserRoleBindingSet>>
getEffective(userId: string): Promise<VersionedResult<UserEffectiveRoles>>
listUsersByRole(roleId: string, query?: CursorQuery): Promise<PageResult<UserRoleBindingSet>>
```
## Parameters and Returned Fields

Use this section to distinguish host-owned user IDs from permission-core role bindings, direct values, effective values, revisions, and cursor fields.

<!-- docs:params owner=UserRoleManager locale=en -->
## Method Details

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

<span id="user-roles-assign"></span>
### `assign(userId, roleId, options?)`
<!-- docs:method name=userRoles.assign locale=en -->

- **Purpose**: Use `userRoles.assign` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="user-roles-revoke"></span>
### `revoke(userId, roleId, options?)`
<!-- docs:method name=userRoles.revoke locale=en -->

- **Purpose**: Use `userRoles.revoke` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="user-roles-set"></span>
### `set(userId, roleIds, options)`
<!-- docs:method name=userRoles.set locale=en -->

- **Purpose**: Use `userRoles.set` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="user-roles-clear"></span>
### `clear(userId, options)`
<!-- docs:method name=userRoles.clear locale=en -->

- **Purpose**: Use `userRoles.clear` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="user-roles-get-direct"></span>
### `getDirect(userId)`
<!-- docs:method name=userRoles.getDirect locale=en -->

- **Purpose**: Use `userRoles.getDirect` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="user-roles-get-effective"></span>
### `getEffective(userId)`
<!-- docs:method name=userRoles.getEffective locale=en -->

- **Purpose**: Use `userRoles.getEffective` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="user-roles-list-users-by-role"></span>
### `listUsersByRole(roleId, query?)`
<!-- docs:method name=userRoles.listUsersByRole locale=en -->

- **Purpose**: Use `userRoles.listUsersByRole` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `PageResult<T>` or the documented paged business result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="user-roles-assign-vs-set"></span>
## How to Choose `assign` and `set`

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "data": {
    "userId": "u-1",
    "roleIds": ["order-reader", "operator"],
    "revision": 2,
    "persisted": true
  },
  "revision": 2,
  "operationId": "operation_...",
  "auditId": "audit_..."
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
await scoped.userRoles.assign('u-1', 'order-reader');
const before = await scoped.userRoles.getDirect('u-1');
const replaced = await scoped.userRoles.set('u-1', ['operator'], {
  expectedRevision: before.data.revision,
});
```
```json
{
  "before": ["order-reader"],
  "after": ["operator"]
}
```
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Menus](/api/menus).
