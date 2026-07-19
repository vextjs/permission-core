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

subject.menus.getVisibleTree(options?: { rootId?: string }): Promise<SubjectRuntimeResult<VisibleMenuTreeNode[]>>
subject.menus.getButtonMap(ownerNodeId: string): Promise<SubjectRuntimeResult<Readonly<Record<string, ButtonPermissionState>>>>
subject.menus.getRouteState(path: string): Promise<SubjectRuntimeResult<RoutePermissionState>>

scoped.menus.manifest.preview(input: MenuManifestInput, options?: PreviewOptions): Promise<ImpactPreview<MenuManifestPlan>>
scoped.menus.manifest.import(input: MenuManifestInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
scoped.menus.manifest.export(): Promise<VersionedResult<FrontendMenuManifest>>
scoped.menus.manifest.exportPage(query?: CursorQuery & { kind?: MenuManifestExportRecord['kind'] }): Promise<PageResult<MenuManifestExportRecord>>
```

`update` 只覆盖展示字段。path/name/code/url/permission/data-permission 变更使用 `previewUpdate`。移动、排序、状态、移除、修复和 manifest import 同样要求 preview execution。

## 参数对象

<!-- docs:params owner=MenuNodeCreateInput locale=zh -->

### `MenuNodeCreateInput`

| 字段 | 类型 | 必填/默认 | 作用与约束 |
|---|---|---|---|
| `id` | `string` | 必填 | 当前 scope 内稳定且唯一的节点 ID，创建后不可修改。 |
| `parentId` | `string \| null` | 默认 `null` | 父节点 ID；必须位于同一 scope，且不能形成循环或超过深度上限。 |
| `type` | `directory \| menu \| page \| button \| external \| iframe` | 必填 | 决定下表所需字段及节点在运行时树中的行为。 |
| `title` | `string` | 必填 | 管理端展示名称；多语言项目可同时提供 `i18nKey`。 |
| `path` | `string` | 按类型 | `menu/page/iframe` 必填；前端路由路径。 |
| `name` | `string` | 按类型 | `menu/page/iframe` 必填；稳定路由名。 |
| `component` | `string` | 按类型 | `page` 必填；页面组件标识。 |
| `code` | `string` | 按类型 | `button` 必填；按钮/操作代码。 |
| `url` | `string` | 按类型 | `external/iframe` 必填；目标 URL。 |
| `permission` | `{ action, resource }` | 除 `directory` 外按类型必填 | 节点自身的 UI 权限要求，不代替后端接口检查。 |
| `dataPermissions` | `MenuDataPermissionTemplate[]` | 默认 `[]` | 节点被角色选择时可贡献的数据规则模板。每项含 `action/resource`，可选 `where/label`。 |
| `status` | `enabled \| disabled \| deprecated` | 默认 `enabled` | 影响资产及其生成来源的可用状态。后续修改应走 `previewSetStatus/setStatus`。 |
| `hidden` | `boolean` | 默认 `false` | 只影响前端展示；隐藏不等于禁用或拒绝访问。 |
| `icon/i18nKey/meta` | 可选展示元数据 | 可选 | 供前端消费；`meta` 必须是可序列化策略值。 |

节点类型组合：`directory` 不允许 path/code/component/url；`menu` 需要 path/name/permission；`page` 还需要 component；`button` 需要 code/permission；`external` 需要 url/permission；`iframe` 需要 url/path/name/permission。

<!-- docs:params owner=MenuMutationInputs locale=zh -->

| 参数对象 | 字段 | 语义 |
|---|---|---|
| `MenuNodeFilter` | `parentId/type/status/hidden/search` 加 `first/after` | `list()` 的服务端过滤和游标分页；不传时读取首批全部类型。 |
| `MenuMoveInput` | `nodeId/parentId`，可选 `beforeId/afterId` | 移动节点并确定相对位置；`beforeId` 与 `afterId` 不能同时提供。 |
| `MenuReorderInput` | `parentId/orderedNodeIds` | 提交该父节点下**完整且无重复**的子节点顺序。 |
| `MenuNodeImpactUpdateRequest` | `patch`，可选 `sourceRewrite` | 修改会影响授权来源的字段；默认 `sourceRewrite.mode='reject'`，存在受影响来源时拒绝执行。 |
| `MenuRemoveInput` | `cascade/sourceRewrite?` | `cascade=false` 要求没有后代；`true` 才连同后代处理。来源重写仍需显式决策。 |
| `StaleRepairInput` | `referenceIds/resolutions` | 每个陈旧引用必须给出 `remove` 或 `rebind + replacementId`，两个键集合必须完全一致。 |
| `MenuManifestInput` | `schemaVersion: 2`、`mode`、`nodes`、`apiBindings`、可选 `sourceRewrite` | `merge` 只合并声明项；`replace` 把输入视为完整目标清单并预览缺失项删除。 |

所有 `preview*` 返回 preview token 与 revision vector；执行时必须原样传入对应 `expected` 和 `previewToken`。通用 envelope 字段见[核心与上下文 API 的响应契约](/zh/api/core-and-contexts#common-response-contracts)。

## 方法详解

<span id="menus-create"></span>
### `create(input, options?)`

<!-- docs:method name=menus.create locale=zh -->

- **用途**：在当前 scope 新建一个菜单资产，并按父节点现有顺序追加。
- **参数**：`input` 字段见上表；`options` 可携带操作者、原因、请求键和幂等键。
- **状态影响**：写入节点并推进 scope revision；创建时校验父节点、类型字段组合和权限资源。
- **原始返回**：`MutationResult<MenuNode>`；节点在 `data`，审计证据在 `operationId/auditId`。
- **常见失败**：ID 重复、父节点不存在、层级非法、字段组合无效或容量超限。

<span id="menus-get"></span>
### `get(nodeId)`

<!-- docs:method name=menus.get locale=zh -->

- **用途**：按 ID 读取单个节点的持久化状态。
- **参数**：`nodeId` 为当前 scope 内节点 ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<MenuNode>`；更新前使用 `data.revision`，不要把它当树结构。

<span id="menus-list"></span>
### `list(query?)`

<!-- docs:method name=menus.list locale=zh -->

- **用途**：为管理列表按父节点、类型、状态、隐藏标记或搜索词分页查询节点。
- **参数**：`query` 组合 `MenuNodeFilter` 与 `first/after`；`first` 默认 `50`、最大 `200`。
- **状态影响**：只读。
- **原始返回**：`PageResult<MenuNode>`；从 `items` 渲染，`hasNext` 为真时把 `endCursor` 传给下一次 `after`。

<span id="menus-get-tree"></span>
### `getTree(options?)`

<!-- docs:method name=menus.getTree locale=zh -->

- **用途**：一次读取用于管理展示的嵌套菜单树。
- **参数**：`rootId` 只返回指定节点及后代；`includeHidden` 决定是否包含 hidden 节点，默认不包含。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<MenuTreeNode[]>`，子节点位于各项 `children`；它不是某个用户的可见菜单投影。

<span id="menus-update"></span>
### `update(nodeId, patch, options)`

<!-- docs:method name=menus.update locale=zh -->

- **用途**：修改不改变授权贡献的展示字段：`title/component/icon/hidden/i18nKey/meta`。
- **参数**：`nodeId`、非空 `patch` 和必填 `options.expectedRevision`。
- **状态影响**：更新单节点并推进 revision；不会移动节点，也不会修改 permission/dataPermissions。
- **原始返回**：`MutationResult<MenuNode>`；revision 冲突时不写入，应重新读取后决定是否重试。

<span id="menus-preview-update"></span>
### `previewUpdate(nodeId, request, options?)`

<!-- docs:method name=menus.previewUpdate locale=zh -->

- **用途**：预览 path/name/code/url/permission/dataPermissions 等影响型字段变化。
- **参数**：`request.patch` 至少一个字段；受影响的角色来源通过 `sourceRewrite` 选择拒绝、替换或撤销。
- **状态影响**：不写数据库。
- **原始返回**：`ImpactPreview<MenuNodeUpdatePlan>`，重点检查 `plan.before/after`、`sourceImpacts`、`executable`、`expected` 与 `previewToken`。

<span id="menus-execute-update"></span>
### `executeUpdate(nodeId, request, options)`

<!-- docs:method name=menus.executeUpdate locale=zh -->

- **用途**：执行已确认的影响型字段更新。
- **参数**：`nodeId/request` 必须与预览一致；`options` 必须带预览返回的 revision vector 与 token。
- **状态影响**：更新节点，并按已确认方案替换或撤销受影响来源。
- **原始返回**：`MutationResult<MenuNode>`；预览过期或输入改变时返回 `PREVIEW_STALE`，必须重新预览。

<span id="menus-preview-move"></span>
### `previewMove(input, options?)`

<!-- docs:method name=menus.previewMove locale=zh -->

- **用途**：在写入前检查跨父节点移动、相对位置、后代数量与层级约束。
- **参数**：`nodeId/parentId` 必填，可选且互斥的 `beforeId/afterId` 必须属于目标兄弟集合。
- **状态影响**：只生成计划。
- **原始返回**：`ImpactPreview<MenuMovePlan>`，包含原/目标父节点和移动前后兄弟摘要。

<span id="menus-move"></span>
### `move(input, options)`

<!-- docs:method name=menus.move locale=zh -->

- **用途**：执行已预览的节点移动。
- **参数**：原始 `input` 加预览 `expected/previewToken`。
- **状态影响**：修改 parentId 和相关兄弟 order；会推进受影响 revision。
- **原始返回**：`MutationResult<MenuNode>`，`data` 是移动后的节点；并发树变化会使预览失效。

<span id="menus-preview-reorder"></span>
### `previewReorder(input, options?)`

<!-- docs:method name=menus.previewReorder locale=zh -->

- **用途**：验证同一父节点下的完整排序清单。
- **参数**：`parentId` 可为 `null`；`orderedNodeIds` 必须完整、无重复且都属于该父节点。
- **状态影响**：只读计划。
- **原始返回**：`ImpactPreview<MenuReorderPlan>`，`before/after` 是有界顺序摘要。

<span id="menus-reorder"></span>
### `reorder(input, options)`

<!-- docs:method name=menus.reorder locale=zh -->

- **用途**：提交已预览的兄弟节点完整顺序。
- **参数**：预览时的 `input`、revision vector 与 token。
- **状态影响**：批量更新 order。
- **原始返回**：`MutationResult<BatchMutationSummary>`，查看 changed/unchanged 等批量摘要，而不是期待返回整棵树。

<span id="menus-preview-set-status"></span>
### `previewSetStatus(nodeId, status, options?)`

<!-- docs:method name=menus.previewSetStatus locale=zh -->

- **用途**：预览启用、禁用或废弃节点对来源、角色和用户的影响。
- **参数**：节点 ID 与目标 `enabled/disabled/deprecated` 状态。
- **状态影响**：不写入。
- **原始返回**：`ImpactPreview<MenuStatusPlan>`；重点检查 `affectedSources/affectedRoles/affectedUsers`。

<span id="menus-set-status"></span>
### `setStatus(nodeId, status, options)`

<!-- docs:method name=menus.setStatus locale=zh -->

- **用途**：执行已确认的状态切换。
- **参数**：与预览相同的 ID/status，加 `expected/previewToken`。
- **状态影响**：修改节点状态；禁用/废弃会令相关贡献变为非活动状态，但不会删除授权历史。
- **原始返回**：`MutationResult<MenuNode>`。

<span id="menus-get-removal-impact"></span>
### `getRemovalImpact(nodeId)`

<!-- docs:method name=menus.getRemovalImpact locale=zh -->

- **用途**：快速判断删除前有多少后代、API 绑定和角色来源依赖。
- **参数**：待删除根节点 ID。
- **状态影响**：只读，也不生成可执行 token。
- **原始返回**：`VersionedResult<MenuRemovalImpact>`；真正删除仍必须调用 `previewRemove`。

<span id="menus-preview-remove"></span>
### `previewRemove(nodeId, input, options?)`

<!-- docs:method name=menus.previewRemove locale=zh -->

- **用途**：把级联删除、binding 脱离与来源重写展开为可审查计划。
- **参数**：`input.cascade` 必填；有来源影响时在 `sourceRewrite` 中逐项决策。
- **状态影响**：不删除数据。
- **原始返回**：`ImpactPreview<MenuRemovalPlan>`，检查 `nodes/detachedApiBindings/sourceImpacts` 是否符合预期。

<span id="menus-remove"></span>
### `remove(nodeId, input, options)`

<!-- docs:method name=menus.remove locale=zh -->

- **用途**：执行已预览的节点删除。
- **参数**：ID/input 必须与预览一致；options 带 revision vector 与 token。
- **状态影响**：删除目标及允许级联的后代，处理 owner 关系和来源决策。
- **原始返回**：`MutationResult<BatchMutationSummary>`；默认不会静默级联或猜测来源替换。

<span id="menus-find-stale-references"></span>
### `findStaleReferences(query?)`

<!-- docs:method name=menus.findStaleReferences locale=zh -->

- **用途**：分页发现指向缺失 parent 或 API owner 资产的结构陈旧引用。
- **参数**：可选 `first/after`。
- **状态影响**：只读。
- **原始返回**：`PageResult<StaleReference>`；每项给出引用类型、ID、相关资产和原因。

<span id="menus-preview-repair-stale-references"></span>
### `previewRepairStaleReferences(input, options?)`

<!-- docs:method name=menus.previewRepairStaleReferences locale=zh -->

- **用途**：预览删除或重新绑定指定陈旧引用的结果。
- **参数**：`referenceIds` 与 `resolutions` 键必须一一对应；rebind 还需 `replacementId`。
- **状态影响**：不写入。
- **原始返回**：`ImpactPreview<StaleRepairPlan>`，同时展示可能牵连的来源影响。

<span id="menus-repair-stale-references"></span>
### `repairStaleReferences(input, options)`

<!-- docs:method name=menus.repairStaleReferences locale=zh -->

- **用途**：执行已预览的结构引用修复。
- **参数**：原始 repair input、revision vector 与 preview token。
- **状态影响**：按计划移除/重绑引用，并处理已确认的来源影响。
- **原始返回**：`MutationResult<BatchMutationSummary>`。

<span id="subject-menus-get-visible-tree"></span>
### `subject.menus.getVisibleTree(options?)`

<!-- docs:method name=subject.menus.getVisibleTree locale=zh -->

- **用途**：按当前 subject 的有效权限生成可见导航树，并计算必需 API 的可用性。
- **参数**：可选 `rootId` 只投影指定子树；subject 已绑定 user/scope/claims。
- **状态影响**：只读；不会修改菜单或角色 grant。
- **原始返回**：`SubjectRuntimeResult<VisibleMenuTreeNode[]>`；每个节点含 `visible=true`、`enabled/reason/apiRisks/children`，button 不在此树中。
- **边界**：管理端完整树使用 `scoped.menus.getTree()`，不要把可见树用于编辑库存。

<span id="subject-menus-get-button-map"></span>
### `subject.menus.getButtonMap(ownerNodeId)`

<!-- docs:method name=subject.menus.getButtonMap locale=zh -->

- **用途**：读取某个 page/menu 下每个 button code 的可见、可用及 API 风险状态。
- **参数**：owner 节点 ID，不是 button ID。
- **状态影响**：只读。
- **原始返回**：`SubjectRuntimeResult<Record<string, ButtonPermissionState>>`；对象键是 button `code`，值含 `visible/enabled/reason/action/resource/apiRisks`。

<span id="subject-menus-get-route-state"></span>
### `subject.menus.getRouteState(path)`

<!-- docs:method name=subject.menus.getRouteState locale=zh -->

- **用途**：同时回答当前 subject 是否允许进入某路由，以及该路由在导航树中是否可达。
- **参数**：规范前端路由 path，例如 `/orders`。
- **状态影响**：只读。
- **原始返回**：`SubjectRuntimeResult<RoutePermissionState>`；业务守卫看 `data.allowed`，导航提示还要看 `data.navigationReachable/navigationReason`。

<span id="menus-manifest-preview"></span>
### `manifest.preview(input, options?)`

<!-- docs:method name=menus.manifest.preview locale=zh -->

- **用途**：预览一份 schema v2 菜单+API manifest 将对当前 scope 做出的全部差异。
- **参数**：`mode='merge'` 或 `'replace'`；replace 应提交完整目标清单。
- **状态影响**：不导入。
- **原始返回**：`ImpactPreview<MenuManifestPlan>`，分别列出 node/binding insert、update、delete、unchanged 和来源影响。

<span id="menus-manifest-import"></span>
### `manifest.import(input, options)`

<!-- docs:method name=menus.manifest.import locale=zh -->

- **用途**：原子执行已经预览确认的 manifest 计划。
- **参数**：与预览完全一致的 manifest、revision vector 与 token。
- **状态影响**：批量写节点和 bindings；replace 还会删除未声明项。
- **原始返回**：`MutationResult<BatchMutationSummary>`；输入或库存变化会触发 `PREVIEW_STALE`。

<span id="menus-manifest-export"></span>
### `manifest.export()`

<!-- docs:method name=menus.manifest.export locale=zh -->

- **用途**：导出当前 scope 的完整可移植前端 manifest。
- **参数**：无。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<FrontendMenuManifest>`，`data` 含 `schemaVersion: 2`、有序 `nodes/apiBindings`；大清单应使用分页方法。

<span id="menus-manifest-export-page"></span>
### `manifest.exportPage(query?)`

<!-- docs:method name=menus.manifest.exportPage locale=zh -->

- **用途**：对大 manifest 进行有界流式导出。
- **参数**：`first/after`，可用 `kind='node' | 'api-binding'` 过滤记录类型。
- **状态影响**：只读。
- **原始返回**：`PageResult<MenuManifestExportRecord>`；每项使用 `kind/value` 区分节点与 binding。

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
