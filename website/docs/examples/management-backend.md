# 管理后台保存示例

这个示例展示后台里最常见的两条链路：角色页怎么加载和保存规则，用户页怎么加载和整体保存所属角色。它不关注请求鉴权中间件，而是关注管理 API 在后台里的组织方式。

## 先加载角色页需要的数据

```typescript
const roles = await pc.roles.list();
const role = await pc.roles.get('operator');
const rules = await pc.roles.getRules('operator');
```

这三步分别对应：

- `list()`：给下拉框、列表页或角色树提供基础数据
- `get()`：加载当前角色的基础信息
- `getRules()`：加载角色自身规则，不含继承链

## 保存角色基本信息和规则

```typescript
type RoleRuleInput = {
  type: 'allow' | 'deny';
  action: string;
  resource: string;
  where?: {
    field: string;
    op: string;
    valueFrom?: string;
    value?: unknown;
  };
};

await pc.roles.update('operator', { label: '运营角色' });

async function saveRoleRules(roleId: string, nextRules: RoleRuleInput[]) {
  await pc.roles.clearRules(roleId);

  for (const rule of nextRules) {
    if (rule.type === 'allow') {
      await pc.roles.allow(roleId, rule.action, rule.resource, {
        where: rule.where,
      });
      continue;
    }

    await pc.roles.deny(roleId, rule.action, rule.resource, {
      where: rule.where,
    });
  }
}
```

如果你的后台会先算差异，再做增量保存，也可以把删除部分拆成 `revokeRule()`，而不是每次都 `clearRules()` 后重建。

## 加载和保存用户所属角色

```typescript
const currentRoleIds = await pc.users.getUserRoles('user-001');

await pc.users.setUserRoles('user-001', ['viewer', 'auditor']);
```

这一步最关键的边界是：

- `getUserRoles()` 负责加载当前用户的角色数组
- `setUserRoles()` 负责整体覆盖当前用户的角色集合
- `assign()` / `revoke()` 更适合单点变更，不一定适合整页保存

如果你的页面是多选框、穿梭框或批量选择角色，`setUserRoles()` 通常会比多次 `assign()` / `revoke()` 更贴近页面语义。

## 保存后刷新菜单资源和调试视图

```typescript
const menuResources = await pc.getResources('user-001', 'invoke');
const permissions = await pc.getPermissions('user-001');
```

这两类结果适合这样理解：

- `getResources()`：给前端菜单、按钮、路由显隐提供一份先参考的资源列表
- `getPermissions()`：给后台调试面板、审计页或排查问题时查看完整规则展开结果

## 这个示例真正说明了什么

- 角色页和用户角色页的加载动作并不相同：前者更依赖 `getRules()`，后者更依赖 `getUserRoles()`
- 角色规则保存更接近“维护规则数组”，用户角色保存更接近“整体覆盖角色集合”
- `getResources()` 可以帮助后台刷新菜单显隐，但它不是最终鉴权结果
- `getPermissions()` 更适合做调试和审计视图，不适合作为直接保存输入

## 常见误区

- 用 `getRules()` 当成用户最终权限结果
- 用多次 `assign()` / `revoke()` 代替整页 `setUserRoles()` 保存
- 让前端直接逐条调用 `allow()` / `deny()`，而没有自己的后端保存层

## 下一步看什么

- 想先理解角色规则和用户绑定的职责边界：看 [角色与规则](/guide/roles-and-rules)
- 想先理解后台保存语义和缓存失效：看 [管理后台接入](/guide/site-preview-release)
- 想核对管理 API 的完整签名和返回值：看 [RoleManager](/api/role-manager) 和 [UserRoleManager](/api/user-roles)