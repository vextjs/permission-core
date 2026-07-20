# Troubleshooting
<!-- docs:inline-parity `code` `details.kind` `retryable` `committed` `operationId` `health` `PermissionCoreHealth` `directRoles` `VersionedResult<UserRoleBindingSet>` `data.roleIds/status/revision` `explanation` `SubjectRuntimeResult<PermissionExplanation>` `data.allowed/reason/evaluations` `detailBudget.truncated` `monsqlize` `permission-core` `monsqlize@3.1.0` `VEXT_MONSQLIZE_REQUIRED` `permissionPlugin` `MONSQLIZE_CONTRACT_UNSUPPORTED` `init()` `DATABASE_UNAVAILABLE` `health()` `SCHEMA_VERSION_MISMATCH` `SCHEMA_CONTRACT_MISMATCH` `PermissionCore` `INVALID_SUBJECT` `userId` `tenantId` `SCOPE_CONFLICT` `POLICY_CONTEXT_MISSING` `valueFrom: 'context.*'` `forSubject(subject, context)` `can()` `false` `explain()` `reason` `no-allow` `cannot(action, resource)` `!can(action, resource)` `true` `SCOPE_FIELD_MAPPING_REQUIRED` `scopeFields` `FIELD_PERMISSION_DENIED` `DATA_BULK_SCOPE_MUTATION_UNSAFE` `REVISION_CONFLICT` `conflicts` `choiceRequirements` `getActionMap()` `getViewState()` `expectedRevision` `health().cache` `VEXT_AUTH_REQUIRED` `VEXT_ROUTE_RESTART_REQUIRED` -->

Start from structured error `code` and `details.kind`, then narrow the problem to initialization, subject identity, rule state, data guard, menu state, cache, or Vext route integration.

## Minimal Diagnostic Order

Check health, direct roles, and an explanation before changing state. These reads identify the failing layer without accidentally granting new permissions in diagnostic code. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const health = await pc.health();
if (health.status !== 'up') {
  logger.warn({ health }, 'permission core is not fully healthy');
}

const scoped = pc.scope({ tenantId: 'acme' });
const directRoles = await scoped.userRoles.getDirect('u-1');
const subject = pc.forSubject({
  userId: 'u-1', scope: { tenantId: 'acme' },
});
const explanation = await subject.explain('invoke', 'api:GET:/api/orders');
```
## Find by Symptom

| Symptom | Check first | Usually jump to |
|---|---|---|
| `can()` returns `false` even though you expected allow | `reason/evaluations` from `subject.explain()` | Scope, Identity, and Decisions |
| `assert()` throws `PERMISSION_DENIED` | `explain()` with the same action/resource | Scope, Identity, and Decisions |
| Menu is visible but an action is disabled | `reason` from `subject.menus.getActionMap()` and the `load` state from `getViewState()` | Data, Menus, and Concurrency |
| Menu config is saved but the role lacks permission | Whether role-menu preview includes the expected `views/actions/responseFields` | Data, Menus, and Concurrency |
| Authorized collection returns no rows | scope, `scopeFields`, row `where`, and field permissions | Data, Menus, and Concurrency |
| preview or cursor is stale | Whether input, scope, filter/sort, or state changed | Data, Menus, and Concurrency |
| Vext route keeps returning 503 | Authentication context and route manifest changes | Cache and Vext Recovery |

## Installation and Initialization

Most startup failures come from a missing MonSQLize peer, an incompatible runtime, an unavailable database, or a schema contract mismatch. Treat these as readiness failures. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Scope, Identity, and Decisions

Subject scope must be complete and trusted. Missing policy context, no matching allow, explicit deny, disabled roles, or unavailable sources all fail closed. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Data, Menus, and Concurrency

Data filters, field projection, bulk writes, preview flows, menu availability, and revision conflicts all have explicit failure states. Refresh the current state instead of inventing revisions. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Cache and Vext Recovery

Cache incidents degrade health and should be recovered through the host MonSQLize cache backend. Vext routes without trusted authentication return authentication errors, and hot route manifest changes require restart. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

Continue with [Production Operations](/guide/production-operations).
