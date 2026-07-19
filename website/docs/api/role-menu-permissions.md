# Role Menu Permissions

## Purpose and preconditions

`scoped.roles.menuPermissions` turns an administrator's menu selection into durable, provenance-aware role rules. The role, selected nodes, API bindings, and data templates must exist in the same scope. Always preview a grant, deny, revoke, set, or repair before execution.

## Signatures

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

Preview uses a `MenuPermissionChange` whose `operation` is `'grant' | 'deny' | 'revoke' | 'set'`. Its `choiceRequirements` must be resolved through `apiChoices` when availability or authorization uses `any`.

## Responses and side effects

Grant/deny records the administrator intent and a contribution snapshot, then creates canonical role-rule sources for selected nodes, APIs, and data templates. Effective reads preserve source role, inheritance depth, integrity, availability, and drift.

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

Unresolved choices make preview non-executable. Stale assets or changed contributions surface as `STALE_REFERENCE` or invalid/drifted source states; they do not silently refresh. Role/menu capacity, `1000`-item selection/mutation bounds, `20000` direct grants, and revision/preview checks apply.

## Example

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

The executable branch narrows the preview before its token and expected revisions are read.

## Related

See [Authorize Role Menus](/guide/role-menu-authorization), [Menus](/api/menus), and [API Bindings](/api/api-bindings).
