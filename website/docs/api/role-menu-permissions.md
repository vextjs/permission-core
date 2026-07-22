# Role Menu Permissions API

## Purpose and preconditions

`scoped.roles.menuPermissions` turns an administrator's menu selection into traceable role grant sources. It uses assets saved from `MenuConfigInput` and supports menu, view, load API, action, and response-field grants.

Before using it:

- The role exists.
- The menu config has been saved with `scoped.menus.management.applyChanges()`, `scoped.menus.configs/items/views/loadApis/actions/responses.*()`, or `scoped.menus.config.save()`.
- Every write is previewed first, and execution receives the same input, `expected`, and `previewToken`.

This explicit preview/execute flow is intentional here. Ordinary incremental menu-config saves can auto-preview and commit, but role-menu authorization changes real access for a role and may affect many users, so the admin UI should show impact before committing.

## What Do You Want to Do?

| Goal | First API | Notes |
|---|---|---|
| Preview and commit grants | `preview()` then `grant()` / `deny()` / `revoke()` / `set()` | All writes use preview evidence and revision protection. |
| Read direct grants | `getDirect(roleId)` | Shows the role's own menu grants and selected response fields. |
| Page direct grants | `listDirect(roleId, { first, after })` | Use `first/after` for management tables. |
| Read effective grants | `getEffective(roleId)` | Includes inherited grants and deny-first resolution. |
| Generate authorization tree | `getAuthorizationTree(roleId, { configId })` | Powers a role editor tree with checked, denied, inherited, and disabled states. |

## Signatures

```ts
roles.menuPermissions.preview(roleId: string, change: MenuBusinessPermissionChange, options?: PreviewOptions): Promise<ImpactPreview<MenuBusinessPermissionPlan>>
roles.menuPermissions.grant(roleId: string, selection: MenuBusinessPermissionSelection, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuBusinessPermissionGrantResult>>
roles.menuPermissions.deny(roleId: string, selection: MenuBusinessPermissionSelection, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuBusinessPermissionGrantResult>>
roles.menuPermissions.revoke(roleId: string, input: { grantIds: readonly string[] }, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
roles.menuPermissions.set(roleId: string, assignments: readonly MenuBusinessPermissionAssignment[], options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
roles.menuPermissions.getDirect(roleId: string): Promise<VersionedResult<MenuBusinessDirectPermissionSnapshot>>
roles.menuPermissions.listDirect(roleId: string, query?: CursorQuery & { effect?: 'allow' | 'deny'; configId?: string }): Promise<PageResult<MenuBusinessGrantSnapshot>>
roles.menuPermissions.getEffective(roleId: string): Promise<VersionedResult<MenuBusinessEffectivePermissionSnapshot>>
roles.menuPermissions.getAuthorizationTree(roleId: string, options: { configId: string }): Promise<VersionedResult<MenuBusinessAuthorizationTree>>
```

Signature markers: `change: MenuBusinessPermissionChange`, `selection: MenuBusinessPermissionSelection`, `assignments: readonly MenuBusinessPermissionAssignment[]`.

## Parameters

<!-- docs:params owner=MenuBusinessPermissionSelection locale=en -->

### `MenuBusinessPermissionSelection`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `configId` | `string` | Required | Target menu config ID. |
| `menus` | `string[]` | Optional | Selected menu group or menu IDs. |
| `views` | `string[]` | Optional | Selected view IDs, for example `orders-list`. |
| `loads` | `ApiResource[]` | Optional | Exact selected load API resources. |
| `actions` | `string[]` | Optional | Exact selected action IDs. |
| `responseFields` | `MenuBusinessResponseFieldSelection[]` | Optional | Selected response fields for an API. |
| `include.descendants` | `boolean` | Default `false` | Include child menus and views when selecting menus. |
| `include.loads` | `boolean` | Default `true` | Include load APIs from selected views. |
| `include.actions` | `boolean` | Default `false` | Include actions from selected views. |
| `include.responseFields` | `'none' \| 'all'` | Default `'none'` | Whether to auto-include all response fields from selected APIs. |

Each `responseFields` item looks like:

```ts
{
  apiResource: 'api:GET:/api/orders',
  target: 'items',
  fields: ['orderNo', 'status'],
}
```

`fields` must come from fields declared for that API in the menu config. For paginated responses, write `target`, such as `items` or `data.items`; if one API has multiple response targets, omitting `target` is rejected as ambiguous. Use `include.responseFields: 'all'` to grant every field, or `'none'` plus explicit `responseFields` for precise control.

<!-- docs:params owner=MenuBusinessPermissionChange locale=en -->

### `MenuBusinessPermissionChange`

| operation | Preview input | Execution method | Meaning |
|---|---|---|---|
| `grant` | `{ operation: 'grant', selection }` | `grant(roleId, selection, options)` | Append allow menu grants. |
| `deny` | `{ operation: 'deny', selection }` | `deny(roleId, selection, options)` | Append deny menu grants. |
| `revoke` | `{ operation: 'revoke', grantIds }` | `revoke(roleId, { grantIds }, options)` | Remove specific grants. |
| `set` | `{ operation: 'set', assignments }` | `set(roleId, assignments, options)` | Replace all direct menu grants for the role. |

### `MenuBusinessPermissionAssignment`

| Field | Type | Meaning |
|---|---|---|
| `effect` | `'allow' \| 'deny'` | Effect for this assignment. |
| `selection` | `MenuBusinessPermissionSelection` | Menu selection to allow or deny. |

## Preview and write methods

<span id="role-menu-preview"></span>
### `roles.menuPermissions.preview(roleId, change, options?)`

<!-- docs:method name=roles.menuPermissions.preview locale=en -->

- **Purpose**: Expand a grant, deny, revoke, or set operation into a plan before writing, showing conflicts, affected users, and generated sources.
- **Parameters**: `roleId` and `change: MenuBusinessPermissionChange`.
- **State impact**: Read-only; no grant is written.
- **Raw return**: `ImpactPreview<MenuBusinessPermissionPlan>`; inspect `executable`, `conflicts`, `grants.items[].selectedAssets`, `grants.items[].selectedResponseFields`, `expected`, and `previewToken`.

<span id="role-menu-grant"></span>
### `roles.menuPermissions.grant(roleId, selection, options)`

<!-- docs:method name=roles.menuPermissions.grant locale=en -->

- **Purpose**: Append allow menu grants.
- **Parameters**: `selection: MenuBusinessPermissionSelection` must match the grant preview; `options` must carry `expected/previewToken`.
- **State impact**: Saves the grant and generates rule sources for views, APIs, actions, and response fields.
- **Raw return**: `MutationResult<MenuBusinessPermissionGrantResult>`; `generatedSources` and `generatedResponseFields` are generated counts for this write.

<span id="role-menu-deny"></span>
### `roles.menuPermissions.deny(roleId, selection, options)`

<!-- docs:method name=roles.menuPermissions.deny locale=en -->

- **Purpose**: Append deny menu grants to explicitly forbid selected menu capabilities.
- **Parameters**: Preview with `{ operation: 'deny', selection }` first.
- **State impact**: Saves a deny grant without deleting existing allow grants.
- **Raw return**: Same shape as `grant()`, with deny effect.

<span id="role-menu-revoke"></span>
### `roles.menuPermissions.revoke(roleId, input, options)`

<!-- docs:method name=roles.menuPermissions.revoke locale=en -->

- **Purpose**: Remove direct menu grants by grant ID.
- **Parameters**: `input.grantIds` comes from `grant()`, `getDirect()`, or `listDirect()`; preview revoke before executing.
- **State impact**: Removes the selected grants and their generated sources.
- **Raw return**: `MutationResult<BatchMutationSummary>`.

<span id="role-menu-set"></span>
### `roles.menuPermissions.set(roleId, assignments, options)`

<!-- docs:method name=roles.menuPermissions.set locale=en -->

- **Purpose**: Save a complete role-menu authorization form.
- **Parameters**: `assignments: readonly MenuBusinessPermissionAssignment[]`, each with `effect` and `selection`.
- **State impact**: Replaces all direct menu grants on the role; manual role rules and user-role bindings are unchanged.
- **Raw return**: `MutationResult<BatchMutationSummary>`.

## Read methods

<span id="role-menu-get-direct"></span>
### `roles.menuPermissions.getDirect(roleId)`

<!-- docs:method name=roles.menuPermissions.getDirect locale=en -->

- **Purpose**: Read menu grants owned directly by the role.
- **Parameters**: Role ID.
- **State impact**: Read-only.
- **Raw return**: `VersionedResult<MenuBusinessDirectPermissionSnapshot>`; each grant includes `selection`, `responseFields`, and `sourceStatus`.

<span id="role-menu-list-direct"></span>
### `roles.menuPermissions.listDirect(roleId, query?)`

<!-- docs:method name=roles.menuPermissions.listDirect locale=en -->

- **Purpose**: Page through a role's direct menu grants.
- **Parameters**: Optional `effect`, `configId`, `first`, and `after`.
- **State impact**: Read-only.
- **Raw return**: `PageResult<MenuBusinessGrantSnapshot>`.

<span id="role-menu-get-effective"></span>
### `roles.menuPermissions.getEffective(roleId)`

<!-- docs:method name=roles.menuPermissions.getEffective locale=en -->

- **Purpose**: Read menu grants from this role plus inherited grants from parent roles.
- **Parameters**: Role ID.
- **State impact**: Read-only.
- **Raw return**: `VersionedResult<MenuBusinessEffectivePermissionSnapshot>`; entries include `sourceRoleId/inherited/depth` and conflicts.

<span id="role-menu-get-authorization-tree"></span>
### `roles.menuPermissions.getAuthorizationTree(roleId, options)`

<!-- docs:method name=roles.menuPermissions.getAuthorizationTree locale=en -->

- **Purpose**: Build an admin authorization tree showing direct, inherited, conflict, and partial states for menus, views, load APIs, actions, and response fields.
- **Parameters**: `options.configId` selects the config.
- **State impact**: Read-only.
- **Raw return**: `VersionedResult<MenuBusinessAuthorizationTree>`; each node has `state`, `selection`, and `children`.

## Responses and side effects

Grant and deny operations save the administrator's selection and generate traceable sources. Response-field sources do not change responses by themselves; projection happens when the current user calls `subject.menus.filterResponse()` or when Vext automatically projects a protected response.

```json
{
  "data": {
    "roleId": "order-operator",
    "grantIds": { "total": 1, "items": ["grant_..."] },
    "generatedSources": 3,
    "generatedResponseFields": 2,
    "removedSources": 0
  },
  "auditId": "audit_..."
}
```

## Failures and limits

Common failures include missing roles, missing configs, selected views/actions/fields that do not exist, invalid resource format, stale preview tokens, revision conflicts, and capacity limits. `set()` can receive an empty array to clear direct menu grants, but it does not delete manual rules or user-role bindings.

## Example

```ts
const selection = {
  configId: 'admin',
  views: ['orders-list'],
  responseFields: [{
    apiResource: 'api:GET:/api/orders',
    target: 'items',
    fields: ['orderNo', 'status'],
  }],
  include: { loads: true, actions: true, responseFields: 'none' },
};

const preview = await scoped.roles.menuPermissions.preview(
  'order-operator',
  { operation: 'grant', selection },
);
if (!preview.executable) throw new Error('resolve conflicts first');

const result = await scoped.roles.menuPermissions.grant(
  'order-operator',
  selection,
  { ...preview.expected, previewToken: preview.previewToken },
);
```

```json
{
  "roleId": "order-operator",
  "generatedSources": 3,
  "generatedResponseFields": 2
}
```

## Related

See [Authorize Role Menus](/guide/role-menu-authorization), [Manage Menus](/guide/menu-management), and [Menus API](/api/menus).
