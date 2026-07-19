# 角色 API

## 用途与前置条件

`scoped.roles` 管理租户 scope 内的角色、层级、手工规则、影响预览和有效权限读取。角色最多有一个父角色。全部 ID 与规则只在当前上下文的完整 scope 内有意义。

## 签名

```ts
create(input: RoleCreateInput, options?: MutationOptions): Promise<MutationResult<Role>>
get(roleId: string): Promise<VersionedResult<Role>>
list(query?: CursorQuery & { status?: EntityStatus; search?: string; parentId?: string | null }): Promise<PageResult<Role>>
update(roleId: string, patch: RoleUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<Role>>
previewAccessUpdate(roleId: string, patch: RoleAccessUpdateInput, options?: PreviewOptions): Promise<ImpactPreview<RoleAccessUpdatePlan>>
executeAccessUpdate(roleId: string, patch: RoleAccessUpdateInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<Role>>
getRemovalImpact(roleId: string): Promise<VersionedResult<RoleRemovalImpact>>
remove(roleId: string, options: RequiredRevisionOptions): Promise<MutationResult<{ removedRoleId: string }>>
allow(roleId: string, rule: PermissionRuleInput, options?: MutationOptions): Promise<MutationResult<PermissionRuleView>>
deny(roleId: string, rule: PermissionRuleInput, options?: MutationOptions): Promise<MutationResult<PermissionRuleView>>
revoke(roleId: string, selector: ManualRuleSelector, options?: MutationOptions): Promise<MutationResult<{ removed: number; remainingCount: number; remainingDigest: string }>>
previewRuleChange(roleId: string, change: ManualRuleChange, options?: PreviewOptions): Promise<ImpactPreview<ManualRuleChangePlan>>
executeRuleChange(roleId: string, change: ManualRuleChange, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ManualRuleChangeResult>>
previewReplaceRules(roleId: string, rules: readonly ManualRuleInput[], options?: PreviewOptions): Promise<ImpactPreview<RoleRuleReplacePlan>>
replaceRules(roleId: string, rules: readonly ManualRuleInput[], options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
getOwnRules(roleId: string): Promise<VersionedResult<PermissionRuleView[]>>
listOwnRules(roleId: string, query?: CursorQuery & { effect?: 'allow' | 'deny'; sourceKind?: 'manual' | 'menu' }): Promise<PageResult<PermissionRuleView>>
getEffectiveRules(roleId: string): Promise<VersionedResult<EffectiveRoleRules>>
getChain(roleId: string): Promise<VersionedResult<RoleChainEntry[]>>
```

`update` 只修改 label/description。状态或父角色变更使用 `previewAccessUpdate` 加 `executeAccessUpdate`。完整规则替换始终使用 preview/execute。

## 响应与副作用

读取返回 `data`、revision vector、`etag` 和 detail budget。写入提交角色/规则状态及审计证据，并返回 operation/audit ID。`allow`/`deny` 给规范语义规则添加手工来源；等价菜单来源仍可独立追踪。

```json
{
  "committed": true,
  "changed": true,
  "data": { "id": "order-reader", "status": "enabled", "parentId": null, "revision": 1 },
  "revision": 1,
  "operationId": "operation_...",
  "auditId": "audit_...",
  "replayed": false,
  "cache": { "status": "completed" }
}
```

## 失败与限制

重要错误包括 `ROLE_NOT_FOUND`、`ROLE_ALREADY_EXISTS`、`ROLE_IN_USE`、`CIRCULAR_INHERITANCE`、`REVISION_CONFLICT`、`PREVIEW_REQUIRED`、`PREVIEW_STALE`、`LIMIT_EXCEEDED`。限制包括单父角色、层级深度 `32`、每角色 `2048` 条规则及有界有效快照。replace 最多接受 `2048` 条规则。

## 示例

```ts
const created = await scoped.roles.create({ id: 'operator', label: 'Operator' });
await scoped.roles.allow('operator', { action: 'read', resource: 'db:orders' });
const own = await scoped.roles.getOwnRules('operator');
```

```json
{
  "createdRevision": 1,
  "ownRules": [{ "effect": "allow", "action": "read", "resource": "db:orders" }]
}
```

## 相关内容

参见[角色继承](/zh/guide/role-inheritance)、[用户角色 API](/zh/api/user-roles)和[角色菜单权限 API](/zh/api/role-menu-permissions)。
