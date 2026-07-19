# RoleManager

`RoleManager` manages role metadata, allow/deny rules, inheritance, and effective-role inspection.

## Purpose and import

```typescript
import type { RoleManager } from 'permission-core';
```

Use `pc.roles` for the default scope or `pc.scope(scope).roles` for an explicit tenant scope. Do not construct the manager directly.

## Construction and types

`RoleCreateOptions` requires `label` and accepts `parent` and `description`. `RoleUpdateOptions` accepts partial metadata. `RowRuleOptions` accepts structured `where`.

`RoleData` contains id, label, parent, description, and timestamps. `RoleInspection` contains `role`, `ownRules`, `effectiveRules`, and `roleChain`.

## Signature index

| Group | Methods |
|---|---|
| Metadata | `create(id, options)`; `update(id, options)`; `delete(id)` |
| Reads | `get(id)`; `list()` |
| Rule writes | `allow`; `deny`; `revokeRule`; `clearRules` |
| Rule reads | `getRules`; `getEffectiveRules` |
| Inheritance | `getRoleChain` |
| Detail | `inspect` |

All writes return `Promise<void>`. Reads return `RoleData`, rule arrays, chain entries, or `RoleInspection`.

## Behavior and defaults

Inheritance is single-parent. Deny remains higher priority than allow after roles are merged. Rule writes normalize action arrays and deduplicate identical rule tuples.

`getRules()` returns only the role's own rules; `getEffectiveRules()` includes the parent chain. Public writes invalidate the current scope cache. Deleting a role removes its rules and direct user bindings.

## Errors and limits

Duplicate IDs throw `ROLE_ALREADY_EXISTS`; missing roles throw `ROLE_NOT_FOUND`; cycles throw `CIRCULAR_INHERITANCE`. Invalid action/resource/where input uses validation errors.

A role with child roles cannot be deleted. There is no public generic batch `setRules()` API in v1. Management backends should validate a complete form submission and call public methods rather than exposing adapter writes.

## Minimal example

```typescript
await pc.roles.create('operator', { label: 'Operator' });
await pc.roles.allow('operator', ['read', 'update'], 'db:orders');

const detail = await pc.roles.inspect('operator');
await pc.roles.revokeRule('operator', 'update', 'db:orders');
```

## Related

See [Roles and Rules](/guide/roles-and-rules), [Management Console](/guide/site-preview-release), and [UserRoleManager](/api/user-roles).
