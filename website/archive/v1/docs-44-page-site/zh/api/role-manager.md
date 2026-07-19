# RoleManager

`RoleManager` 管理角色元数据、allow/deny 规则、继承和有效权限检查。

## 用途与导入

```typescript
import type { RoleManager } from 'permission-core';
```

默认 scope 使用 `pc.roles`，显式租户 scope 使用 `pc.scope(scope).roles`。不要直接构造 manager。

## 构造与类型

`RoleCreateOptions` 必须提供 `label`，可选 `parent`、`description`；`RoleUpdateOptions` 接受局部元数据；`RowRuleOptions` 接受结构化 `where`。

`RoleData` 包含 id、label、parent、description 与时间戳。`RoleInspection` 包含 `role`、`ownRules`、`effectiveRules`、`roleChain`。

## 签名索引

| 分组 | 方法 |
|---|---|
| 元数据 | `create(id, options)`；`update(id, options)`；`delete(id)` |
| 读取 | `get(id)`；`list()` |
| 规则写入 | `allow`；`deny`；`revokeRule`；`clearRules` |
| 规则读取 | `getRules`；`getEffectiveRules` |
| 继承 | `getRoleChain` |
| 详情 | `inspect` |

所有写方法返回 `Promise<void>`；读取返回 `RoleData`、规则数组、继承链或 `RoleInspection`。

## 行为与默认值

继承为单 parent。多角色合并后 deny 仍优先于 allow；规则写入会归一化 action 数组并去重相同 rule tuple。

`getRules()` 只返回角色自身规则，`getEffectiveRules()` 包含 parent chain。公共写方法会失效当前 scope 缓存。删除角色会删除自身规则和直接用户绑定。

## 错误与限制

重复 ID 抛 `ROLE_ALREADY_EXISTS`，角色不存在抛 `ROLE_NOT_FOUND`，循环继承抛 `CIRCULAR_INHERITANCE`；action/resource/where 非法使用对应校验错误。

有 child role 时禁止删除。v1 没有公共通用批量 `setRules()`。管理后台应校验完整表单提交并调用公开方法，不能把 adapter 写入直接暴露给业务。

## 最小示例

```typescript
await pc.roles.create('operator', { label: 'Operator' });
await pc.roles.allow('operator', ['read', 'update'], 'db:orders');

const detail = await pc.roles.inspect('operator');
await pc.roles.revokeRule('operator', 'update', 'db:orders');
```

## 相关页面

参见 [角色与规则](/zh/guide/roles-and-rules)、[管理后台接入](/zh/guide/site-preview-release) 与 [UserRoleManager](/zh/api/user-roles)。
