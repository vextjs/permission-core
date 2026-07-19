# Resource Paths

permission-core uses resource strings to describe what is protected. Keep them stable, predictable, and close to the boundary you actually check.

## Route resources

Use:

```text
<METHOD>:<path>
```

Examples:

```text
GET:/api/orders
POST:/api/orders
DELETE:/api/orders/:id
```

Prefer matched route templates over real request URLs with IDs. That keeps rules stable and avoids creating one rule per record.

## Data resources

Use:

```text
db:<collection>
db:<collection>:<field>
```

Examples:

```text
db:transactions
db:transactions:amount
db:refunds:internalNote
```

Collection resources guard the operation. Field resources decide which fields remain visible or writable.

## Menu and API resources

The menu module commonly uses:

```text
ui:menu:system.user
ui:page:system.user.list
ui:button:system.user.create
api:POST:/api/users
```

`ui:` resources control navigation experience and authorization editors. `api:` resources bind a UI operation to one or more backend endpoints. The backend still performs the final check.

## Actions

| Area | Common actions |
|------|----------------|
| Route | `invoke` |
| Data | `read`, `create`, `update`, `delete`, `write`, `*` |

Use `write` carefully. It expands to `create + update` in rules and requires both when requested.

## Wildcards

Wildcards are useful for admin roles:

```typescript
await pc.roles.allow('admin', '*', '*');
```

For payment and finance systems, prefer explicit resource groups where possible. Broad wildcards are harder to audit and should usually be paired with management review.

Built-in wildcards are scheme-aware and suffix-oriented. `GET:/api/*` does not authorize `POST:/api/orders`, and `db:*` does not cross into `api:` or `ui:`. A middle-segment value such as `GET:/api/*/items` is not a generic glob.

## Row conditions do not belong in resource strings

Keep row restrictions in a rule's structured `where` condition:

```typescript
await pc.roles.allow('merchant-auditor', 'read', 'db:transactions', {
  where: { field: 'merchantId', op: 'eq', valueFrom: 'merchantId' },
});
```

The stable resource remains `db:transactions`; request context supplies the `merchantId` variable. This keeps resource matching and data predicates separate.

## Custom schemes

Register a custom scheme once through `resourceSchemes`. Its validator and matcher are then shared by role writes, runtime checks, menu validation, and authorization trees. Do not add a scheme only to one layer.

Common mistakes include concrete URLs with IDs/query strings, using `getResources()` as final authorization, embedding tenant IDs inconsistently in resources, and granting global `*` where a reviewed scheme prefix is sufficient.

## Next step

Continue with [Roles and Rules](/guide/roles-and-rules) and [Permission Checks](/guide/check-permission).
