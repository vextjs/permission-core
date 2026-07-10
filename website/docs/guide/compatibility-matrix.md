# Compatibility Matrix

This page records the currently verified runtime and dependency boundary.

## Runtime

| Component | Version / declaration | Status |
|-----------|-----------------------|--------|
| Node.js | `>=18` | Supported |
| TypeScript | `5.9.3` | Verified |
| Vitest | `3.2.6` | Verified |
| `@vitest/coverage-v8` | `3.2.6` | Verified |
| `cache-hub` | `2.2.4` | Verified |
| `monsqlize` | `2.0.3` | Verified |

## Verified commands

```bash
npm run typecheck
npm run test:coverage
npm run build
npm run example:all
cd website && npm run build
```

The `1.1.0` unreleased gate enforces minimum coverage of 92% statements, 89.5% branches, 95% functions, and 92% lines. Module-specific floors also protect `menu`, `scope`, and `adapters/vext`.

## Storage support

| Adapter | Use case | Notes |
|---------|----------|-------|
| `MemoryAdapter` | Tests, demos, local development | No external storage |
| `FileAdapter` | Local fallback | Not for shared multi-instance writes |
| `MonSQLizeStorageAdapter` | Production persistence path | Uses `monsqlize@2.0.3`; production examples pass `msq.getCache()` into `PermissionCore` |

permission-core is a Node.js authorization core, not a browser SDK.
