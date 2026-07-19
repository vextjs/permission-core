# Field Permission Example

## Scenario

Return only `title` and `summary` from an authorized report row while removing `id`, `ownerId`, and `rawCost`.

## Runnable source

The repository DB-only flow runs the collection, row, and field checks together:

```bash
npm run example:db
```

```typescript
const safeFields = await pc.filterFields(
  'u-2',
  'read',
  'db:reports',
  row,
);
```

## Expected result

The command prints `[db-only] ok`; `safeFields` is `{ title: 'Q2', summary: 'good' }`. The source row remains unchanged, so the caller must return the filtered object rather than the original.

## Fits and does not fit

Use this at read serializers and with explicit `create`/`update` actions for write payloads. It filters top-level properties only. It is not route authorization, row authorization, schema validation, nested masking, encryption, or a database projection.
