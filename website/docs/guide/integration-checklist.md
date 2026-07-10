# Integration Checklist

Use this checklist before calling a permission-core integration ready.

## Runtime

- [ ] `pc.init()` runs during service startup.
- [ ] `pc.close()` runs during graceful shutdown.
- [ ] Anonymous requests are rejected before permission-core APIs.
- [ ] Route resources use matched route templates.
- [ ] Data resources use `db:<collection>[:<field>]`.

## Rules

- [ ] Deny rules are visible in management UI.
- [ ] Rule save paths deduplicate by `type + action + resource + where`.
- [ ] Role inheritance is inspected with `roles.inspect()` when shown in UI.
- [ ] Cache invalidation runs after rule and binding changes.

## Tenant isolation

- [ ] Every tenant-aware request produces a non-empty `tenantId` before authorization.
- [ ] `PermissionSubject` and bound scope fields match exactly; conflicts fail instead of falling back.
- [ ] Core storage, menu storage, permission cache, revisions, and audit queries use the same scope.
- [ ] A negative test proves that the same `userId` cannot reuse tenant A permissions in tenant B.

## Menus and backend APIs

- [ ] Roles are created and users assigned before menu visibility is tested.
- [ ] The complete directory/menu/page/button manifest is imported and `validate()` has no errors.
- [ ] Every sensitive button has one or more backend API bindings and `strictApiBindings` is enabled where missing APIs must disable the operation.
- [ ] API bindings use explicit `permissionMode: "any" | "all"` for grouped requirements.
- [ ] Backend routes still call `assertSubject()` or an equivalent framework guard.
- [ ] Production uses `FileMenuStorageAdapter` only for one process, or `MonSQLizeMenuStorageAdapter` for shared durable storage.

## Vext

- [ ] Authentication writes `req.auth` before the permission middleware runs.
- [ ] `tenantRequired` is enabled for tenant-aware routes and conflicting tenant sources fail closed.
- [ ] Native route `auth.permissions` is consumed by the built-in guard.
- [ ] `guardRoutePermissions` remains enabled unless another tested guard owns the same metadata.
- [ ] Plugin `ownsCore`, `ownsMenu`, and connection ownership match the application lifecycle.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run test:coverage`
- [ ] `npm run test:docs`
- [ ] `npm run build`
- [ ] `npm run example:all`
- [ ] `npm run test:package`
- [ ] `cd website && npm run build`
