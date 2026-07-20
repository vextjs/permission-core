# 菜单管理

## 场景

该示例创建目录、页面、按钮和 API binding；将页面工作流授权给角色；更新展示状态；投影用户可见树/按钮/路由状态；并导出带审计证据的前端 manifest。

## 运行

```bash
npm run example:menu-admin
```

规范源码是 `examples/menu-admin.mjs` 中 `docs:menu-admin:start` 到 `docs:menu-admin:end` 的内容。

## 先看结果

运行成功先确认 `roleGrant.generatedSources: 4`、`roleGrant.auditRecorded: true`、`subjectRuntime.exportButton.enabled: true` 和 `manifest.apiBindingCount: 1`。这组值证明授权来源已生成并审计、用户按钮可用、接口绑定已进入前端 manifest。

## 源码解读

```js
const root = await scoped.menus.create({
  id: 'operations', type: 'directory', title: 'Operations',
}, { actorId: 'admin' });
const page = await scoped.menus.create({
  id: 'orders', parentId: 'operations', type: 'page', title: 'Orders',
  path: '/orders', name: 'orders', component: 'OrdersPage',
  permission: { action: 'read', resource: 'ui:page:orders' },
  dataPermissions: [{ action: 'read', resource: 'db:orders', label: 'Read orders' }],
}, { actorId: 'admin' });
const button = await scoped.menus.create({
  id: 'orders-export', parentId: 'orders', type: 'button', title: 'Export orders',
  code: 'orders.export',
  permission: { action: 'invoke', resource: 'ui:button:orders.export' },
}, { actorId: 'admin' });
const binding = await scoped.apiBindings.create({
  id: 'orders-export-api', method: 'POST', path: '/api/orders/export',
  purpose: 'importExport',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:POST:/api/orders/export' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
  canonicalOwner: { type: 'button', id: 'orders-export' },
}, { actorId: 'admin' });

await scoped.roles.create({ id: 'order-operator', label: 'Order operator' });
await scoped.userRoles.assign('u-menu', 'order-operator');
const selection = {
  nodeIds: ['orders'],
  include: { descendants: true, buttons: true, apis: 'required', dataPermissions: true },
  apiChoices: { bindingIds: [], permissionsByBinding: {} },
};
const preview = await scoped.roles.menuPermissions.preview(
  'order-operator',
  { operation: 'grant', selection },
);
if (!preview.executable) throw new Error('Grant is not executable');
const granted = await scoped.roles.menuPermissions.grant('order-operator', selection, {
  ...preview.expected,
  previewToken: preview.previewToken,
});

const updated = await scoped.menus.update(
  'orders',
  { title: 'Order management' },
  { expectedRevision: page.data.revision, actorId: 'admin' },
);
const subjectMenus = core.forSubject({ userId: 'u-menu', scope }).menus;
const visible = await subjectMenus.getVisibleTree();
const buttons = await subjectMenus.getButtonMap('orders');
const route = await subjectMenus.getRouteState('/orders');
const manifest = await scoped.menus.manifest.export();
const directGrant = await scoped.roles.menuPermissions.getDirect('order-operator');
```

Selection 包含后代节点、按钮、必需 API 和数据模板。Grant 创建 4 个携带来源的规则 source；随后 UI projection 针对用户判断这些来源。

### 1. 创建菜单与 API ownership 模型

<!-- docs:operation id=menu-model calls=menus.create,apiBindings.create outputs=created -->

**目的与目标。** 三次 `menus.create` 持久化 directory、page 和 button；`apiBindings.create` 再把 export endpoint 绑定到所属 button，并声明必须同时通过的 API permission。

**状态、参数与结果。** Parent ID 构建 tree；page/button permission descriptor 定义 UI resource；API binding 记录 method、path、authorization mode、required owner 与 canonical owner。提交后的 ID 形成 `created`，每次 mutation 都携带审计证据。

**失败与下一步。** hierarchy 无效、ID 重复、resource 格式错误或 owner 缺失/无效时，对应 mutation 会被拒绝。应先修复后端模型，不能用前端专用菜单项或未绑定 route 补偿。

**API 参考。** 参见[菜单 API](/zh/api/menus)和[接口绑定 API](/zh/api/api-bindings)，了解输入、ownership、mutation 结果与错误。

`menus.create()` 每次只创建一个节点并返回独立 `MutationResult<MenuNode>`；parent 必须先存在。`apiBindings.create()` 校验 button owner 后返回 `MutationResult<ApiBinding>`，但不会自动给角色授权。`root/page/button/binding.data.id` 是汇总输出的真实来源。

### 2. 创建工作流使用的角色身份

<!-- docs:operation id=menu-role calls=roles.create,userRoles.assign outputs=subjectRuntime -->

**目的与目标。** `roles.create` 在 admin application scope 中创建 `order-operator`，`userRoles.assign` 在请求任何 runtime projection 前把它追加给 `u-menu`。

**状态、参数与结果。** 该步骤只建立谁可以接收后续 menu grant；它本身不会授权 page、button、API 或 data template。只有经审查的 grant 成功后才会生成这些能力。

**失败与下一步。** role 缺失或 assignment 失败会让 subject 不具备该工作流。应先修复 scoped role/binding 并检查 direct role，再排查前端可见性。

**API 参考。** 参见[角色 API](/zh/api/roles)和[用户角色 API](/zh/api/user-roles)。

`roles.create()` 返回新角色 envelope；`userRoles.assign()` 返回提交后的直接角色集合。这里没有用 `set()`，因为只追加一个角色，不应替换用户可能已有的其他直接角色。

### 3. 预览并提交角色菜单授权

<!-- docs:operation id=menu-grant calls=menuPermissions.preview,menuPermissions.grant,menuPermissions.getDirect outputs=roleGrant -->

**目的与目标。** `menuPermissions.preview` 把选中 page 展开为后代、button、required API 和 data permission。`menuPermissions.grant` 使用预期 revision 与 preview token 提交该精确计划；`menuPermissions.getDirect` 读取持久化 grant 和 source status。

**状态、参数与结果。** Selection 从 `orders` 开始；include flag 控制展开范围，`apiChoices` 解决 optional choice。提交成功后会生成 4 个携带 provenance 的规则 source 和一个直接 grant，共同形成 `roleGrant`。

**失败与下一步。** conflict 会让 preview 变为不可执行；revision 过期或 token 过期/发生变化时 commit 会被拒绝。应向管理员展示 conflict，刷新 preview，审查新计划，再提交新 token，不能绕过 preview。

**API 参考。** 参见[角色菜单权限 API](/zh/api/role-menu-permissions)，了解 selection 展开、preview、token、grant 和 source integrity。

| 方法 | 输入 | 原始返回/下一步 |
|---|---|---|
| `menuPermissions.preview(roleId, change)` | `{ operation:'grant', selection }` | `ImpactPreview<MenuPermissionPlan>`；先检查 executable/choices/conflicts |
| `menuPermissions.grant(roleId, selection, options)` | 同一 selection + expected/token | `MutationResult<MenuPermissionGrantResult>`；保存 grant 并生成来源 |
| `menuPermissions.getDirect(roleId)` | 角色 ID | `VersionedResult<DirectMenuPermissionSnapshot>`；读取 grant/source status |

### 4. 使用 revision 更新展示状态

<!-- docs:operation id=menu-update calls=menus.update outputs=update -->

**目的与目标。** `menus.update` 以 `orders` 为目标，把 page title 改为 `Order management`，但不改变其 permission identity 或 route。

**状态、参数与结果。** 调用把 page 当前 `revision` 作为 `expectedRevision`；提交响应提供新 title 和 revision `2`，并写入 `update`。

**失败与下一步。** 并发菜单修改会使 revision 过期并拒绝 update。应重新读取 node，合并管理员预期的 presentation change，再使用新 revision 重试。

**API 参考。** 参见[菜单 API](/zh/api/menus)，了解可变字段、revision option 和 update 结果。

`page.data.revision` 来自创建响应，是这次简单展示字段更新的 CAS 基线。`updated` 是完整 mutation envelope；示例汇总只提取 `updated.data.title/revision`。

### 5. 投影用户可见的 runtime 状态

<!-- docs:operation id=menu-subject calls=forSubject,getVisibleTree,getButtonMap,getRouteState outputs=subjectRuntime -->

**目的与目标。** `forSubject` 创建请求期用户上下文；`getVisibleTree`、对 `orders` 调用的 `getButtonMap`，以及对 `/orders` 调用的 `getRouteState` 根据同一组有效授权来源，分别生成 navigation、button 和 route 状态。

**状态、参数与结果。** Visible tree 包含 directory/page，但 button 不作为 navigation node。Button map 报告 UI 判定及 required API risk，route state 报告授权与 navigation reachability；这些值形成 `subjectRuntime`。

**失败与下一步。** identity 缺失、生成 source 过期/integrity 无效、binding 不可用或 required API 被拒绝时会 fail closed。应根据 reason/risk 字段修复后端 grant 或 binding，不能只因 manifest 中存在 button 就启用它。

**API 参考。** 参见[核心与上下文 API](/zh/api/core-and-contexts)、[菜单 API](/zh/api/menus)和[角色菜单权限 API](/zh/api/role-menu-permissions)。

三个 subject menu 方法都只读，并分别返回 `SubjectRuntimeResult<VisibleMenuTreeNode[]>`、button code map 和 route state。示例汇总从各自 `data` 取值；`detailBudget` 没有丢失语义，但未重复打印。

### 6. 导出前端 manifest

<!-- docs:operation id=menu-manifest calls=menus.manifest.export outputs=manifest -->

**目的与目标。** `menus.manifest.export` 输出带版本的 menu/API definition，供前端作为 structure 消费；它不会提前授权某个用户。

**状态、参数与结果。** 导出的 `schemaVersion`、3 个 node 和 1 个 API binding 形成 `manifest`。每用户可见性仍来自上一步 subject projection。

**失败与下一步。** 持久化 menu/binding 状态无效或不可用时，export 会失败。应修复后端模型并重新生成 manifest，不能无限缓存 malformed 或 stale structure。

**API 参考。** 参见[菜单 API](/zh/api/menus)了解 manifest export，并参见[接口绑定 API](/zh/api/api-bindings)了解内嵌 binding contract。

`manifest.export()` 原始返回 `VersionedResult<FrontendMenuManifest>`；`manifest.data.nodes/apiBindings` 是完整结构库存，不是当前用户可见结果。

## 预期输出

以下 JSON 是 `printExample()` 从 12 个独立管理/subject 响应中提取字段后生成的**示例汇总输出**，不是任何一个 API 的原始响应。

```json
{
  "example": "menu-admin",
  "ok": true,
  "created": {
    "nodes": ["operations", "orders", "orders-export"],
    "apiBinding": "orders-export-api"
  },
  "update": { "title": "Order management", "revision": 2 },
  "roleGrant": {
    "generatedSources": 4,
    "grantCount": 1,
    "sourceStatus": { "integrity": "valid", "availability": "active", "drift": "current" },
    "auditRecorded": true
  },
  "subjectRuntime": {
    "visibleNodeIds": ["operations", "orders"],
    "exportButton": {
      "visible": true,
      "enabled": true,
      "reason": "allowed",
      "action": "invoke",
      "resource": "ui:button:orders.export",
      "apiRisks": {
        "total": 1,
        "items": [
          {
            "bindingId": "orders-export-api",
            "required": true,
            "allowed": true
          }
        ],
        "truncated": false,
        "digest": "tLtCyOJN4gP1FKjpuujpqJC7WfPZPYQkWlncDHSbiMY"
      }
    },
    "route": { "allowed": true, "reason": "allowed", "navigationReachable": true }
  },
  "manifest": { "schemaVersion": 2, "nodeCount": 3, "apiBindingCount": 1 }
}
```

<!-- docs:output group=created producer=menu-model -->

**`created` 来源。** 三个 `menus.create` 响应和 `apiBindings.create` 响应提供已提交 ID；这是后续 grant 引用的持久化后端模型。

<!-- docs:output group=update producer=menu-update -->

**`update` 来源。** 带 revision 检查的 `menus.update` 响应提供新 title 与 revision，证明 presentation change 已提交，而不是只修改输出对象。

<!-- docs:output group=roleGrant producer=menu-grant -->

**`roleGrant` 来源。** `menuPermissions.grant` 提供 `generatedSources`；`menuPermissions.getDirect` 提供 grant count 与 source status。`auditRecorded` 检查全部 6 次管理 mutation 是否都返回非空 audit ID。

<!-- docs:output group=subjectRuntime producer=menu-subject -->

**`subjectRuntime` 来源。** `getVisibleTree`、`getButtonMap` 与 `getRouteState` 响应分别读取。嵌套 API risk 证明 button enablement 还包含 required backend binding，而不只是 UI permission。

<!-- docs:output group=manifest producer=menu-manifest -->

**`manifest` 来源。** `menus.manifest.export` 提供 schema version 及完整 node/binding 数组；示例报告其 count，便于 consumer 核对预期 structure。

## 生产边界

该示例是后端管理流程，不是只在前端过滤菜单。每个管理 endpoint 和绑定的业务 API 都要独立保护。保存管理员身份/reason/request 关联，并对高影响变更要求 preview token。

## 相关内容

参见[管理菜单](/zh/guide/menu-management)、[绑定接口](/zh/guide/api-bindings)和[角色菜单授权](/zh/guide/role-menu-authorization)。
