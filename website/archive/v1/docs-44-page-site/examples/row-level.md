# Row-level Example

## Scenario

Limit a report reader to rows whose `ownerId` matches the current user through `valueFrom`, push the scope into a list query, and recheck loaded rows.

## Runnable source

The repository DB-only example contains the complete rule, scope, list, detail, and cleanup flow:

```bash
npm run example:db
```

The central sequence is:

```typescript
const scope = await pc.getRowScope('u-2', 'read', 'db:reports');
const visibleRows = await pc.filterRows('u-2', 'read', 'db:reports', rows);
await pc.assertRow('u-2', 'read', 'db:reports', visibleRows[0]);
```

## Expected result

The command prints `[db-only] ok`. The scope is conditional on `ownerId`, the user's row remains, the other user's row is rejected, and the process closes cleanly.

## Fits and does not fit

Use `getRowScope()` before large queries and `canRow/assertRow/filterRows` for already loaded records. This example does not translate the DSL into a specific SQL/Mongo query and does not make field grants authorize an otherwise invisible row.
