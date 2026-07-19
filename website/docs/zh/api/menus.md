# 菜单 API

## 用途与前置条件

`scoped.menus` 管理租户 scope 内的菜单树及其前端 manifest。节点描述导航/UI 资产，不替代后端授权。结构或权限承载字段发生变化、且可能影响已有角色生成来源时，应使用影响预览。

## 签名

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

`update` 只覆盖展示字段。path/name/code/url/permission/data-permission 变更使用 `previewUpdate`。移动、排序、状态、移除、修复和 manifest import 同样要求 preview execution。

## 响应与副作用

写入返回结果节点或 batch summary，并包含 revision/audit/cache 证据。Manifest export 返回 `schemaVersion: 2`、有序 `nodes` 和 `apiBindings`；它是可移植前端/管理快照，不是授权判断。

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

## 失败与限制

重要错误包括 `MENU_NOT_FOUND`、`MENU_ALREADY_EXISTS`、`MENU_HIERARCHY_INVALID`、`DEPENDENCY_EXISTS`、`STALE_REFERENCE`、`REVISION_CONFLICT`、`PREVIEW_STALE`。一个 scope 最多支持 `10000` 个节点，树深度 `64`，运行时投影 `5000` 个节点。级联和来源重写保持有界，并且必须显式声明。

## 示例

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

## 相关内容

参见[管理菜单](/zh/guide/menu-management)、[接口绑定 API](/zh/api/api-bindings)和[角色菜单权限 API](/zh/api/role-menu-permissions)。
