# 角色与规则

角色包含权限规则，用户通过角色绑定获得权限。

## 最小角色流程

```typescript
await pc.roles.create('finance-ops', { label: 'Finance Operations' });
await pc.roles.allow('finance-ops', 'invoke', 'GET:/api/refunds');
await pc.roles.allow('finance-ops', 'read', 'db:refunds');
await pc.users.setUserRoles('u-100', ['finance-ops']);
```

## 规则结构

```typescript
{
  type: 'allow',
  action: 'read',
  resource: 'db:transactions',
  where: {
    field: 'merchantId',
    op: 'eq',
    valueFrom: 'merchantId',
  },
}
```

规则可以是 `allow` 或 `deny`；deny 优先于 allow。

## 继承

子角色继承父角色规则。继承适合稳定的组织角色，不适合为每个临时例外建立一层角色。

```typescript
await pc.roles.create('finance-admin', {
  label: 'Finance Admin',
  parent: 'finance-ops',
});
```

## 查看有效权限

```typescript
const chain = await pc.roles.getRoleChain('finance-admin');
const rules = await pc.roles.getEffectiveRules('finance-admin');
const inspection = await pc.roles.inspect('finance-admin');
```

`inspect()` 一次返回角色、自身规则、有效规则和继承链，适合角色详情页与联调工具。

## 去重边界

管理后台保存前，把相同 `type + action + resource + where` 视为重复输入。相同 `action + resource` 可以同时存在 allow 与 deny，运行时仍按 deny-first 判定。

## 下一步

管理后台的保存与回滚边界见 [管理后台接入](/zh/guide/site-preview-release)。
