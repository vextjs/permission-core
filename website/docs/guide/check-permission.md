# Permission Checks

The main runtime checks are `can`, `cannot`, and `assert`.

## Boolean check

```typescript
const ok = await pc.can('u-1', 'invoke', 'GET:/api/orders');
```

Use `can()` when you need a boolean result and will decide how to respond.

## Assertion

```typescript
await pc.assert('u-1', 'invoke', 'GET:/api/orders');
```

Use `assert()` in route guards or service methods when no permission should raise an error immediately.

## Negative helper

```typescript
const blocked = await pc.cannot('u-1', 'invoke', 'POST:/api/refunds');
```

`cannot()` is a semantic wrapper around the negative result of `can()`.

## Deny priority

If a user has one role that allows a resource and another role that denies it, deny wins. This is intentional and keeps high-risk payment operations conservative.

## Context

Some row and field checks can read variables from context:

```typescript
await pc.can('u-1', 'read', 'db:transactions', {
  merchantId: 'm-100',
});
```

The current `userId` still comes from the API argument. A `userId` inside context does not override the caller identity.

## UI visibility is not final authorization

Use `getResources()` for menus and buttons, but keep `can()` or `assert()` on the server as the final decision point.
