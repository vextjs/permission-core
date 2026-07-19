# 角色菜单授权

角色菜单授权把管理员选择的结构转换为持久化、可追踪来源的权限规则。它不会自动绑定用户；用户仍通过常规角色绑定获得结果。

## 构造选择

```ts
const selection = {
  nodeIds: ['orders'],
  include: {
    descendants: true,
    buttons: true,
    apis: 'required',
    dataPermissions: true,
  },
  apiChoices: {
    bindingIds: [],
    permissionsByBinding: {},
  },
};
```

- `nodeIds` 是管理员选择的锚点节点。
- `descendants` 包含子导航节点。
- `buttons` 单独包含按钮子项；按钮不属于可见导航树。
- `apis` 可选择不包含、包含必需 owner 绑定或包含全部 owner 绑定。
- `dataPermissions` 包含选中节点声明的数据模板。
- `apiChoices` 解决预览返回的显式 `any` 备选项。

## 执行前预览

```ts
const preview = await scoped.roles.menuPermissions.preview(
  'order-operator',
  { operation: 'grant', selection },
  { actorId: 'admin' },
);
```

```json
{
  "executable": true,
  "plan": {
    "roleId": "order-operator",
    "operation": "grant",
    "choiceRequirements": { "total": 0 },
    "grants": { "total": 1 }
  },
  "previewToken": "signed-token",
  "expected": { "expectedRevisions": { "rbac": 3, "menu": 8 } }
}
```

`executable` 为 false 时，应完整展示 `conflicts` 和 `choiceRequirements`，根据要求的绑定或权限 semantic key 重建选择后再次预览。token 绑定准确的角色、选择、计划和修订向量；相关状态变化后不能复用。

## 授予、拒绝、撤销或替换

```ts
if (!preview.executable) throw new Error('Resolve the preview first');
const granted = await scoped.roles.menuPermissions.grant(
  'order-operator',
  selection,
  {
    ...preview.expected,
    previewToken: preview.previewToken,
    actorId: 'admin',
    idempotencyKey: 'role-order-operator-orders-v1',
  },
);
```

```json
{
  "changed": true,
  "data": {
    "roleId": "order-operator",
    "generatedSources": 4,
    "generatedSemanticRules": 4,
    "removedSources": 0
  },
  "auditId": "..."
}
```

`grant` 和 `deny` 生成效果相反的菜单来源规则；`revoke` 移除指定 grant ID；`set` 替换角色的完整菜单授权列表，适合保存完整授权树表单。每个执行方法都需要匹配的预览和修订向量。

## 绑定用户并读取授权

```ts
await scoped.userRoles.assign('u-1', 'order-operator');

const direct = await scoped.roles.menuPermissions.getDirect('order-operator');
const effective = await scoped.roles.menuPermissions.getEffective('order-operator');
const tree = await scoped.roles.menuPermissions.getAuthorizationTree('order-operator');
```

直接读取只显示该角色拥有的 grant；有效读取还包含继承 grant、来源角色 ID、冲突、完整性、可用性和漂移。授权树面向管理员，不等同于用户的可见菜单树。

## 投影用户界面

```ts
const menus = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme', appId: 'admin' },
}).menus;

const visible = await menus.getVisibleTree();
const buttons = await menus.getButtonMap('orders');
const route = await menus.getRouteState('/orders');
```

```json
{
  "visibleNodeIds": ["operations", "orders"],
  "button": { "visible": true, "enabled": true, "reason": "allowed" },
  "route": { "allowed": true, "navigationReachable": true }
}
```

路由可能权限允许但导航不可达，因为祖先被隐藏、停用、拒绝或接口不可用。前端路由必须分别处理 `allowed` 与 `navigationReachable`。

## 处理资源变化

每条生成规则都记录 grant、资源、绑定、贡献类型和快照摘要。菜单权限或接口绑定变化后，来源可能变为 `refresh-available`；引用缺失则变为 stale 或 invalid。只有向管理员展示计划变化后，才调用 `listStale`、`previewRepairStale` 和 `repairStale`。持久化完整性失败会收紧授权，不会静默退回旧权限。

可运行的[菜单管理示例](/zh/examples/menu-admin)展示完整顺序；精确方法与响应类型见[角色菜单权限 API](/zh/api/role-menu-permissions)。
