# 接口绑定 API

## 用途与前置条件

`scoped.apiBindings` 描述后端 API 契约、授权要求及其所属菜单/页面/按钮。绑定参与菜单可用性和角色菜单授权；每个 endpoint 仍必须在后端执行授权。

## 我想做什么

| 目标 | 从这里开始 |
|---|---|
| 创建或读取绑定 | [`create()`](#api-bindings-create)、[`get()`](#api-bindings-get)、[`list()`](#api-bindings-list) |
| 修改展示字段 | [`update()`](#api-bindings-update) |
| 改变状态 | [`previewSetStatus()`](#api-bindings-preview-set-status) 后 [`setStatus()`](#api-bindings-set-status) |
| 修改结构 | [`previewUpdate()`](#api-bindings-preview-update) 后 [`executeUpdate()`](#api-bindings-execute-update) |
| 安全删除 | [`getRemovalImpact()`](#api-bindings-get-removal-impact) 与 [`previewRemove()`](#api-bindings-preview-remove) |
| 全量替换 | [`previewReplace()`](#api-bindings-preview-replace) 后 [`replace()`](#api-bindings-replace) |

## 签名

```ts
create(input: ApiBindingCreateInput, options?: MutationOptions): Promise<MutationResult<ApiBinding>>
get(bindingId: string): Promise<VersionedResult<ApiBinding>>
list(query?: CursorQuery & ApiBindingFilter): Promise<PageResult<ApiBinding>>
update(bindingId: string, patch: ApiBindingUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<ApiBinding>>
previewSetStatus(bindingId: string, status: EntityStatus, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingStatusPlan>>
setStatus(bindingId: string, status: EntityStatus, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ApiBinding>>
getRemovalImpact(bindingId: string): Promise<VersionedResult<ApiBindingImpact>>
previewUpdate(bindingId: string, request: ApiBindingImpactUpdateRequest, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingRewritePlan>>
executeUpdate(bindingId: string, request: ApiBindingImpactUpdateRequest, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ApiBinding>>
previewRemove(bindingId: string, input: ApiBindingRemoveInput, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingRemovalPlan>>
remove(bindingId: string, input: ApiBindingRemoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
previewReplace(input: ApiBindingReplaceInput, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingReplacePlan>>
replace(input: ApiBindingReplaceInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
```

`update` 只修改 purpose/description。method/path/authorization/owners/canonical owner 使用影响型 `previewUpdate` 加 `executeUpdate`，因为角色生成来源可能需要显式替换或撤销。

## 参数对象

<!-- docs:params owner=ApiBindingCreateInput locale=zh -->

### `ApiBindingCreateInput`

| 字段 | 类型 | 必填/默认 | 作用与约束 |
|---|---|---|---|
| `id` | `string` | 必填 | 当前 scope 内稳定且唯一的 binding ID。 |
| `method` | `string` | 必填 | HTTP 方法；会去空格并规范为大写，例如 `post` 保存为 `POST`。 |
| `path` | `string` | 必填 | 后端声明路径，例如 `/api/orders/:id`；它与 method 一起描述 endpoint。 |
| `purpose` | `entry \| lookup \| detail \| operation \| importExport \| background` | 必填 | 标记接口在页面流程中的用途，供管理端和审计使用，不改变授权算法。 |
| `authorization.mode` | `all \| any` | 必填 | `all` 要求 permissions 全部满足；`any` 要求至少一项满足。 |
| `authorization.permissions` | `{ action, resource }[]` | 至少 1 项 | endpoint 真正要求的后端权限。每个接口处理器仍需执行对应 `can/assert`。 |
| `owners` | `ApiOwnerRelation[]` | 默认 `[]` | 把接口关联到 menu/page/button 资产，用于菜单可用性与菜单授权展开。 |
| `canonicalOwner` | `{ type, id }` | 可选 | binding 的主要归属；必须同时存在于 `owners`。 |
| `status` | `enabled \| disabled \| deprecated` | 默认 `enabled` | 非 enabled binding 不应作为活动接口贡献。后续修改走状态预览。 |
| `description` | `string` | 可选 | 管理说明，不参与判定。 |

<!-- docs:params owner=ApiOwnerRelation locale=zh -->

### `ApiOwnerRelation`

| 字段 | 必填 | 含义 |
|---|---|---|
| `type` / `id` | 是 | 被关联资产的类型和 ID；类型只能是 `menu/page/button`，资产必须位于同一 scope。 |
| `required` | 是 | `true` 表示接口会影响该资产可用性；`false` 只记录关系。 |
| `availabilityGroup` / `availabilityMode` | 成对可选 | 仅 `required=true` 可用。相同 group 的接口按 `all` 全满足或 `any` 至少一个满足来决定资产可用性。 |

`authorization.mode` 回答“一个接口需要哪些权限”；owner 的 `availabilityMode` 回答“一个菜单资产依赖哪些接口可用”。两者层级不同，不能互换。`canonicalOwner` 只标记主归属，也不会替代 `owners`。

<!-- docs:params owner=ApiBindingMutationInputs locale=zh -->

| 参数对象 | 字段 | 语义 |
|---|---|---|
| `ApiBindingFilter` | `method/path/status/purpose/ownerId` 加 `first/after` | `list()` 的精确过滤和游标分页。 |
| `ApiBindingImpactUpdateRequest` | `patch`、可选 `sourceRewrite` | patch 可改 method/path/authorization/owners/canonicalOwner 等影响字段。默认拒绝未解决的来源影响。 |
| `ApiBindingRemoveInput` | 可选 `sourceRewrite` | 删除本体前必须处理由该 binding 生成的角色来源。 |
| `ApiBindingReplaceInput` | `bindings`、可选 `sourceRewrite` | 把 `bindings` 当作 scope 的**完整目标 binding 清单**；未声明的现有 binding 会进入删除计划。 |

预览/执行 options 和原始 envelope 见[核心与上下文 API](/zh/api/core-and-contexts#common-response-contracts)。

## 方法详解：创建与读取绑定

<span id="api-bindings-create"></span>
### `create(input, options?)`

<!-- docs:method name=apiBindings.create locale=zh -->

- **用途**：登记一个后端 endpoint、授权要求及菜单资产归属。
- **参数**：完整 `ApiBindingCreateInput`；owner 引用在写入前校验。
- **状态影响**：新增 binding 并推进 revision；不自动给任何角色授予权限。
- **原始返回**：`MutationResult<ApiBinding>`，规范化后的 method/path 和完整关系位于 `data`。
- **常见失败**：ID 重复、owner 不存在、权限资源无效、authorization 为空或容量超限。

<span id="api-bindings-get"></span>
### `get(bindingId)`

<!-- docs:method name=apiBindings.get locale=zh -->

- **用途**：读取单个 binding 的完整持久化契约。
- **参数**：当前 scope 内 binding ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<ApiBinding>`；影响型更新前用 `data.revision` 作为当前状态依据。

<span id="api-bindings-list"></span>
### `list(query?)`

<!-- docs:method name=apiBindings.list locale=zh -->

- **用途**：为接口管理列表按 endpoint、状态、用途或 owner 分页查询。
- **参数**：过滤字段加 `first/after`；`first` 默认 `50`、最大 `200`。
- **状态影响**：只读。
- **原始返回**：`PageResult<ApiBinding>`；下一页使用 `endCursor`。

<span id="api-bindings-update"></span>
## 方法详解：直接修改展示字段

### `update(bindingId, patch, options)`

<!-- docs:method name=apiBindings.update locale=zh -->

- **用途**：只修改不改变授权贡献的 `purpose` 或 `description`。
- **参数**：非空 patch 和必填 `expectedRevision`。
- **状态影响**：更新 binding 并推进 revision，不改 endpoint、权限或 owner。
- **原始返回**：`MutationResult<ApiBinding>`；revision 过期时返回 `REVISION_CONFLICT`。

<span id="api-bindings-preview-set-status"></span>
## 方法详解：改变状态

### `previewSetStatus(bindingId, status, options?)`

<!-- docs:method name=apiBindings.previewSetStatus locale=zh -->

- **用途**：预览启用、禁用或废弃 binding 对生成来源、角色和用户的影响。
- **参数**：binding ID 与目标状态。
- **状态影响**：不写入。
- **原始返回**：`ImpactPreview<ApiBindingStatusPlan>`，检查 before/after 以及 affectedSources/roles/users。

<span id="api-bindings-set-status"></span>
### `setStatus(bindingId, status, options)`

<!-- docs:method name=apiBindings.setStatus locale=zh -->

- **用途**：执行已确认的状态切换。
- **参数**：与预览一致的 ID/status，以及预览 `expected/previewToken`。
- **状态影响**：改变 binding 可用性；保留历史来源但可能使其 inactive。
- **原始返回**：`MutationResult<ApiBinding>`；预览过期则不写入。

<span id="api-bindings-get-removal-impact"></span>
## 方法详解：修改结构与安全删除

### `getRemovalImpact(bindingId)`

<!-- docs:method name=apiBindings.getRemovalImpact locale=zh -->

- **用途**：快速查看 owner 关系、角色来源及是否可直接移除。
- **参数**：待删 binding ID。
- **状态影响**：只读，不生成执行 token。
- **原始返回**：`VersionedResult<ApiBindingImpact>`；删除仍必须经过 `previewRemove/remove`。

<span id="api-bindings-preview-update"></span>
### `previewUpdate(bindingId, request, options?)`

<!-- docs:method name=apiBindings.previewUpdate locale=zh -->

- **用途**：预览 method/path/authorization/owners/canonicalOwner 等契约变化。
- **参数**：`request.patch` 至少一个字段；`sourceRewrite` 明确处理受影响角色来源。
- **状态影响**：不写入。
- **原始返回**：`ImpactPreview<ApiBindingRewritePlan>`，包含 before/after 与逐来源影响。

<span id="api-bindings-execute-update"></span>
### `executeUpdate(bindingId, request, options)`

<!-- docs:method name=apiBindings.executeUpdate locale=zh -->

- **用途**：执行已预览确认的 binding 契约更新。
- **参数**：ID/request 必须与预览相同；options 带 revision vector 与 token。
- **状态影响**：更新 binding，并按决策替换或撤销旧生成来源。
- **原始返回**：`MutationResult<ApiBinding>`；不能用普通 `update()` 绕过来源影响检查。

<span id="api-bindings-preview-remove"></span>
### `previewRemove(bindingId, input, options?)`

<!-- docs:method name=apiBindings.previewRemove locale=zh -->

- **用途**：预览删除 binding、脱离 owners 和处理角色来源的完整计划。
- **参数**：binding ID；`input.sourceRewrite` 对每个受影响来源选择 replace/revoke，或保持默认 reject。
- **状态影响**：不删除。
- **原始返回**：`ImpactPreview<ApiBindingRemovalPlan>`，重点检查 `detachedOwners/sourceImpacts/executable`。

<span id="api-bindings-remove"></span>
### `remove(bindingId, input, options)`

<!-- docs:method name=apiBindings.remove locale=zh -->

- **用途**：执行已确认的 binding 删除。
- **参数**：与预览一致的 ID/input 和 `expected/previewToken`。
- **状态影响**：删除 binding、解除 owner 关系并按方案处理来源。
- **原始返回**：`MutationResult<BatchMutationSummary>`；它返回批量结果，不返回已删除 binding。

<span id="api-bindings-preview-replace"></span>
## 方法详解：全量替换

### `previewReplace(input, options?)`

<!-- docs:method name=apiBindings.previewReplace locale=zh -->

- **用途**：把一份完整 binding 清单与当前 scope 比较，统一预览新增、更新、删除和不变项。
- **参数**：`input.bindings` 是完整目标集合；删除/授权变化牵涉来源时还需 `sourceRewrite`。
- **状态影响**：不写入。
- **原始返回**：`ImpactPreview<ApiBindingReplacePlan>`，`operations` 给出 insert/update/delete，`unchanged` 单独计数。

<span id="api-bindings-replace"></span>
### `replace(input, options)`

<!-- docs:method name=apiBindings.replace locale=zh -->

- **用途**：原子执行已预览的完整 binding 集合替换。
- **参数**：原始 input、revision vector 与 preview token。
- **状态影响**：批量增删改 binding，并执行已确认的来源重写；原子 mutation 总量受 `1000` 限制。
- **原始返回**：`MutationResult<BatchMutationSummary>`；并发变化或 input 差异会触发 `PREVIEW_STALE`。

## 响应与副作用

绑定会规范化 method/path，校验 `all`/`any` authorization，解析 owner 关系并返回 mutation envelope。状态与契约重写提交后，可能改变角色生成来源及主体菜单可用性。

```json
{
  "data": {
    "id": "orders-export-api",
    "method": "POST",
    "path": "/api/orders/export",
    "purpose": "importExport",
    "authorization": {
      "mode": "all",
      "permissions": [{ "action": "invoke", "resource": "api:POST:/api/orders/export" }]
    },
    "owners": [{ "type": "button", "id": "orders-export", "required": true }],
    "status": "enabled",
    "revision": 1
  }
}
```

## 失败与限制

重要错误包括 `API_BINDING_NOT_FOUND`、`API_BINDING_ALREADY_EXISTS`、`DEPENDENCY_EXISTS`、`STALE_REFERENCE`、`REVISION_CONFLICT`、`PREVIEW_STALE`。一个 scope 最多支持 `20000` 个 binding。Authorization 至少包含一个有效权限；owner 和 availability-group 关系必须引用有效菜单资产。

## 示例

以下示例假设同一 scope 中已经存在 `orders-export` 按钮节点；创建 binding 时会校验 owner 引用。

```ts
const binding = await scoped.apiBindings.create({
  id: 'orders-export-api', method: 'POST', path: '/api/orders/export',
  purpose: 'importExport',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:POST:/api/orders/export' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
});
```

```json
{ "bindingId": "orders-export-api", "changed": true }
```

## 相关内容

参见[绑定接口](/zh/guide/api-bindings)、[菜单 API](/zh/api/menus)和[角色菜单权限 API](/zh/api/role-menu-permissions)。
