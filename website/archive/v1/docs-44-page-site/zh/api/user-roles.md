# UserRoleManager

`UserRoleManager` 在一个 permission scope 内管理用户与角色的直接绑定。

## 用途与导入

```typescript
import type { UserRoleManager } from 'permission-core';
```

默认 scope 使用 `pc.users`，租户 scope 使用 `pc.scope(scope).users`。Manager 由 `PermissionCore` 创建。

## 构造与类型

绑定使用字符串 `userId` 和字符串 role ID 数组。Manager 通过父 core 的同一 scoped storage 校验角色是否存在。

不需要公共构造配置；缓存失效与 scope 都从父 runtime 继承。

## 签名索引

| 方法 | 用途 |
|---|---|
| `assign(userId, roleId)` | 追加一个尚未绑定的角色 |
| `revoke(userId, roleId)` | 移除一个角色 |
| `getUserRoles(userId)` | 读取直接 role ID |
| `setUserRoles(userId, roleIds)` | 覆盖全部直接 role ID |
| `clearUserRoles(userId)` | 清除全部直接绑定 |

写方法返回 `Promise<void>`，读取返回 `Promise<string[]>`。

## 行为与默认值

`setUserRoles()` 去重输入，并在一次覆盖写入前校验全部角色。已有绑定再次 `assign()` 是幂等的。公共写方法只失效当前 scope 中受影响用户的规则缓存。

管理表单全量保存使用 replacement，小命令使用 assign/revoke。返回值是直接绑定，不是展开继承后的有效权限。

## 错误与限制

空 user/role ID 抛 `INVALID_ARGUMENT`；绑定或替换到不存在角色时抛 `ROLE_NOT_FOUND`；存储失败继续作为 storage error 上抛。

Manager 不认证用户、不创建角色，也不返回有效规则。若不能接受 last-write-wins，管理后台并发保存需要应用级 revision 策略。

## 最小示例

```typescript
await pc.users.setUserRoles('u-1', ['support', 'auditor']);
const roleIds = await pc.users.getUserRoles('u-1');
await pc.users.revoke('u-1', 'auditor');
```

## 相关页面

参见 [RoleManager](/zh/api/role-manager)、[管理后台接入](/zh/guide/site-preview-release) 与 [Scoped Permissions](/zh/api/scoped-permissions)。
