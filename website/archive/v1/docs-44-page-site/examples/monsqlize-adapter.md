# MonSQLize Adapter Example

## Scenario

Run core authorization and menu persistence on one connected MonSQLize instance with one connection owner and shared `cache-hub` cache.

## Runnable source

Use this application-startup composition after `msq.connect()`:

```typescript
const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({ msq, ownsConnection: true }),
  cache: msq.getCache(),
});
const menu = createMenuPermission({
  core: pc,
  storage: new MonSQLizeMenuStorageAdapter({ msq, ownsConnection: false }),
});

await pc.init();
await menu.init();
```

Shutdown in dependency order:

```typescript
await menu.close();
await pc.close();
```

## Expected result

Core creates scoped role/binding/rule collections; menu creates separate node/API-binding/revision/audit collections. Permission rules use `msq.getCache()`, and closing menu does not close the shared connection before core finishes.

## Fits and does not fit

Use this for durable shared production authorization with the verified MongoDB-backed MonSQLize path. It is not a business-data repository and does not make two adapters co-own one connection. Other databases require a custom `StorageAdapter`; backup and migrate core/menu collections together.
