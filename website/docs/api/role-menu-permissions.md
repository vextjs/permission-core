# Role Menu Permissions
<!-- docs:inline-parity `scoped.roles.menuPermissions` `preview()` `grant/deny/revoke/set` `getDirect()` `listDirect()` `getEffective()` `getAuthorizationTree()` `listStale()` `MenuPermissionChange` `operation` `'grant' | 'deny' | 'revoke' | 'set'` `any` `apiChoices` `choiceRequirements` `permission` `nodeIds` `contributions` `MenuPermissionSelection` `include.descendants` `include.buttons` `descendants=true` `include.apis` `none` `required` `required=true` `all` `include.dataPermissions` `dataPermissions` `apiChoices.bindingIds` `availabilityMode='any'` `apiChoices.permissionsByBinding` `authorization.mode='any'` `executable=false` `plan.choiceRequirements.items` `kind='availability-any'` `candidates.items[].bindingId` `kind='authorization-any'` `candidates.items[].semanticKey` `permissionsByBinding[bindingId]` `grant` `{ operation: 'grant', selection }` `grant(roleId, selection, options)` `deny` `{ operation: 'deny', selection }` `deny(roleId, selection, options)` `revoke` `{ operation: 'revoke', grantIds }` `revoke(roleId, { grantIds }, options)` `set` `{ operation: 'set', assignments }` `set(roleId, assignments, options)` `roles.allow/deny` `preview(roleId, change, options?)` `ImpactPreview<MenuPermissionPlan>` `executable` `conflicts` `grants/removals` `expected` `previewToken` `{ operation:'grant', selection }` `MutationResult<MenuPermissionGrantResult>` `grantIds` `generatedSources/generatedSemanticRules` `{ operation:'deny', selection }` `MenuPermissionGrantResult` `revoke(roleId, input, options)` `input.grantIds` `getDirect/listDirect` `MutationResult<BatchMutationSummary>` `effect: allow|deny` `{ operation:'set', assignments }` `getDirect(roleId)` `VersionedResult<DirectMenuPermissionSnapshot>` `listDirect(roleId, query?)` `first/after` `effect='allow'|'deny'` `PageResult<DirectMenuGrantSnapshot>` `getDirect` `getEffective(roleId)` `VersionedResult<EffectiveMenuPermissionSnapshot>` `sourceRoleId/inherited/depth` `getAuthorizationTree(roleId)` `VersionedResult<AuthorizationTreeNode[]>` `selection` `state` `listStale(query?)` `PageResult<StaleMenuPermissionSource>` `previewRepairStale(input, options?)` `sourceIds` `listStale` `sourceRewrite` `ImpactPreview<StaleMenuPermissionRepairPlan>` `sourceImpacts` `repairStale(input, options)` `STALE_REFERENCE` `1000` `20000` -->

`scoped.roles.menuPermissions` expands menu selections into provenance-tracked role rules and reads direct, inherited, or stale menu grants.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want to Do?

Use this table as the shortest route from a task to the first method. Methods that can change broad state use a preview/execute pair so the admin UI can show impact before writing.

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
preview(roleId: string, change: MenuPermissionChange, options?: PreviewOptions): Promise<ImpactPreview<MenuPermissionPlan>>
grant(roleId: string, selection: MenuPermissionSelection, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuPermissionGrantResult>>
deny(roleId: string, selection: MenuPermissionSelection, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuPermissionGrantResult>>
revoke(roleId: string, input: { grantIds: readonly string[] }, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
set(roleId: string, assignments: readonly MenuPermissionAssignment[], options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
getDirect(roleId: string): Promise<VersionedResult<DirectMenuPermissionSnapshot>>
listDirect(roleId: string, query?: CursorQuery & { effect?: 'allow' | 'deny' }): Promise<PageResult<DirectMenuGrantSnapshot>>
getEffective(roleId: string): Promise<VersionedResult<EffectiveMenuPermissionSnapshot>>
getAuthorizationTree(roleId: string): Promise<VersionedResult<AuthorizationTreeNode[]>>
listStale(query?: CursorQuery): Promise<PageResult<StaleMenuPermissionSource>>
previewRepairStale(input: StaleMenuPermissionRepairInput, options?: PreviewOptions): Promise<ImpactPreview<StaleMenuPermissionRepairPlan>>
repairStale(input: StaleMenuPermissionRepairInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
```
## Understand the Three Layers First

Menu nodes, API bindings, and generated role-menu sources are separate records. Keeping them separate makes admin previews auditable and prevents UI state from becoming the only security boundary.

## Parameter Objects

The table explains object fields that are easy to confuse at call sites. Required fields are validated before the method mutates persistent authorization state.

<!-- docs:params owner=MenuPermissionSelection locale=en -->
<span id="role-menu-selection"></span>
### `MenuPermissionSelection`
<!-- docs:params owner=MenuPermissionChange locale=en -->
## Method Details: Preview and Commit Grants

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

<span id="role-menu-preview"></span>
### `preview(roleId, change, options?)`
<!-- docs:method name=roles.menuPermissions.preview locale=en -->

- **Purpose**: Use `roles.menuPermissions.preview` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-grant"></span>
### `grant(roleId, selection, options)`
<!-- docs:method name=roles.menuPermissions.grant locale=en -->

- **Purpose**: Use `roles.menuPermissions.grant` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-deny"></span>
### `deny(roleId, selection, options)`
<!-- docs:method name=roles.menuPermissions.deny locale=en -->

- **Purpose**: Use `roles.menuPermissions.deny` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-revoke"></span>
### `revoke(roleId, input, options)`
<!-- docs:method name=roles.menuPermissions.revoke locale=en -->

- **Purpose**: Use `roles.menuPermissions.revoke` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-set"></span>
### `set(roleId, assignments, options)`
<!-- docs:method name=roles.menuPermissions.set locale=en -->

- **Purpose**: Use `roles.menuPermissions.set` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-get-direct"></span>
## Method Details: Read Direct and Effective Grants

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `getDirect(roleId)`
<!-- docs:method name=roles.menuPermissions.getDirect locale=en -->

- **Purpose**: Use `roles.menuPermissions.getDirect` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-list-direct"></span>
### `listDirect(roleId, query?)`
<!-- docs:method name=roles.menuPermissions.listDirect locale=en -->

- **Purpose**: Use `roles.menuPermissions.listDirect` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `PageResult<T>` or the documented paged business result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-get-effective"></span>
### `getEffective(roleId)`
<!-- docs:method name=roles.menuPermissions.getEffective locale=en -->

- **Purpose**: Use `roles.menuPermissions.getEffective` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-get-authorization-tree"></span>
### `getAuthorizationTree(roleId)`
<!-- docs:method name=roles.menuPermissions.getAuthorizationTree locale=en -->

- **Purpose**: Use `roles.menuPermissions.getAuthorizationTree` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-list-stale"></span>
## Method Details: Repair Stale Sources

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `listStale(query?)`
<!-- docs:method name=roles.menuPermissions.listStale locale=en -->

- **Purpose**: Use `roles.menuPermissions.listStale` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `PageResult<T>` or the documented paged business result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-preview-repair-stale"></span>
### `previewRepairStale(input, options?)`
<!-- docs:method name=roles.menuPermissions.previewRepairStale locale=en -->

- **Purpose**: Use `roles.menuPermissions.previewRepairStale` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="role-menu-repair-stale"></span>
### `repairStale(input, options)`
<!-- docs:method name=roles.menuPermissions.repairStale locale=en -->

- **Purpose**: Use `roles.menuPermissions.repairStale` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "data": {
    "roleId": "order-operator",
    "grantIds": { "total": 1, "items": ["grant_..."], "truncated": false, "digest": "..." },
    "refreshedGrantIds": { "total": 0, "items": [], "truncated": false, "digest": "..." },
    "generatedSources": 4,
    "removedSources": 0,
    "generatedSemanticRules": 4
  },
  "operationId": "operation_...",
  "auditId": "audit_..."
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
const selection = {
  nodeIds: ['orders'],
  include: { descendants: true, buttons: true, apis: 'required', dataPermissions: true },
  apiChoices: { bindingIds: [], permissionsByBinding: {} },
};
const preview = await scoped.roles.menuPermissions.preview(
  'order-operator', { operation: 'grant', selection },
);
if (!preview.executable) throw new Error('Resolve preview choices or conflicts');
const result = await scoped.roles.menuPermissions.grant('order-operator', selection, {
  ...preview.expected, previewToken: preview.previewToken,
});
```
```json
{ "executable": true, "generatedSources": 4 }
```
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Authorized Collection](/api/authorized-collection).
