# UserRoleManager

`UserRoleManager` manages user-role bindings.

It manages which roles a single user has. It does not manage the rules inside those roles.

## Replace all roles

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
```

Use this for management forms that submit the complete selected role list.

## Add and remove one role

```typescript
await pc.users.assign('u-1', 'support');
await pc.users.revoke('u-1', 'support');
```

## Read bindings

```typescript
const roles = await pc.users.getUserRoles('u-1');
```

## Clear bindings

```typescript
await pc.users.clearUserRoles('u-1');
```

## Cache note

`assign()`, `revoke()`, `setUserRoles()`, and `clearUserRoles()` invalidate that user's permission cache automatically.

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
```

Only call `pc.invalidate('u-1')` yourself when user-role bindings are changed outside `UserRoleManager`, such as through a direct storage write or an external synchronization job.

`setUserRoles()` is different from a role-rule batch API. It overwrites the roles for one user and only affects that user's cache. Changing the rules inside a role can affect many users and inherited roles, so role-rule writes stay on `RoleManager`.
