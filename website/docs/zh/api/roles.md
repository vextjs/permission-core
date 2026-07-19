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

## 输入参数

共享的 `MutationOptions`、revision、preview token、分页和响应 envelope 见[核心与公共合同](/zh/api/core-and-contexts#common-response-contracts)。以下表只解释角色域字段。

<!-- docs:params owner=RoleCreateInput locale=zh -->

### `RoleCreateInput`

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|:---:|---|---|
| `id` | `string` | 是 | 无 | 角色稳定 ID；trim 后 1..128 bytes，不能使用控制字符、`__proto__`、`prototype`、`constructor`。 |
| `label` | `string` | 是 | 无 | 展示名称，trim 后 1..256 个字符。 |
| `description` | `string` | 否 | 不保存该字段 | 角色说明，最多 4096 个字符。 |
| `status` | `enabled \| disabled \| deprecated` | 否 | `enabled` | disabled/deprecated 角色不会作为有效授权来源。 |
| `parentId` | `string \| null` | 否 | `null` | 单父角色继承；父角色必须已在同一 scope 中存在。 |

### 规则与变更输入

<!-- docs:params owner=RoleRuleInputs locale=zh -->

| 类型/字段 | 必填 | 说明 |
|---|:---:|---|
| `PermissionRuleInput.action` | 是 | `read/invoke/...` 或 `*`；必须与资源 scheme 允许的 action 匹配。 |
| `PermissionRuleInput.resource` | 是 | 资源字符串或模式，例如 `GET:/api/orders`、`db:orders`。 |
| `PermissionRuleInput.where` | 否 | 行条件 AST，只对支持数据条件的资源使用；不是任意 JavaScript 函数。 |
| `RoleUpdateInput.label` | 否 | 修改展示名称；至少提供一个 patch 字段。 |
| `RoleUpdateInput.description` | 否 | 字符串更新；`null` 删除说明。 |
| `RoleAccessUpdateInput.status` | 否 | 通过 preview/execute 变更角色状态。 |
| `RoleAccessUpdateInput.parentId` | 否 | 新父角色 ID；`null` 取消继承。 |
| `ManualRuleSelector` | 是（revoke） | 用 `effect + action + resource + where?` 或精确 `semanticKey` 选择手工规则。 |
| `ManualRuleInput.effect` | 是（replace） | `allow` 或 `deny`，其余字段与 `PermissionRuleInput` 相同。 |

### 分页查询

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `first` | `number` | `50` | 每页 `1..200`。 |
| `after` | `string` | 无 | 上一页 `pageInfo.endCursor`；不要自行拼接。 |
| `status` | `EntityStatus` | 全部 | `list()` 的角色状态过滤。 |
| `search` | `string` | 无 | 按 ID/label 搜索，trim 后不能为空，最多 128 bytes。 |
| `parentId` | `string \| null` | 全部 | 指定父角色；`null` 表示仅根角色。 |
| `effect` | `allow \| deny` | 全部 | `listOwnRules()` 的规则效果过滤。 |
| `sourceKind` | `manual \| menu` | 全部 | `listOwnRules()` 的来源过滤。 |

## 方法详解

<span id="roles-create"></span>
### `create(input, options?)`

<!-- docs:method name=roles.create locale=zh -->

- **用途**：在当前 scope 创建一个角色；角色 ID 后续用于规则、用户绑定和菜单授权。
- **参数**：`input: RoleCreateInput` 必填；`options` 可传操作者、原因、request/idempotency key。
- **状态影响**：新增角色并推进 revision；若指定父角色会立即校验层级与循环。
- **原始返回**：`MutationResult<Role>`，使用 `data.id/status/parentId/revision` 与 `operationId/auditId`。
- **常见失败**：`ROLE_ALREADY_EXISTS`、`ROLE_NOT_FOUND`（父角色）、`CIRCULAR_INHERITANCE`、`LIMIT_EXCEEDED`。

<span id="roles-get"></span>
### `get(roleId)`

<!-- docs:method name=roles.get locale=zh -->

- **用途**：读取一个角色本身的 label、status、parentId 和 revision，不包含规则。
- **参数**：`roleId` 必填，是当前 scope 内的角色 ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<Role>`；后续 `update/remove` 使用 `data.revision` 作为 `expectedRevision`。
- **区别**：读取规则用 `getOwnRules/getEffectiveRules`，不要从 `get().data` 猜权限。

<span id="roles-list"></span>
### `list(query?)`

<!-- docs:method name=roles.list locale=zh -->

- **用途**：为角色列表页分页查询角色。
- **参数**：`query` 可传 `first/after/status/search/parentId`，见上表。
- **状态影响**：只读。
- **原始返回**：`PageResult<Role>`；渲染 `items`，`hasNext=true` 时继续使用 `endCursor`。

<span id="roles-update"></span>
### `update(roleId, patch, options)`

<!-- docs:method name=roles.update locale=zh -->

- **用途**：只修改角色 `label/description`。
- **参数**：`roleId`、`patch: RoleUpdateInput`、`options.expectedRevision` 均必填。
- **状态影响**：CAS 更新角色展示字段；不改变 status、parent 或规则。
- **原始返回**：`MutationResult<Role>`。
- **常见失败**：`ROLE_NOT_FOUND`、`REVISION_CONFLICT`；状态/父角色变更应使用下一组 preview/execute。

<span id="roles-preview-access-update"></span>
### `previewAccessUpdate(roleId, patch, options?)`

<!-- docs:method name=roles.previewAccessUpdate locale=zh -->

- **用途**：在改变角色状态或父角色前计算子角色、绑定用户和容量影响。
- **参数**：`patch: RoleAccessUpdateInput` 至少包含 `status` 或 `parentId`；preview options 不含 idempotency key。
- **状态影响**：只读计划，不提交变更。
- **原始返回**：`ImpactPreview<RoleAccessUpdatePlan>`；只有 `executable=true` 才能取得 `previewToken/expected`。
- **下一步**：解决 `conflicts`，再把同一 patch、token 和 expected 传给 `executeAccessUpdate`。

<span id="roles-execute-access-update"></span>
### `executeAccessUpdate(roleId, patch, options)`

<!-- docs:method name=roles.executeAccessUpdate locale=zh -->

- **用途**：提交刚才 preview 的 status/parent 变更。
- **参数**：`roleId` 与 `patch` 必须和 preview 一致；`options` 必须含 `expectedRevisions + previewToken`，容量风险时再传确认字段。
- **状态影响**：更新角色访问状态/继承，可能影响所有后代和绑定用户，并使相关缓存失效。
- **原始返回**：`MutationResult<Role>`。
- **常见失败**：`PREVIEW_REQUIRED`、`PREVIEW_STALE`、`REVISION_CONFLICT`、`CIRCULAR_INHERITANCE`。

<span id="roles-get-removal-impact"></span>
### `getRemovalImpact(roleId)`

<!-- docs:method name=roles.getRemovalImpact locale=zh -->

- **用途**：删除前查看子角色、绑定用户、规则和菜单来源是否阻止删除。
- **参数**：`roleId` 必填。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<RoleRemovalImpact>`；先检查 `data.removable` 和 `data.blockers`。
- **下一步**：解除 blocker 后重新读取 revision，再调用 `remove`。

<span id="roles-remove"></span>
### `remove(roleId, options)`

<!-- docs:method name=roles.remove locale=zh -->

- **用途**：删除一个不再被继承、绑定或引用的角色。
- **参数**：`roleId` 与 `options.expectedRevision` 必填，revision 来自最新 `get/getRemovalImpact`。
- **状态影响**：删除角色并写审计；不会自动替调用方解除业务引用。
- **原始返回**：`MutationResult<{ removedRoleId: string }>`。
- **常见失败**：`ROLE_IN_USE`、`REVISION_CONFLICT`、`ROLE_NOT_FOUND`。

<span id="roles-allow"></span>
### `allow(roleId, rule, options?)`

<!-- docs:method name=roles.allow locale=zh -->

- **用途**：为角色追加一个手工 allow 来源。
- **参数**：`roleId` 与 `rule: PermissionRuleInput` 必填；`where` 只用于数据条件。
- **状态影响**：写入/合并语义规则来源，推进 revision 并失效受影响 subject 缓存。
- **原始返回**：`MutationResult<PermissionRuleView>`；`data.semanticKey` 标识规范化规则，`data.sources` 说明来源。
- **边界**：存在匹配 deny 时仍以 deny 为准；allow 不是覆盖 deny。

<span id="roles-deny"></span>
### `deny(roleId, rule, options?)`

<!-- docs:method name=roles.deny locale=zh -->

- **用途**：追加显式 deny，处理“已有宽泛 allow，但某资源必须拒绝”的情况。
- **参数**：与 `allow` 相同，传角色 ID、deny 规则和可选 mutation options。
- **状态影响**：写入 deny 来源并失效缓存。
- **原始返回**：与 `allow` 相同的 `MutationResult<PermissionRule>`，其中 `data.effect` 为 `deny`。
- **选择建议**：默认拒绝不需要创建 deny；只有要覆盖现有 allow 时才添加。

<span id="roles-revoke"></span>
### `revoke(roleId, selector, options?)`

<!-- docs:method name=roles.revoke locale=zh -->

- **用途**：移除匹配的手工 allow/deny 来源，不删除菜单生成来源。
- **参数**：`selector` 必须精确描述 `effect/action/resource/where?`，或提供 `semanticKey`。
- **状态影响**：删除匹配手工来源；若无其他来源，语义规则随之消失。
- **原始返回**：`MutationResult<{ removed; remainingCount; remainingDigest }>`。
- **注意**：`removed=0` 是 no-op 结果，不表示方法失败。

<span id="roles-preview-rule-change"></span>
### `previewRuleChange(roleId, change, options?)`

<!-- docs:method name=roles.previewRuleChange locale=zh -->

- **用途**：预览单条 allow/deny/revoke 对用户和容量的影响。
- **参数**：`change` 是 `{ operation: 'allow'|'deny', rule }` 或 `{ operation: 'revoke', selector }`。
- **状态影响**：只读计划。
- **原始返回**：`ImpactPreview<ManualRuleChangePlan>`；查看 `plan.sourceOperation` 判断 insert/delete/noop。
- **下一步**：可执行时调用 `executeRuleChange`，不要改写 change。

<span id="roles-execute-rule-change"></span>
### `executeRuleChange(roleId, change, options)`

<!-- docs:method name=roles.executeRuleChange locale=zh -->

- **用途**：提交已预览的单条规则变更。
- **参数**：同一 `roleId/change`，加 `expectedRevisions + previewToken`。
- **状态影响**：原子更新规则、revision、审计和缓存。
- **原始返回**：`MutationResult<ManualRuleChangeResult>`；allow/deny 返回 `rule`，revoke 返回删除统计。

<span id="roles-preview-replace-rules"></span>
### `previewReplaceRules(roleId, rules, options?)`

<!-- docs:method name=roles.previewReplaceRules locale=zh -->

- **用途**：管理后台“保存完整规则集合”前计算 insert/update/delete/no-op。
- **参数**：`rules: ManualRuleInput[]` 是目标完整集合，不是要追加的差异数组；最多 2048 条。
- **状态影响**：只读计划。
- **原始返回**：`ImpactPreview<RoleRuleReplacePlan>`，重点检查 operations、unchanged、affectedUsers 和 conflicts。

<span id="roles-replace-rules"></span>
### `replaceRules(roleId, rules, options)`

<!-- docs:method name=roles.replaceRules locale=zh -->

- **用途**：把角色手工规则原子替换为完整目标集合。
- **参数**：`rules` 必须与 preview 相同；options 含 `expectedRevisions + previewToken`。
- **状态影响**：批量增删改手工来源；菜单来源保持独立，不会被本方法覆盖。
- **原始返回**：`MutationResult<BatchMutationSummary>`，使用 inserted/updated/unchanged/deleted/conflicted。

<span id="roles-get-own-rules"></span>
### `getOwnRules(roleId)`

<!-- docs:method name=roles.getOwnRules locale=zh -->

- **用途**：一次读取角色自身直接拥有的全部有界规则，包含手工和菜单来源，不解析父角色继承。
- **参数**：`roleId` 必填。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<PermissionRuleView[]>`。
- **区别**：需要分页/过滤来源时用 `listOwnRules`；需要继承结果时用 `getEffectiveRules`。

<span id="roles-list-own-rules"></span>
### `listOwnRules(roleId, query?)`

<!-- docs:method name=roles.listOwnRules locale=zh -->

- **用途**：为规则管理列表分页读取角色自身规则。
- **参数**：`query` 可传 `first/after/effect/sourceKind`。
- **状态影响**：只读。
- **原始返回**：`PageResult<PermissionRuleView>`；用于表格分页，不包含父角色规则。

<span id="roles-get-effective-rules"></span>
### `getEffectiveRules(roleId)`

<!-- docs:method name=roles.getEffectiveRules locale=zh -->

- **用途**：读取角色经过父链展开后的有效规则和 deny 冲突。
- **参数**：`roleId` 必填。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<EffectiveRoleRules>`；`data.role` 是目标角色，`data.chain` 是继承链，`data.rules/conflicts` 是有界结果。
- **边界**：这是角色视角，不包含某个用户的多角色合并；用户诊断用 `subject.getPermissions()`。

<span id="roles-get-chain"></span>
### `getChain(roleId)`

<!-- docs:method name=roles.getChain locale=zh -->

- **用途**：单独查看父角色链，以及 disabled/deprecated 节点为何未进入有效结果。
- **参数**：`roleId` 必填。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<RoleChainEntry[]>`；每项含 `role/depth/included/excludedReason`。
- **区别**：只解释层级，不返回规则；规则使用 `getEffectiveRules`。

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
