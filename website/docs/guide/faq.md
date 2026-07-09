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

## What should I run before release?

Run:

```bash
npm run typecheck
npm run test:coverage
npm run build
npm run example:all
cd website && npm run build
```
