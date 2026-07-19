# User Roles

## Purpose and preconditions

`scoped.userRoles` manages the direct role set for a user in one complete scope. It does not create users or authenticate them. Every referenced role must already exist in the same scope.

## Signatures

```ts
assign(userId: string, roleId: string, options?: MutationOptions): Promise<MutationResult<UserRoleBindingSet>>
revoke(userId: string, roleId: string, options?: MutationOptions): Promise<MutationResult<UserRoleBindingSet>>
set(userId: string, roleIds: readonly string[], options: RequiredRevisionOptions): Promise<MutationResult<UserRoleBindingSet>>
clear(userId: string, options: RequiredRevisionOptions): Promise<MutationResult<UserRoleBindingSet>>
getDirect(userId: string): Promise<VersionedResult<UserRoleBindingSet>>
getEffective(userId: string): Promise<VersionedResult<UserEffectiveRoles>>
listUsersByRole(roleId: string, query?: CursorQuery): Promise<PageResult<UserRoleBindingSet>>
```

`assign` is additive and idempotent for one role. `set` replaces the complete direct role set and therefore requires the current user-role-set revision. `revoke` removes one role; `clear` replaces the set with none.

## Responses and side effects

Mutations return the complete persisted direct set in `data`, advance RBAC/user revisions when changed, write audit evidence, and invalidate the affected subject. Reads separate direct bindings from inherited effective roles.

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

Missing roles return `ROLE_NOT_FOUND`; stale replacement revisions return `REVISION_CONFLICT`. A user may have at most `128` direct roles. Effective expansion is bounded to `1024` roles, `20000` semantic rules, `50000` sources, and an `8 MiB` snapshot. Empty/non-persisted users are represented explicitly rather than treated as missing user entities.

## Example

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

`set` does not add `operator` alongside the old role; it replaces the direct set.

## Related

See [Check Permissions](/guide/check-permission), [Role Inheritance](/guide/role-inheritance), and [Roles](/api/roles).
