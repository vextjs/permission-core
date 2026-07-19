# Management Console

Management consoles usually edit roles, role rules, and user-role bindings together. Public manager APIs already handle permission cache invalidation; keep manual invalidation for direct storage writes, external synchronization, or cross-instance invalidation strategy.

The optional menu module adds directory/menu/page/button assets, API bindings, authorization trees, revisions, and audit records. Keep those presentation assets separate from core `PermissionRule` objects.

## Separate the screens

| Screen | Primary APIs |
|---|---|
| Role list/detail | `roles.list/get/update/inspect` |
| Role authorization tree | `menu.getAuthorizationTree()` / `menu.saveRoleAuthorization()` |
| User roles | `users.getRoles/setUserRoles/assign/revoke` |
| Menu/API assets | manifest import, `validate()`, revision and audit list |
| Subject preview | visible menu/button/route snapshots for an exact tenant subject |

## Role detail page

Use these APIs:

1. `roles.get()` / `roles.update()` for role metadata.
2. `roles.getRules()` for the role's own rules.
3. `roles.inspect()` for effective rules and inheritance.
4. `roles.delete()` for role removal.

`getRules()` returns only the role's own rules. Use `inspect()` when the UI needs the final inherited result.

## Save role rules

permission-core v1 does not expose a generic role-rule batch API. `roles.allow()` and `roles.deny()` can accept several actions for the same resource, but they are still explicit rule operations, not a `setRules()` replacement.

Before saving from a UI:

- validate every `action`
- validate every `resource`
- deduplicate by `type + action + resource + where`
- keep `allow` and `deny` visible when both exist
- save through your own backend service, then call the public `RoleManager` methods

Avoid binding a browser form directly to many remote `allow()` / `deny()` calls. A backend save service can validate the submitted rule array, reject partial input, compute a diff, and avoid unnecessary cache churn. Do not call `StorageAdapter.setRules()` from business code unless you intentionally own the missing validation and invalidation behavior.

For the menu authorization editor, prefer one audited backend command:

```typescript
const audit = await menu.saveRoleAuthorization(scope, roleId, {
  allow: input.allow,
  deny: input.deny,
  revoke: input.revoke,
  actorId: request.user.id,
  reason: input.reason,
});
```

Render `sourceRoleIds` so inherited and conflict states are explainable. Preserve allow and deny as separate choices rather than flattening them into a single checkbox.

## Row rules in forms

Store row conditions as the structured `where` DSL. Validate field, operator, literal/valueFrom shape, and variable availability on the backend. Do not let the UI submit raw SQL, Mongo filters, or executable expressions.

## User-role bindings

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
```

Use `setUserRoles()` for full replacement saves from an admin form. Use `assign()` and `revoke()` for small targeted changes. These methods invalidate the affected user's cache automatically.

Before replacement, validate that every role exists. Return the final assigned list and refresh the subject preview so the operator can see the effective result in the same tenant/app scope.

## Manifest and concurrency

- Treat frontend/API manifests as revisioned configuration. Use `replace` for an authoritative snapshot and `merge` only for explicit partial ownership.
- Run `menu.validate(scope)` before publishing changes.
- Use optimistic revision checks in the backend when multiple operators may edit the same scope.
- Record actor, reason, request ID, old/new revision, diff, and compensation state.
- A partial storage/audit failure is an error; do not display a success toast until the complete operation succeeds.

## Error mapping

Return clear errors to the frontend. Do not expose secrets, connection strings, raw database errors, or stack traces in production responses.

Map `ROLE_NOT_FOUND` to a stale-editor/not-found response, duplicate or inheritance conflicts to `409`, validation failures to `400`, and storage/compensation failures to an operational error. Keep the stable code and request ID available for support.

## Next step

See [Menu Permissions](/guide/menu-permissions), [Management Backend Example](/examples/management-backend), and [Error Response Mapping](/guide/error-response-mapping).
