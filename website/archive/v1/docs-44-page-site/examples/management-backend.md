# Management Backend Example

## Scenario

Serve one role-authorization editor: load explainable role/menu state, save one audited authorization change, then refresh the exact tenant snapshot.

## Runnable source

Run the repository menu flow for manifest, visibility, backend assertion, and lifecycle evidence:

```bash
npm run example:menu
```

The backend save command is one operation:

```typescript
const audit = await menu.saveRoleAuthorization(scope, roleId, {
  allow: input.allow,
  deny: input.deny,
  revoke: input.revoke,
  actorId: request.user.id,
  reason: input.reason,
});
```

## Expected result

The runnable command prints the visible menu and button map while the backend API assertion succeeds. The save command returns an audit entry with revision/diff information; the UI then reloads `roles.inspect()`, `getAuthorizationTree()`, its `sourceRoleIds`, and the subject snapshot.

## Fits and does not fit

Use this for one backend-owned, validated, revision-aware admin save. It is not a browser calling many adapter writes or remote `allow()` calls. The backend must reject stale revisions/partial input and must not show success when rule, audit, or compensation work fails.
