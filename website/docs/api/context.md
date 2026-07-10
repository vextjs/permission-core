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

| Method | Result | Meaning |
|---|---|---|
| `can(action, resource, context?)` | `Promise<boolean>` | Boolean permission decision |
| `cannot(...)` | `Promise<boolean>` | Negated decision |
| `assert(...)` | `Promise<void>` | Throws `PERMISSION_DENIED` when denied |
| `getRowScope(action, resource, context?)` | `Promise<RowScope>` | Effective row condition or unrestricted/denied state |
| `canRow(action, resource, row, context?)` | `Promise<boolean>` | Evaluate one object against the row scope |
| `filterRows(action, resource, rows, context?)` | `Promise<T[]>` | Retain allowed rows |
| `filterFields(action, resource, data, context?)` | `Promise<Partial<T>>` | Retain allowed top-level fields |
| `getPermissions()` | `Promise<PermissionRule[]>` | Effective merged rules for the bound user |
| `getResources(action?)` | `Promise<string[]>` | Visible allow resources after strict deny filtering |

## Why use it

Use `pc.for(userId)` when a request handler or service method performs multiple checks for the same user. It keeps call sites smaller without changing runtime semantics.

## Important boundary

The bound `userId` remains the current subject. Context variables passed to row or field APIs are rule variables only and do not replace the bound user.

Use `pc.forSubject(subject)` for tenant-aware work. A subject context preserves the exact `tenantId/appId/moduleId/namespace`; it does not fall back to the legacy default scope.

## Typical service flow

```typescript
const ctx = pc.forSubject({ tenantId: 'tenant-a', userId: 'u-1' });

await ctx.assert('invoke', 'api:GET:/api/transactions');
const rows = await repository.findMany();
const visibleRows = await ctx.filterRows('read', 'db:transactions', rows, {
  merchantId: 'm-100',
});
const response = await Promise.all(
  visibleRows.map((row) => ctx.filterFields('read', 'db:transactions', row)),
);
```

The context does not authenticate the request, fetch business rows, or infer tenant identity. Create it only after authentication and tenant resolution are complete.
