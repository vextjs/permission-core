# Menus

## Purpose and preconditions

`scoped.menus` manages the tenant-scoped menu tree and its frontend manifest. Nodes model navigation/UI assets; they do not replace backend authorization. Structural or permission-bearing changes use impact preview when existing role-generated sources may be affected.

## Signatures

```ts
create(input: MenuNodeCreateInput, options?: MutationOptions): Promise<MutationResult<MenuNode>>
get(nodeId: string): Promise<VersionedResult<MenuNode>>
list(query?: CursorQuery & MenuNodeFilter): Promise<PageResult<MenuNode>>
getTree(options?: { rootId?: string; includeHidden?: boolean }): Promise<VersionedResult<MenuTreeNode[]>>
update(nodeId: string, patch: MenuNodeUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<MenuNode>>
previewUpdate(nodeId: string, request: MenuNodeImpactUpdateRequest, options?: PreviewOptions): Promise<ImpactPreview<MenuNodeUpdatePlan>>
executeUpdate(nodeId: string, request: MenuNodeImpactUpdateRequest, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>
previewMove(input: MenuMoveInput, options?: PreviewOptions): Promise<ImpactPreview<MenuMovePlan>>
move(input: MenuMoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>
previewReorder(input: MenuReorderInput, options?: PreviewOptions): Promise<ImpactPreview<MenuReorderPlan>>
reorder(input: MenuReorderInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
previewSetStatus(nodeId: string, status: EntityStatus, options?: PreviewOptions): Promise<ImpactPreview<MenuStatusPlan>>
setStatus(nodeId: string, status: EntityStatus, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>
getRemovalImpact(nodeId: string): Promise<VersionedResult<MenuRemovalImpact>>
previewRemove(nodeId: string, input: MenuRemoveInput, options?: PreviewOptions): Promise<ImpactPreview<MenuRemovalPlan>>
remove(nodeId: string, input: MenuRemoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
findStaleReferences(query?: CursorQuery): Promise<PageResult<StaleReference>>
previewRepairStaleReferences(input: StaleRepairInput, options?: PreviewOptions): Promise<ImpactPreview<StaleRepairPlan>>
repairStaleReferences(input: StaleRepairInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>

scoped.menus.manifest.preview(input: MenuManifestInput, options?: PreviewOptions): Promise<ImpactPreview<MenuManifestPlan>>
scoped.menus.manifest.import(input: MenuManifestInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
scoped.menus.manifest.export(): Promise<VersionedResult<FrontendMenuManifest>>
scoped.menus.manifest.exportPage(query?: CursorQuery & { kind?: MenuManifestExportRecord['kind'] }): Promise<PageResult<MenuManifestExportRecord>>
```

`update` covers presentation-only fields. Path/name/code/url/permission/data-permission changes use `previewUpdate`. Move, reorder, status, removal, repair, and manifest import also require preview execution.

## Responses and side effects

Writes return the resulting node or batch summary plus revision/audit/cache evidence. Manifest export returns `schemaVersion: 2`, ordered `nodes`, and `apiBindings`; it is a portable frontend/admin snapshot, not an authorization decision.

```json
{
  "data": {
    "id": "orders",
    "parentId": null,
    "type": "page",
    "title": "Orders",
    "path": "/orders",
    "name": "orders",
    "component": "OrdersPage",
    "permission": { "action": "read", "resource": "ui:page:orders" },
    "status": "enabled",
    "hidden": false,
    "revision": 1
  },
  "operationId": "operation_...",
  "auditId": "audit_..."
}
```

## Failures and limits

Important errors are `MENU_NOT_FOUND`, `MENU_ALREADY_EXISTS`, `MENU_HIERARCHY_INVALID`, `DEPENDENCY_EXISTS`, `STALE_REFERENCE`, `REVISION_CONFLICT`, and `PREVIEW_STALE`. A scope supports up to `10000` nodes, tree depth `64`, and runtime projection `5000` nodes. Cascades and source rewrites remain bounded and must be explicit.

## Example

```ts
const created = await scoped.menus.create({
  id: 'orders', type: 'page', title: 'Orders', path: '/orders',
  name: 'orders', component: 'OrdersPage',
  permission: { action: 'read', resource: 'ui:page:orders' },
});
const tree = await scoped.menus.getTree();
```

```json
{ "created": "orders", "treeRoots": ["orders"] }
```

## Related

See [Manage Menus](/guide/menu-management), [API Bindings](/api/api-bindings), and [Role Menu Permissions](/api/role-menu-permissions).
