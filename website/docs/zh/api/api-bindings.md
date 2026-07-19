# 接口绑定 API

## 用途与前置条件

`scoped.apiBindings` 描述后端 API 契约、授权要求及其所属菜单/页面/按钮。绑定参与菜单可用性和角色菜单授权；每个 endpoint 仍必须在后端执行授权。

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
