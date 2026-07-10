# FAQ

## Is permission-core an authentication library?

No. Your application still owns login, sessions, tokens, password handling, and identity proof. permission-core starts after you already know the current `userId`.

## Do I need MongoDB?

No. The official production adapter uses `monsqlize`, and the current documented path uses MongoDB through monsqlize. The core runtime only depends on the `StorageAdapter` contract, so you can implement another adapter.

## Does HTTP-only mean memory-only?

No. HTTP-only describes which resources and APIs you use. Storage is independent. You can store route rules in memory, a local file, or MonSQLize.

## Why does `getResources()` not replace `can()`?

`getResources()` is useful for UI visibility. Final authorization should still call `can()` or `assert()` on the server because deny rules, wildcards, and request context can make a visible resource fail.

## What does `write` mean?

Rule-side `write` grants both `create` and `update`. Request-side `write` requires both `create && update`, so it is stricter. For payload filtering, prefer explicit `create` or `update`.

## How should anonymous requests work?

Handle them before calling permission-core. The public API expects a string `userId`. If a request is not authenticated, reject it or treat it as unauthorized in your middleware or service layer.

## Can I build an admin console on top?

Yes. Use `roles` for role and rule management, and `users` for user-role bindings. Public manager APIs invalidate permission cache entries for their own writes. Call `invalidate(userId)` or `invalidateAll()` yourself only when you bypass those managers, write storage directly, synchronize permissions from another system, or need deployment-level cache coordination.

For menu/page/button state, API bindings, authorization trees, revisions, and audit events, use `permission-core/menu`. Persist that module separately with `FileMenuStorageAdapter` for one process or `MonSQLizeMenuStorageAdapter` for shared production storage.

## Can one button require multiple APIs?

Yes. Bind multiple API records to one button and use `permissionGroup` plus `permissionMode: "any" | "all"`. UI visibility remains an experience layer; every backend route still needs `assertSubject()` or an equivalent framework guard.

## How does tenant isolation work?

Use `PermissionSubject` and `pc.scope({ tenantId, ... })`. Roles, rules, user bindings, cache keys, and scoped menu assets stay separated. A missing tenant or conflicting subject/bound scope fails with `INVALID_ARGUMENT`; it does not silently reuse the default scope.

## Should Vext applications write their own permission middleware?

Normally no. Use `createVextPermissionPlugin()` from `permission-core/adapters/vext`, run authentication first, enable `tenantRequired` for tenant-aware routes, and keep `guardRoutePermissions` enabled so native route `auth.permissions` is enforced.

## What should I run before release?

Run:

```bash
npm run typecheck
npm run test:coverage
npm run test:docs
npm run build
npm run example:all
npm run test:package
cd website && npm run build
```
