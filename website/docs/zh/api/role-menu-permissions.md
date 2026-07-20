# 角色菜单权限 API

## 用途与前置条件

`scoped.roles.menuPermissions` 把后台管理员的菜单选择转换成角色上的可追踪授权来源。它使用 `MenuConfigInput` 保存后的配置资产，支持菜单、视图、加载接口、按钮操作和接口响应字段授权。

前置条件：

- 角色已存在。
- 菜单配置已通过 `scoped.menus.config.save()` 保存。
- 写入前先调用 `preview()`，执行时传回同一输入、`expected` 和 `previewToken`。

## 我想做什么

| 目标 | 首选 API | 说明 |
|---|---|---|
| 预览并提交授权 | `preview()` 后调用 `grant()` / `deny()` / `revoke()` / `set()` | 所有写入都使用预览证据和 revision 保护。 |
| 读取直接授权 | `getDirect(roleId)` | 查看该角色自身保存的菜单授权和响应字段。 |
| 分页读取授权 | `listDirect(roleId, { first, after })` | 管理后台列表页使用 `first/after` 翻页。 |
| 读取有效授权 | `getEffective(roleId)` | 包含继承后的 grant，并按 deny-first 解析。 |
| 生成授权树 | `getAuthorizationTree(roleId, { configId })` | 供角色编辑页展示已勾选、拒绝、继承和停用状态。 |

## 签名

```ts
roles.menuPermissions.preview(roleId: string, change: MenuBusinessPermissionChange, options?: PreviewOptions): Promise<ImpactPreview<MenuBusinessPermissionPlan>>
roles.menuPermissions.grant(roleId: string, selection: MenuBusinessPermissionSelection, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuBusinessPermissionGrantResult>>
roles.menuPermissions.deny(roleId: string, selection: MenuBusinessPermissionSelection, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuBusinessPermissionGrantResult>>
roles.menuPermissions.revoke(roleId: string, input: { grantIds: readonly string[] }, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
roles.menuPermissions.set(roleId: string, assignments: readonly MenuBusinessPermissionAssignment[], options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
roles.menuPermissions.getDirect(roleId: string): Promise<VersionedResult<MenuBusinessDirectPermissionSnapshot>>
roles.menuPermissions.listDirect(roleId: string, query?: CursorQuery & { effect?: 'allow' | 'deny'; configId?: string }): Promise<PageResult<MenuBusinessGrantSnapshot>>
roles.menuPermissions.getEffective(roleId: string): Promise<VersionedResult<MenuBusinessEffectivePermissionSnapshot>>
roles.menuPermissions.getAuthorizationTree(roleId: string, options: { configId: string }): Promise<VersionedResult<MenuBusinessAuthorizationTree>>
```

关键参数标记：`change: MenuBusinessPermissionChange`，`selection: MenuBusinessPermissionSelection`，`assignments: readonly MenuBusinessPermissionAssignment[]`。

## 参数对象

<!-- docs:params owner=MenuBusinessPermissionSelection locale=zh -->

### `MenuBusinessPermissionSelection`

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `configId` | `string` | 必填 | 目标菜单配置 ID。 |
| `menus` | `string[]` | 可选 | 选择菜单分组或菜单项 ID。 |
| `views` | `string[]` | 可选 | 选择视图 ID，例如页面 `orders-list`。 |
| `loads` | `ApiResource[]` | 可选 | 精确选择加载接口资源。 |
| `actions` | `string[]` | 可选 | 精确选择 action ID。 |
| `responseFields` | `MenuBusinessResponseFieldSelection[]` | 可选 | 为指定接口选择可返回字段。 |
| `include.descendants` | `boolean` | 默认 `false` | 选择菜单时是否包含后代菜单和视图。 |
| `include.loads` | `boolean` | 默认 `false` | 选择视图时是否自动包含加载接口。 |
| `include.actions` | `boolean` | 默认 `false` | 选择视图时是否自动包含操作按钮。 |
| `include.responseFields` | `'none' \| 'all'` | 默认 `'none'` | 是否自动包含所选接口的全部响应字段。 |

`responseFields` 的每一项形如：

```ts
{
  apiResource: 'api:GET:/api/orders',
  fields: ['orderNo', 'status'],
}
```

`fields` 必须来自菜单配置中该接口已经声明的字段。要授权所有字段，可以使用 `include.responseFields: 'all'`；要精确控制字段，使用 `'none'` 加显式 `responseFields`。

<!-- docs:params owner=MenuBusinessPermissionChange locale=zh -->

### `MenuBusinessPermissionChange`

| operation | preview 输入 | 执行方法 | 语义 |
|---|---|---|---|
| `grant` | `{ operation: 'grant', selection }` | `grant(roleId, selection, options)` | 追加 allow 菜单授权。 |
| `deny` | `{ operation: 'deny', selection }` | `deny(roleId, selection, options)` | 追加 deny 菜单授权。 |
| `revoke` | `{ operation: 'revoke', grantIds }` | `revoke(roleId, { grantIds }, options)` | 删除指定 grant。 |
| `set` | `{ operation: 'set', assignments }` | `set(roleId, assignments, options)` | 替换该角色的完整直接菜单授权。 |

### `MenuBusinessPermissionAssignment`

| 字段 | 类型 | 说明 |
|---|---|---|
| `effect` | `'allow' \| 'deny'` | 本条 assignment 的效果。 |
| `selection` | `MenuBusinessPermissionSelection` | 要授权或拒绝的菜单选择。 |

## 方法详解：预览与写入

<span id="role-menu-preview"></span>
### `roles.menuPermissions.preview(roleId, change, options?)`

<!-- docs:method name=roles.menuPermissions.preview locale=zh -->

- **用途**：把一次 grant、deny、revoke 或 set 展开成计划，提前暴露冲突、影响用户和将生成的来源。
- **参数**：`roleId` 和 `change: MenuBusinessPermissionChange`。
- **状态影响**：只读，不写入 grant。
- **原始返回**：`ImpactPreview<MenuBusinessPermissionPlan>`；重点检查 `executable`、`conflicts`、`grants.items[].selectedAssets`、`grants.items[].selectedResponseFields`、`expected` 和 `previewToken`。

<span id="role-menu-grant"></span>
### `roles.menuPermissions.grant(roleId, selection, options)`

<!-- docs:method name=roles.menuPermissions.grant locale=zh -->

- **用途**：追加一组 allow 菜单授权。
- **参数**：`selection: MenuBusinessPermissionSelection` 必须与 grant preview 一致；`options` 必须带 `expected/previewToken`。
- **状态影响**：保存 grant，并生成视图、接口、按钮和响应字段的规则来源。
- **原始返回**：`MutationResult<MenuBusinessPermissionGrantResult>`；`generatedSources` 和 `generatedResponseFields` 是本次生成数量。

<span id="role-menu-deny"></span>
### `roles.menuPermissions.deny(roleId, selection, options)`

<!-- docs:method name=roles.menuPermissions.deny locale=zh -->

- **用途**：追加一组 deny 菜单授权，用于显式禁止某些菜单能力。
- **参数**：必须先以 `{ operation: 'deny', selection }` 预览。
- **状态影响**：保存 deny grant，不删除已有 allow。
- **原始返回**：同 `grant()`，但 effect 为 deny。

<span id="role-menu-revoke"></span>
### `roles.menuPermissions.revoke(roleId, input, options)`

<!-- docs:method name=roles.menuPermissions.revoke locale=zh -->

- **用途**：按 grant ID 精确撤销直接菜单授权。
- **参数**：`input.grantIds` 来自 `grant()`、`getDirect()` 或 `listDirect()`；执行前先 preview revoke。
- **状态影响**：移除指定 grant 及其生成来源。
- **原始返回**：`MutationResult<BatchMutationSummary>`。

<span id="role-menu-set"></span>
### `roles.menuPermissions.set(roleId, assignments, options)`

<!-- docs:method name=roles.menuPermissions.set locale=zh -->

- **用途**：保存完整角色菜单授权表单。
- **参数**：`assignments: readonly MenuBusinessPermissionAssignment[]`，每项含 `effect` 和 `selection`。
- **状态影响**：替换该角色全部直接菜单授权；不影响手工角色规则和用户角色绑定。
- **原始返回**：`MutationResult<BatchMutationSummary>`。

## 方法详解：读取授权

<span id="role-menu-get-direct"></span>
### `roles.menuPermissions.getDirect(roleId)`

<!-- docs:method name=roles.menuPermissions.getDirect locale=zh -->

- **用途**：读取该角色自己拥有的菜单 grant。
- **参数**：角色 ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<MenuBusinessDirectPermissionSnapshot>`；每个 grant 含 `selection`、`responseFields` 和 `sourceStatus`。

<span id="role-menu-list-direct"></span>
### `roles.menuPermissions.listDirect(roleId, query?)`

<!-- docs:method name=roles.menuPermissions.listDirect locale=zh -->

- **用途**：分页读取角色自己的菜单 grant。
- **参数**：可按 `effect` 或 `configId` 过滤，并支持 `first/after`。
- **状态影响**：只读。
- **原始返回**：`PageResult<MenuBusinessGrantSnapshot>`。

<span id="role-menu-get-effective"></span>
### `roles.menuPermissions.getEffective(roleId)`

<!-- docs:method name=roles.menuPermissions.getEffective locale=zh -->

- **用途**：读取角色自身和父角色继承后的有效菜单授权。
- **参数**：角色 ID。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<MenuBusinessEffectivePermissionSnapshot>`；每项包含 `sourceRoleId/inherited/depth` 和冲突信息。

<span id="role-menu-get-authorization-tree"></span>
### `roles.menuPermissions.getAuthorizationTree(roleId, options)`

<!-- docs:method name=roles.menuPermissions.getAuthorizationTree locale=zh -->

- **用途**：生成后台授权树，展示菜单、视图、加载接口、按钮和响应字段的 direct/inherited/conflict 状态。
- **参数**：`options.configId` 指定配置。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<MenuBusinessAuthorizationTree>`；每个节点含 `state`、`selection` 和 `children`。

## 响应与副作用

Grant/deny 会保存管理员选择，并生成可追踪来源。响应字段来源不会直接改变接口返回；只有当前用户调用 `subject.menus.filterResponse()` 或 Vext 自动响应投影时，才会按有效授权裁剪返回值。

```json
{
  "data": {
    "roleId": "order-operator",
    "grantIds": { "total": 1, "items": ["grant_..."] },
    "generatedSources": 3,
    "generatedResponseFields": 2,
    "removedSources": 0
  },
  "auditId": "audit_..."
}
```

## 失败与限制

常见失败包括角色不存在、配置不存在、选择的 view/action/field 不存在、资源格式不合法、preview token 过期、revision 冲突和容量超限。`set()` 可以传空数组清空直接菜单授权，但不会删除手工规则或用户角色绑定。

## 示例

```ts
const selection = {
  configId: 'admin',
  views: ['orders-list'],
  responseFields: [{
    apiResource: 'api:GET:/api/orders',
    fields: ['orderNo', 'status'],
  }],
  include: { loads: true, actions: true, responseFields: 'none' },
};

const preview = await scoped.roles.menuPermissions.preview(
  'order-operator',
  { operation: 'grant', selection },
);
if (!preview.executable) throw new Error('resolve conflicts first');

const result = await scoped.roles.menuPermissions.grant(
  'order-operator',
  selection,
  { ...preview.expected, previewToken: preview.previewToken },
);
```

```json
{
  "roleId": "order-operator",
  "generatedSources": 3,
  "generatedResponseFields": 2
}
```

## 相关内容

参见[角色菜单授权](/zh/guide/role-menu-authorization)、[管理菜单](/zh/guide/menu-management)和[菜单 API](/zh/api/menus)。
