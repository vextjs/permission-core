# UserRoleManager

`UserRoleManager` manages user-role bindings.

## Replace all roles

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
```

Use this for management forms that submit the complete selected role list.

## Add and remove one role

```typescript
await pc.users.grant('u-1', 'support');
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

After changing user-role bindings, invalidate that user's cache:

```typescript
await pc.invalidate('u-1');
```
