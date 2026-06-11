# PermissionCoreContext

`PermissionCoreContext` binds a `userId` once and then exposes user-scoped runtime methods.

## Create a context

```typescript
const ctx = pc.for('u-1');
```

## Common methods

```typescript
await ctx.can('invoke', 'GET:/api/orders');
await ctx.assert('invoke', 'POST:/api/refunds');
await ctx.getResources('invoke');
await ctx.getRowScope('read', 'db:transactions', { merchantId: 'm-100' });
await ctx.filterFields('read', 'db:transactions', transaction);
```

## Why use it

Use `pc.for(userId)` when a request handler or service method performs multiple checks for the same user. It keeps call sites smaller without changing runtime semantics.

## Important boundary

The bound `userId` remains the current subject. Context variables passed to row or field APIs are rule variables only and do not replace the bound user.
