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

## 先理解三个层次

1. **菜单节点**描述页面、目录或按钮资产，节点的 `permission` 是该资产自身的权限要求。
2. **API binding**描述一个后端 endpoint 需要哪些权限，以及它属于哪些菜单资产。
3. **角色菜单授权**保存管理员“选择了哪些节点、是否连同按钮/API/数据模板”的意图，再把这份意图展开成可追踪的角色规则来源。

因此，`nodeIds` 不是“角色权限 ID 列表”，`apiChoices` 也不是“任意追加接口”。它们都必须引用当前选择可达的菜单/binding；最终产生哪些规则以 preview 的 `contributions` 为准。

## 参数对象

<!-- docs:params owner=MenuPermissionSelection locale=zh -->

<span id="role-menu-selection"></span>
### `MenuPermissionSelection`

| 字段 | 必填 | 作用与约束 |
|---|---|---|
| `nodeIds` | 是，至少 1 项 | 管理员直接勾选的**锚点节点**。每个锚点生成一个稳定 grant；ID 必须位于当前 scope。 |
| `include.descendants` | 是 | 是否递归包含锚点下的非按钮后代。 |
| `include.buttons` | 是 | 是否包含锚点范围内的 button 节点；按钮不会仅因 `descendants=true` 自动包含。 |
| `include.apis` | 是 | `none` 不贡献 API；`required` 只处理 owner 关系中 `required=true` 的 binding；`all` 还包含可选 binding。 |
| `include.dataPermissions` | 是 | 是否把所选节点的 `dataPermissions` 模板展开成数据规则来源。 |
| `apiChoices.bindingIds` | 是，可为空 | 只用于解决 `required` binding 的 `availabilityMode='any'` 组：从 preview 给出的候选中至少选一个。 |
| `apiChoices.permissionsByBinding` | 是，可为空对象 | 只用于 `authorization.mode='any'` 的 allow：键是 binding ID，值是 preview 候选中的 permission semantic key。 |

第一次 preview 时通常把两个 `apiChoices` 字段留空。如果返回 `executable=false`，读取 `plan.choiceRequirements.items`：

- `kind='availability-any'`：从 `candidates.items[].bindingId` 选择至少一个，写入 `apiChoices.bindingIds`。
- `kind='authorization-any'`：从 `candidates.items[].semanticKey` 选择至少一个，写入对应 `permissionsByBinding[bindingId]`。

不要根据 method/path 自己计算 semantic key，也不要提交 preview 未列出的 choice。deny 为避免留下可绕过的任一分支，会覆盖启用候选，而不是要求管理员只选其中一个。

<!-- docs:params owner=MenuPermissionChange locale=zh -->

| operation | preview 输入 | 执行方法 | 状态语义 |
|---|---|---|---|
| `grant` | `{ operation: 'grant', selection }` | `grant(roleId, selection, options)` | 追加 allow grant；不清除角色已有菜单 grant。 |
| `deny` | `{ operation: 'deny', selection }` | `deny(roleId, selection, options)` | 追加 deny grant；deny 规则会参与正常冲突/优先级解析。 |
| `revoke` | `{ operation: 'revoke', grantIds }` | `revoke(roleId, { grantIds }, options)` | 按稳定 grant ID 移除指定菜单授权及其生成来源。 |
| `set` | `{ operation: 'set', assignments }` | `set(roleId, assignments, options)` | 用 allow/deny assignments 替换该角色的**完整直接菜单授权集合**。 |

`set` 只替换菜单来源，不替换手工 `roles.allow/deny` 规则，也不修改用户角色绑定。通用 preview/execution 与响应 envelope 见[核心与上下文 API](/zh/api/core-and-contexts#common-response-contracts)。

## 方法详解

<span id="role-menu-preview"></span>
### `preview(roleId, change, options?)`

<!-- docs:method name=roles.menuPermissions.preview locale=zh -->

- **用途**：把一次 grant/deny/revoke/set 展开成节点、API、数据规则贡献，并在执行前暴露冲突和 choice。
- **参数**：角色 ID 与上表对应的 `MenuPermissionChange`；可选 actor/reason/detailBudget。
- **状态影响**：只读，不创建 grant。
- **原始返回**：`ImpactPreview<MenuPermissionPlan>`；必须检查 `executable`、`conflicts`、`choiceRequirements`、`grants/removals`、`expected` 和 `previewToken`。
- **下一步**：若 choice 未解决，修改 selection 后重新 preview；不要拿旧 token 执行新输入。

<span id="role-menu-grant"></span>
### `grant(roleId, selection, options)`

<!-- docs:method name=roles.menuPermissions.grant locale=zh -->

- **用途**：追加一组 allow 菜单授权。
- **参数**：与 `{ operation:'grant', selection }` 预览完全一致的角色/selection，以及 preview token/revision vector。
- **状态影响**：保存每个锚点的 grant intent/snapshot，并生成 node、API、data 角色规则来源；不绑定用户。
- **原始返回**：`MutationResult<MenuPermissionGrantResult>`；`grantIds` 用于后续 revoke，`generatedSources/generatedSemanticRules` 是实际贡献计数。

<span id="role-menu-deny"></span>
### `deny(roleId, selection, options)`

<!-- docs:method name=roles.menuPermissions.deny locale=zh -->

- **用途**：追加一组 deny 菜单授权，用于显式覆盖相同 action/resource 的可访问路径。
- **参数**：必须先按 `{ operation:'deny', selection }` 独立预览；不能复用 grant 的 token。
- **状态影响**：保存 deny grant 并生成 deny 来源；不会删除既有 allow。
- **原始返回**：同 grant 的 `MenuPermissionGrantResult`，但要结合有效规则/冲突读取实际结果。

<span id="role-menu-revoke"></span>
### `revoke(roleId, input, options)`

<!-- docs:method name=roles.menuPermissions.revoke locale=zh -->

- **用途**：按 grant ID 精确撤销直接菜单授权。
- **参数**：`input.grantIds` 来自 `getDirect/listDirect` 或先前 grant 返回；必须先 preview 对应 revoke change。
- **状态影响**：删除这些 grant 及其生成来源，不影响其他 grant 或手工规则。
- **原始返回**：`MutationResult<BatchMutationSummary>`；不存在/过期 grant 会在预览或执行阶段显式失败。

<span id="role-menu-set"></span>
### `set(roleId, assignments, options)`

<!-- docs:method name=roles.menuPermissions.set locale=zh -->

- **用途**：保存“完整授权树表单”，一次替换角色所有直接菜单 grant。
- **参数**：每个 assignment 含 `effect: allow|deny` 与完整 selection；先用 `{ operation:'set', assignments }` preview。
- **状态影响**：新增、刷新、保留或移除 grant 及来源；不是追加操作。
- **原始返回**：`MutationResult<BatchMutationSummary>`；空数组表示清空该角色的直接菜单授权，但不清手工规则。

<span id="role-menu-get-direct"></span>
### `getDirect(roleId)`

<!-- docs:method name=roles.menuPermissions.getDirect locale=zh -->

- **用途**：读取该角色自己持有的全部菜单 grant 快照。
- **参数**：角色 ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<DirectMenuPermissionSnapshot>`；每个 grant 含 intent、贡献、revision、integrity、availability、drift 和 source states。
- **区别**：不含父角色继承；有效结果使用 `getEffective()`。

<span id="role-menu-list-direct"></span>
### `listDirect(roleId, query?)`

<!-- docs:method name=roles.menuPermissions.listDirect locale=zh -->

- **用途**：对大量直接 grant 做游标分页，适合管理列表。
- **参数**：角色 ID；`first/after`，可选 `effect='allow'|'deny'`。
- **状态影响**：只读。
- **原始返回**：`PageResult<DirectMenuGrantSnapshot>`；与 `getDirect` 数据语义相同，但分页有界。

<span id="role-menu-get-effective"></span>
### `getEffective(roleId)`

<!-- docs:method name=roles.menuPermissions.getEffective locale=zh -->

- **用途**：解析角色自身和父角色继承得到的有效菜单 grant。
- **参数**：角色 ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<EffectiveMenuPermissionSnapshot>`；每项增加 `sourceRoleId/inherited/depth`，并返回有界 conflicts。

<span id="role-menu-get-authorization-tree"></span>
### `getAuthorizationTree(roleId)`

<!-- docs:method name=roles.menuPermissions.getAuthorizationTree locale=zh -->

- **用途**：把直接/继承 allow、deny、冲突和 API coverage 投影到完整菜单树，供管理员勾选界面使用。
- **参数**：角色 ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<AuthorizationTreeNode[]>`；`selection` 表示 none/partial/all，`state` 表示权限来源状态。
- **边界**：这是角色管理树，不是某个用户的可见菜单；用户运行时请用 subject menus facade。

<span id="role-menu-list-stale"></span>
### `listStale(query?)`

<!-- docs:method name=roles.menuPermissions.listStale locale=zh -->

- **用途**：分页查找资产缺失、binding 缺失、permission 变化或 selection 漂移的菜单来源。
- **参数**：可选 `first/after`。
- **状态影响**：只读。
- **原始返回**：`PageResult<StaleMenuPermissionSource>`，每项给出 role/grant/source ID 与 stale reason。

<span id="role-menu-preview-repair-stale"></span>
### `previewRepairStale(input, options?)`

<!-- docs:method name=roles.menuPermissions.previewRepairStale locale=zh -->

- **用途**：预览指定 stale source 的替换或撤销方案。
- **参数**：`sourceIds` 来自 `listStale`；`sourceRewrite` 为每个 impact 给出 replace/revoke 决策。
- **状态影响**：不修复。
- **原始返回**：`ImpactPreview<StaleMenuPermissionRepairPlan>`，重点核对 `sourceImpacts` 与 executable。

<span id="role-menu-repair-stale"></span>
### `repairStale(input, options)`

<!-- docs:method name=roles.menuPermissions.repairStale locale=zh -->

- **用途**：执行已确认的 stale 来源修复。
- **参数**：与预览一致的 input、revision vector 和 preview token。
- **状态影响**：替换或撤销来源并保留审计记录；不会静默重算管理员原始选择。
- **原始返回**：`MutationResult<BatchMutationSummary>`；修复后应再次读取 direct/effective 状态验证。

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
