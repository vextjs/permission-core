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

## Next step

Continue with [Roles and Rules](/guide/roles-and-rules) and [Permission Checks](/guide/check-permission).
