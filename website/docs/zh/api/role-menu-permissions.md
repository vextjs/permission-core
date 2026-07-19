# 角色菜单权限 API

## 用途与前置条件

`scoped.roles.menuPermissions` 将管理员的菜单选择转换为持久化、可追踪来源的角色规则。角色、所选节点、API binding 和数据模板必须位于同一 scope。grant、deny、revoke、set 或 repair 执行前都要先 preview。

## 签名

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

Preview 使用 `MenuPermissionChange`，其 `operation` 为 `'grant' | 'deny' | 'revoke' | 'set'`。availability 或 authorization 使用 `any` 时，必须通过 `apiChoices` 解决 `choiceRequirements`。

## 响应与副作用

Grant/deny 记录管理员意图与 contribution snapshot，然后为所选节点、API 和数据模板创建规范角色规则来源。有效读取保留来源角色、继承深度、integrity、availability 和 drift。

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

## 失败与限制

未解决 choice 时 preview 不可执行。陈旧资产或 contribution 变化表现为 `STALE_REFERENCE` 或 invalid/drifted source state，不会静默刷新。角色/菜单容量、`1000` 项选择/变更边界、`20000` 个直接 grant 以及 revision/preview 检查都适用。

## 示例

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

可执行分支会在读取 preview token 与 expected revisions 前完成类型收窄。

## 相关内容

参见[角色菜单授权](/zh/guide/role-menu-authorization)、[菜单 API](/zh/api/menus)和[接口绑定 API](/zh/api/api-bindings)。
