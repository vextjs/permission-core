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

Strict mode is enabled by default. Deny rules are resolved before allow results, and denied resources are also removed from `getResources()` visibility output.

## Context

Some row and field checks can read variables from context:

```typescript
await pc.can('u-1', 'read', 'db:transactions', {
  merchantId: 'm-100',
});
```

The current `userId` still comes from the API argument. A `userId` inside context does not override the caller identity.

## Request-side `write`

Rule-side `write` expands to create and update grants. A request for `write` requires both create and update decisions, so it is an AND operation rather than a loose alias. Prefer a concrete `create` or `update` action for payload filtering.

## Subject and tenant checks

```typescript
const subject = { tenantId: 'tenant-a', appId: 'admin', userId: 'u-1' };
await pc.assertSubject(subject, 'invoke', 'api:POST:/api/refunds');
```

Subject checks require an explicit tenant and exact scope. A subject that conflicts with a bound `pc.scope(scope)` context fails with `INVALID_ARGUMENT` instead of falling back to a default tenant.

## Row and field checks

Collection authorization, row scope, and field filtering are separate decisions:

```typescript
await pc.assert(userId, 'read', 'db:transactions');
const rowScope = await pc.getRowScope(userId, 'read', 'db:transactions', context);
const rows = await repository.findMany({ where: rowScope.where });
const visible = await pc.filterRows(userId, 'read', 'db:transactions', rows, context);
const response = await Promise.all(
  visible.map((row) => pc.filterFields(userId, 'read', 'db:transactions', row)),
);
```

Do not put row predicates back into a route resource or use `can()` alone to filter a dataset.

## UI visibility is not final authorization

Use `getResources()` for menus and buttons, but keep `can()` or `assert()` on the server as the final decision point.

The menu module can combine several required APIs with `permissionMode: "any" | "all"`. The Vext adapter evaluates the same group before the handler when `guardRoutePermissions` is enabled. These are framework/menu conveniences over the same core decision model, not replacements for backend authorization.

## Typical request order

1. Authenticate and resolve tenant identity.
2. Build the normalized route resource.
3. Run `assertSubject()` or a framework route guard.
4. In the service, authorize collection and row access.
5. Filter response/write fields.
6. Map only expected authorization errors to `403`; propagate storage and lifecycle failures.
