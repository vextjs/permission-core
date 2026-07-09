# UserRoleManager

`pc.users` 负责用户和角色绑定关系。它关注的是“某个用户拥有哪些角色”，而不是“这些角色内部有哪些规则”。

## 完整 API

| 方法 | 签名 | 说明 |
|------|------|------|
| `assign` | `(userId, roleId)` | 给用户绑定一个角色；角色必须存在 |
| `revoke` | `(userId, roleId)` | 从用户上解绑一个角色 |
| `getUserRoles` | `(userId)` | 读取当前用户的角色列表 |
| `setUserRoles` | `(userId, roleIds)` | 批量覆盖用户角色 |
| `clearUserRoles` | `(userId)` | 清空用户所有角色 |

## 关键行为

### 公开写入方法会自动触发 `invalidate(userId)`

这和 `RoleManager` 的全量失效不同。因为用户绑定变化只影响当前用户，所以首版设计选择精确失效，保证权限立即生效，同时避免无意义的全量清缓存。

### `setUserRoles()` 更适合后台保存操作

如果你的管理后台是“表单整体保存用户角色”，那么 `setUserRoles()` 会比多次 `assign/revoke` 更稳定，因为它代表的是一次明确的整体覆盖。

它覆盖的是某一个用户的角色绑定，不是角色规则批量 API。角色内部规则仍然归 `RoleManager` 管。

### `setUserRoles()` 应先全量校验

更稳妥的做法是先验证所有 `roleId` 都存在，再统一写入，避免出现半成功半失败的绑定状态。

如果你的后台页是多选框、穿梭框或批量勾选角色，提交前也更适合先把 `roleIds` 去重，再交给 `setUserRoles()` 做整体覆盖。

## 典型用法

```typescript
await pc.users.assign('user-001', 'viewer');
await pc.users.assign('user-001', 'auditor');

await pc.users.setUserRoles('user-002', ['editor', 'viewer']);

const roles = await pc.users.getUserRoles('user-002');
```

## 解绑或清空角色怎么调用

```typescript
await pc.users.revoke('user-001', 'auditor');
await pc.users.clearUserRoles('user-002');
```

- `revoke()` 适合从一个用户上移除某个具体角色
- `clearUserRoles()` 更适合整体清空当前用户的全部角色

## 调用结果示例

### 这些方法成功时都返回 `Promise<void>`

- `assign`
- `revoke`
- `setUserRoles`
- `clearUserRoles`

例如：

```typescript
await pc.users.assign('user-001', 'viewer');
// Promise<void>
```

### `getUserRoles()` 返回角色 ID 数组

```typescript
const roles = await pc.users.getUserRoles('user-002');
```

返回结果结构如下：

```json
[
	"editor",
	"viewer"
]
```

如果当前用户还没有绑定任何角色，返回结果就是空数组：

```json
[]
```

## 适合场景

- 用户权限配置后台
- 登录后权限初始化
- 批量同步外部用户角色关系

## 和 RoleManager 的边界

- `pc.roles` 维护“角色是什么、规则是什么”
- `pc.users` 维护“某个用户绑定了哪些角色”

这两个入口应该在职责上严格分开，否则后续缓存失效和管理流程会变得混乱。

## 常见误区

- 因为用户绑定变化而直接 `invalidateAll()`
- 调完 `assign()`、`revoke()`、`setUserRoles()` 或 `clearUserRoles()` 后又重复手工 `invalidate(userId)`
- 用多次 `assign/revoke` 替代“整表保存”式的 `setUserRoles()`
- 把角色规则管理逻辑混进用户绑定入口

如果你要把角色页和用户页一起做成后台页面，可以继续看 [管理后台接入](/zh/guide/site-preview-release)。

如果你想看资源匹配的纯函数边界，可继续看 [matchResource](/zh/api/match-resource)。
