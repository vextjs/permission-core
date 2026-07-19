# FAQ

## Is permission-core an authentication library?

No. Your application owns login, sessions, tokens, and identity proof. permission-core starts after you have a string `userId` or a complete `PermissionSubject`.

## Do I need MongoDB?

No. Storage is an adapter concern. `MemoryAdapter` proves a flow locally, `FileAdapter` fits a single process, and `MonSQLizeStorageAdapter` is the built-in shared production path. Other databases require a custom `StorageAdapter`.

## Does HTTP-only mean memory-only?

No. HTTP-only selects route resources and runtime APIs; it does not select storage. Route rules can use any supported adapter.

## Why does `getResources()` not replace `can()`?

`getResources()` helps render navigation. Final backend authorization still calls `can()` or `assert()` because deny rules, wildcards, and request context can change the result.

## What does `write` mean?

Rule-side `write` grants `create + update`. Request-side `write` requires both, so payload filtering should normally use explicit `create` or `update`.

## Can one button require multiple APIs?

Yes. `permission-core/menu` binds one operation to multiple APIs with `permissionMode: "any" | "all"`. Enable `strictApiBindings` for sensitive operations and still guard every backend route.

## Which menu storage should production use?

Use `MonSQLizeMenuStorageAdapter` for shared durable production state. `FileMenuStorageAdapter` is limited to one process. Core and menu stores are separate and need one clear connection owner.

## How does tenant isolation fail safely?

Use an explicit `PermissionSubject` and a bound scope. Missing or conflicting tenant/app fields fail with `INVALID_ARGUMENT`; they do not silently reuse the default scope.

## What should a Vext application enable?

Run authentication first, use `tenantRequired` for tenant-aware routes, and keep `guardRoutePermissions` enabled unless another tested guard owns the same route metadata.

## Why must I call `init()` and `close()`?

`init()` prepares storage and runtime state before authorization. `close()` releases resources according to adapter ownership during graceful shutdown.

## Next task

Use the [Integration Checklist](/guide/integration-checklist) when the first allowed and denied decisions work.
