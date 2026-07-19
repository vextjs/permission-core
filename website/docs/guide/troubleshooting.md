# Troubleshooting

Start with the error `code` and `details.kind`, not the message text. PermissionCore errors are structured and may also include `retryable`, `committed`, and `operationId`.

## Installation and initialization

| Symptom | Likely cause | Recovery |
|---|---|---|
| `monsqlize` cannot be resolved | The required peer is missing | Install exactly `monsqlize@3.1.0` next to `permission-core` |
| `VEXT_MONSQLIZE_REQUIRED` | The Vext plugin received no database runtime | Pass the host's connected MonSQLize instance to `permissionPlugin` |
| `MONSQLIZE_CONTRACT_UNSUPPORTED` | The instance is old, disconnected, or not MonSQLize 3.1 compatible | Verify version and connection, then recreate the core |
| `DATABASE_UNAVAILABLE` during `init()` | MongoDB health or transaction probe failed | Restore the database; do not accept authorization traffic until `health()` is up |
| `SCHEMA_VERSION_MISMATCH` or `SCHEMA_CONTRACT_MISMATCH` | Persisted authorization state does not match this runtime contract | Stop writes, inspect the affected scope hash, and restore a compatible state; do not downgrade around the check |

`PermissionCore` requires an options object with `monsqlize`. A no-argument constructor or a separate storage adapter is not supported.

## Scope, identity, and decisions

| Symptom | Likely cause | Recovery |
|---|---|---|
| `INVALID_SUBJECT` | `userId` or the subject scope is incomplete | Build the subject from authenticated server state and include at least `tenantId` |
| `SCOPE_CONFLICT` | Two trusted identity sources disagree on scope | Reject the request and fix the authentication integration; never choose one silently |
| `POLICY_CONTEXT_MISSING` | A rule uses `valueFrom: 'context.*'` but the context value is absent | Supply the required context to `forSubject(subject, context)` |
| `can()` is `false` with no deny rule | No active allow matched | Call `explain()` and inspect `reason`; `no-allow` is the expected default-deny result |
| An allow still loses | A matching deny, disabled role, unknown condition, or unavailable source closed the decision | Inspect `explain()`, effective roles, effective rules, and source status |

Remember that `cannot(action, resource)` returns `!can(action, resource)`. A `true` value does not prove that an explicit deny rule exists.

## Data, menus, and concurrency

| Symptom | Likely cause | Recovery |
|---|---|---|
| `SCOPE_FIELD_MAPPING_REQUIRED` | An authorized collection has no field for a scope dimension | Provide `scopeFields` for each scope dimension in use |
| `FIELD_PERMISSION_DENIED` on filter or sort | A queried field is not readable, even if it is omitted from the result | Grant the field deliberately or remove it from filtering/sorting; this prevents inference |
| `DATA_BULK_SCOPE_MUTATION_UNSAFE` | A bulk write can move data outside the authorized condition | Split the operation or use an update that preserves tenant and policy fields |
| `REVISION_CONFLICT` | Another administrator changed the entity | Reload current data and revision, show the conflict, then let the user retry |
| Preview is not executable | Choices, source rewrites, or capacity acknowledgement are unresolved | Display `conflicts` and `choiceRequirements`; execute only with the returned preview token |
| A menu is visible but its button is disabled | The button permission or a required API binding is unavailable | Inspect `getButtonMap()` and the binding's `apiRisks` |

Management writes are optimistic and audited. Do not retry a conflict by replacing `expectedRevision` with an arbitrary current number; reload the form state first.

## Cache and Vext recovery

Cache is bypassed by default. If opt-in cache health is degraded, permission reads fall back to the database where possible and `health().cache` records the incident. Restore the MonSQLize cache backend and monitor invalidation outcomes; do not add a second cache client to permission-core.

The Vext plugin returns `VEXT_AUTH_REQUIRED` when a protected route has no trusted authentication context. A route manifest change after startup returns `VEXT_ROUTE_RESTART_REQUIRED` and all routes answer 503 until the process restarts with a consistent manifest. This is intentional fail-closed behavior.

For production diagnosis, retain the HTTP request ID, permission `operationId`, error code, details discriminator, tenant-safe scope hash, and current `health()` snapshot. Continue with [Production Operations](/guide/production-operations) for runbooks and readiness checks.
