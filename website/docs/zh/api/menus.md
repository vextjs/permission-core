# 菜单 API

## 用途与前置条件

`scoped.menus.config` 管理一套后台菜单配置，公开入口是 `MenuConfigInput`。它把菜单、页面、加载接口、按钮接口和响应字段保存为可授权的配置快照。`subject.menus` 是用户运行时入口，用同一套配置投影当前用户可见视图、按钮状态、页面状态和接口响应字段。

使用前需要完成：

- `pc.init()` 已成功。
- 已通过 `pc.scope(scope)` 获取可信 scope 下的管理上下文。
- 需要运行时投影时，已通过 `pc.forSubject({ userId, scope })` 获取当前用户上下文。

## 我想做什么

| 目标 | 首选 API | 说明 |
|---|---|---|
| 预览菜单配置 | `menus.config.preview(config, options?)` | 保存前校验菜单、页面、接口、响应字段、容量和冲突。 |
| 保存菜单配置 | `menus.config.save(config, options)` | 用预览返回的 `expected` 和 `previewToken` 提交配置。 |
| 读取配置 | `menus.config.get(configId)` / `menus.config.list(query?)` | 管理后台详情页和列表页使用。 |
| 删除配置 | `menus.config.previewRemove(configId)` / `menus.config.remove(configId, options)` | 先预览删除影响，再安全撤销已删除来源。 |
| 批量变更 | `menus.config.previewChanges(changes)` / `menus.config.applyChanges(changes, options)` | 多个配置共享同一 endpoint 且必须原子调整时使用。 |
| 投影用户菜单 | `subject.menus.getViewTree()`、`getActionMap()`、`getViewState()`、`filterResponse()` | 请求期读取有效授权，返回 UI 状态或响应字段投影。 |

## 签名

```ts
menus.config.preview(config: MenuConfigInput, options?: MenuConfigPreviewOptions): Promise<ImpactPreview<MenuConfigPlan>>
menus.config.save(config: MenuConfigInput, options: MenuConfigSaveOptions): Promise<MutationResult<MenuConfigSaveResult>>
menus.config.get(configId: string): Promise<VersionedResult<MenuConfigSnapshot>>
menus.config.list(query?: MenuConfigListQuery): Promise<PageResult<MenuConfigSummary>>
menus.config.previewRemove(configId: string, options?: MenuConfigPreviewOptions): Promise<ImpactPreview<MenuConfigRemovePlan>>
menus.config.remove(configId: string, options: MenuConfigRemoveOptions): Promise<MutationResult<MenuConfigRemoveResult>>
menus.config.previewChanges(changes: NonEmptyMenuConfigChangeArray, options?: MenuConfigPreviewOptions): Promise<ImpactPreview<MenuConfigChangeSetPlan>>
menus.config.applyChanges(changes: NonEmptyMenuConfigChangeArray, options: MenuConfigChangeSetOptions): Promise<MutationResult<MenuConfigChangeSetResult>>

subject.menus.getViewTree(options: { configId: string }): Promise<SubjectRuntimeResult<readonly ViewTreeNode[]>>
subject.menus.getActionMap(input: { configId: string; viewId: string }): Promise<SubjectRuntimeResult<Readonly<Record<string, ActionPermissionState>>>>
subject.menus.getViewState(input: { configId: string; viewId: string } | { path: string }): Promise<SubjectRuntimeResult<ViewPermissionState>>
subject.menus.filterResponse(apiResource: ApiResource, payload: unknown): Promise<SubjectRuntimeResult<unknown>>
```

关键参数标记：`config: MenuConfigInput`，`options: MenuConfigSaveOptions`，`changes: NonEmptyMenuConfigChangeArray`。

## 参数对象

<!-- docs:params owner=MenuConfigInput locale=zh -->

### `MenuConfigInput`

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `configId` | `string` | 必填 | 一套菜单配置的稳定 ID，后续授权和运行时读取都用它。 |
| `title` | `string` | 可选 | 管理端展示名。 |
| `menus` | `MenuConfigMenuInput[]` | 必填，至少 1 项 | 顶层菜单分组或菜单项。 |
| `meta` | `Record<string, PolicyValue>` | 可选 | 透传给管理端或前端的可序列化元数据。 |

### `MenuConfigMenuInput`

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `id` | `string` | 必填 | 当前配置内稳定唯一的菜单 ID。 |
| `title` | `string` | 必填 | 菜单标题。 |
| `children` | `MenuConfigMenuInput[]` | 可选 | 子菜单。 |
| `views` | `MenuViewInput[]` | 可选 | 该菜单下可进入的页面、抽屉、弹窗或 tab。 |
| `navigation` | `boolean` | 默认 `true` | 是否出现在导航树。 |
| `enabled` | `boolean` | 默认 `true` | 是否启用。 |
| `icon/i18nKey/meta` | 展示元数据 | 可选 | 供前端消费，不参与授权判断。 |

### `MenuViewInput`

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `id` | `string` | 必填 | 当前配置内稳定唯一的视图 ID。 |
| `type` | `page/dialog/drawer/tab/...` | 必填 | 视图类型。 |
| `title` | `string` | 必填 | 视图标题。 |
| `path` | `string` | 页面常用 | 前端路由路径；也可用 `{ path }` 调用 `getViewState()`。 |
| `component/url` | `string` | 按类型 | 前端组件或外部地址。 |
| `load` | `MenuLoadInput[]` | 默认 `[]` | 页面进入时需要调用的接口。 |
| `actions` | `MenuActionInput[]` | 默认 `[]` | 页面按钮或操作。 |
| `navigation/enabled/i18nKey/meta` | 视图元数据 | 可选 | 控制导航展示和前端附加信息。 |

`load.resource: ApiResource` 必须形如 `api:GET:/api/orders`。`actions[].resource: ApiResource | UiResource` 可指向后端接口或前端 UI 能力。`response?: ResponseProjectionConfigInput` 可写在 `load` 或 `actions` 上，详见[配置接口与响应字段 API](/zh/api/api-bindings)。

## 方法详解：配置管理

<span id="menus-config-preview"></span>
### `menus.config.preview(config, options?)`

<!-- docs:method name=menus.config.preview locale=zh -->

- **用途**：在保存前校验菜单配置，并预览内部菜单、接口、响应字段和已有角色授权的影响。
- **参数**：`config` 是完整 `MenuConfigInput`；`options` 可带 `actorId/reason/detailBudget`。
- **状态影响**：只读，不写入配置。
- **原始返回**：`ImpactPreview<MenuConfigPlan>`；重点读取 `executable`、`conflicts`、`plan.after`、`expected` 和 `previewToken`。

<span id="menus-config-save"></span>
### `menus.config.save(config, options)`

<!-- docs:method name=menus.config.save locale=zh -->

- **用途**：提交已预览的菜单配置。
- **参数**：`config` 必须与预览一致；`options` 必须包含 `expected`、`previewToken`，可选 `actorId/idempotencyKey`。
- **状态影响**：写入 `_menu_configs`，同步内部菜单节点、接口契约和响应字段索引，并处理受影响角色来源。
- **原始返回**：`MutationResult<MenuConfigSaveResult>`；配置快照在 `data.config`，内部写入摘要在 `data.manifestOperations`。

<span id="menus-config-get"></span>
### `menus.config.get(configId)`

<!-- docs:method name=menus.config.get locale=zh -->

- **用途**：读取指定配置的最新快照。
- **参数**：`configId` 为配置 ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<MenuConfigSnapshot>`；`data.revision` 可作为管理端展示的版本信息。

<span id="menus-config-list"></span>
### `menus.config.list(query?)`

<!-- docs:method name=menus.config.list locale=zh -->

- **用途**：分页读取当前 scope 下的菜单配置摘要。
- **参数**：`query` 可带 `configId/first/after`。
- **状态影响**：只读。
- **原始返回**：`PageResult<MenuConfigSummary>`；摘要包含 `menuCount/viewCount/actionCount/responseFieldCount`。

<span id="menus-config-preview-remove"></span>
### `menus.config.previewRemove(configId, options?)`

<!-- docs:method name=menus.config.previewRemove locale=zh -->

- **用途**：预览删除一套菜单配置会移除哪些资产和角色授权。
- **参数**：`configId` 和可选预览上下文。
- **状态影响**：只读，不删除。
- **原始返回**：`ImpactPreview<MenuConfigRemovePlan>`；重点检查 `removedAssets`、`revokedGrants`、`affectedRoles` 和 `affectedUsers`。

<span id="menus-config-remove"></span>
### `menus.config.remove(configId, options)`

<!-- docs:method name=menus.config.remove locale=zh -->

- **用途**：执行已预览的配置删除。
- **参数**：`configId` 必须与预览一致；`options` 带 `expected/previewToken`。
- **状态影响**：删除配置快照、同步移除内部资产，并撤销依赖该配置的菜单授权。
- **原始返回**：`MutationResult<MenuConfigRemoveResult>`。

<span id="menus-config-preview-changes"></span>
### `menus.config.previewChanges(changes, options?)`

<!-- docs:method name=menus.config.previewChanges locale=zh -->

- **用途**：一次预览多套配置的保存或删除。
- **参数**：`changes: NonEmptyMenuConfigChangeArray`，每项是 `{ operation: 'save', config }` 或 `{ operation: 'remove', configId }`。
- **状态影响**：只读。
- **原始返回**：`ImpactPreview<MenuConfigChangeSetPlan>`；用于插件安装、模块升级或批量导入前审查。

<span id="menus-config-apply-changes"></span>
### `menus.config.applyChanges(changes, options)`

<!-- docs:method name=menus.config.applyChanges locale=zh -->

- **用途**：原子提交已预览的批量配置变更。
- **参数**：原始 `changes` 加预览返回的 `expected/previewToken`。
- **状态影响**：批量保存/删除配置，并同步所有内部菜单与接口资产。
- **原始返回**：`MutationResult<MenuConfigChangeSetResult>`。

## 方法详解：用户运行时

<span id="subject-menus-get-view-tree"></span>
### `subject.menus.getViewTree(options)`

<!-- docs:method name=subject.menus.getViewTree locale=zh -->

- **用途**：返回当前用户在指定配置下可见的导航树。
- **参数**：`options.configId` 指定菜单配置。
- **状态影响**：只读；按当前用户有效角色和菜单授权投影。
- **原始返回**：`SubjectRuntimeResult<readonly ViewTreeNode[]>`；按钮不会作为树节点返回。

<span id="subject-menus-get-action-map"></span>
### `subject.menus.getActionMap(input)`

<!-- docs:method name=subject.menus.getActionMap locale=zh -->

- **用途**：返回某个视图下每个按钮或操作是否可见、是否可用以及原因。
- **参数**：`input.configId` 和 `input.viewId`。
- **状态影响**：只读。
- **原始返回**：`SubjectRuntimeResult<Record<string, ActionPermissionState>>`；对象键是 action ID。

<span id="subject-menus-get-view-state"></span>
### `subject.menus.getViewState(input)`

<!-- docs:method name=subject.menus.getViewState locale=zh -->

- **用途**：判断当前用户是否允许进入某个视图。
- **参数**：可传 `{ configId, viewId }`，也可传 `{ path }`。
- **状态影响**：只读。
- **原始返回**：`SubjectRuntimeResult<ViewPermissionState>`；`allowed` 表示权限允许，`navigationReachable` 表示导航链路可达。

<span id="subject-menus-filter-response"></span>
### `subject.menus.filterResponse(apiResource, payload)`

<!-- docs:method name=subject.menus.filterResponse locale=zh -->

- **用途**：按当前用户的响应字段授权裁剪接口响应。
- **参数**：`apiResource` 是 `api:METHOD:/path`；`payload` 是准备返回给前端的数据。
- **状态影响**：只读，但会先检查当前用户是否能 `invoke` 该 `apiResource`。
- **原始返回**：`SubjectRuntimeResult<unknown>`；裁剪后的响应在 `data`。

## 响应与副作用

保存配置会产生 mutation envelope、审计 ID、revision、缓存失效结果和内部同步摘要。运行时方法不写入数据库，返回 `SubjectRuntimeResult<T>`，其中 `data` 是前端真正使用的数据，`detailBudget` 是诊断信息。

```json
{
  "changed": true,
  "data": {
    "config": { "configId": "admin", "revision": 1 },
    "manifestOperations": { "total": 3 },
    "retainedGrantCount": 0,
    "revokedGrantCount": 0
  },
  "auditId": "audit_..."
}
```

## 失败与限制

常见失败包括配置 ID 重复或缺失、资源格式无效、响应字段路径非法、预览 token 过期、revision 冲突和容量超限。`load.resource` 必须是 `api:` 资源；响应字段只能引用配置里声明过的字段。保存配置不会自动给任何角色或用户授权。

## 示例

```ts
const menuConfig = {
  configId: 'admin',
  menus: [{
    id: 'orders',
    title: 'Orders',
    views: [{
      id: 'orders-list',
      type: 'page',
      title: 'Orders',
      path: '/orders',
      component: 'OrdersPage',
      load: [{
        resource: 'api:GET:/api/orders',
        response: {
          target: 'items',
          preserve: ['total'],
          fields: [{ field: 'orderNo', title: '订单号' }],
        },
      }],
    }],
  }],
};

const preview = await scoped.menus.config.preview(menuConfig, { actorId: 'admin' });
if (!preview.executable) throw new Error('resolve menu config conflicts first');

const saved = await scoped.menus.config.save(menuConfig, {
  ...preview.expected,
  previewToken: preview.previewToken,
  actorId: 'admin',
});

const menus = pc.forSubject({ userId: 'u-menu', scope }).menus;
const tree = await menus.getViewTree({ configId: 'admin' });
const view = await menus.getViewState({ configId: 'admin', viewId: 'orders-list' });
const projected = await menus.filterResponse('api:GET:/api/orders', payload);
```

```json
{
  "tree": [{ "id": "orders", "enabled": true }],
  "view": { "allowed": true, "view": { "id": "orders-list" } },
  "projected": {
    "items": [{ "orderNo": "O-1001", "status": "paid" }],
    "total": 1
  }
}
```

## 相关内容

参见[管理菜单](/zh/guide/menu-management)、[配置接口与响应字段](/zh/guide/api-bindings)和[角色菜单权限 API](/zh/api/role-menu-permissions)。
