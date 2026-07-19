# Integration Checklist

Use this consumer checklist after First Success works and before calling an application integration ready.

## Runtime lifecycle

- [ ] `pc.init()` completes during service startup.
- [ ] `pc.close()` runs during graceful shutdown.
- [ ] Authentication rejects anonymous requests before permission-core receives a subject.
- [ ] Adapter and connection ownership are explicit.

## Resources and rules

- [ ] Route resources use matched templates such as `DELETE:/api/orders/:id`.
- [ ] Data resources use `db:<collection>[:<field>]`.
- [ ] The management UI exposes deny rules and inherited effective rules.
- [ ] Rule saves deduplicate the complete rule identity.
- [ ] Rule and user-binding changes invalidate the intended permission cache scope.

## Tenant isolation

- [ ] Every tenant-aware request produces a non-empty `tenantId` before authorization.
- [ ] Subject and bound scope fields match exactly.
- [ ] Core storage, menu storage, cache keys, revisions, and audit queries use the same scope.
- [ ] A negative test proves the same `userId` cannot reuse tenant A permissions in tenant B.

## Menus and backend APIs

- [ ] Roles, rules, and user bindings exist before menu visibility is tested.
- [ ] The complete manifest imports successfully and `validate()` reports no errors.
- [ ] Sensitive operations have API bindings and `strictApiBindings` is enabled.
- [ ] Multi-API operations explicitly select `permissionMode: "any" | "all"`.
- [ ] Every backend route still calls `assertSubject()` or an equivalent guard.
- [ ] Shared production menu state uses `MonSQLizeMenuStorageAdapter`.

## Vext

- [ ] Authentication writes `req.auth` before permission middleware.
- [ ] Tenant-aware routes enable `tenantRequired`.
- [ ] Native route `auth.permissions` is consumed.
- [ ] `guardRoutePermissions` stays enabled unless another tested guard owns the metadata.
- [ ] `ownsCore`, `ownsMenu`, and connection ownership match application lifecycle.

## Behavioral evidence and recovery

- [ ] Evidence includes one allowed and one denied request.
- [ ] Scoped integrations include a cross-tenant denial.
- [ ] Persistent adapters survive restart with core and menu state intact.
- [ ] A stale revision or invalid manifest is rejected without a partial save.
- [ ] Shutdown releases only resources owned by the integration.
- [ ] Rollback restores a known manifest revision and invalidates affected cache entries.

Continue with [Production Deployment](/guide/production-deployment) for observability, backup, and rollout details.
