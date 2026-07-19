# 管理后台接入

管理后台通常同时编辑角色、角色规则和用户角色绑定。公共 manager API 已为自身写入处理缓存失效；只有直接写存储、外部同步或跨实例协调才需要手工失效。

可选 menu 模块增加目录、菜单、页面、按钮、API binding、授权树、revision 和审计记录。这些展示资产与 core `PermissionRule` 应保持分离。

## 拆分页面职责

| 页面 | 主要 API |
|---|---|
| 角色列表/详情 | `roles.list/get/update/inspect` |
| 角色授权树 | `menu.getAuthorizationTree()` / `menu.saveRoleAuthorization()` |
| 用户角色 | `users.getUserRoles/setUserRoles/assign/revoke` |
| 菜单/API 资产 | manifest import、`validate()`、revision、audit list |
| Subject 预览 | 精确 tenant subject 的菜单/按钮/接口快照 |

## 角色详情

1. `roles.get()` / `roles.update()` 处理角色元数据。
2. `roles.getRules()` 读取角色自身规则。
3. `roles.inspect()` 读取有效规则和继承链。
4. `roles.delete()` 删除角色。

`getRules()` 不包含继承结果；UI 需要最终有效状态时使用 `inspect()`。

## 保存角色规则

permission-core v1 没有通用角色规则批量 API。`roles.allow()` 与 `roles.deny()` 可为同一资源接收多个 action，但不是 `setRules()` 替代品。

后台保存前应：

- 校验每个 action 和 resource
- 按 `type + action + resource + where` 去重
- allow 与 deny 同时存在时分别展示
- 由自己的后端服务接收完整规则数组并调用公开 `RoleManager` 方法

不要让浏览器表单直接发起许多远程 `allow()` / `deny()`。后端保存服务应拒绝局部输入、计算 diff 并控制缓存抖动。业务代码直接调用 `StorageAdapter.setRules()` 时，必须自行承担缺失的校验和失效责任。

菜单授权编辑器使用一个带审计的后端命令：

```typescript
const audit = await menu.saveRoleAuthorization(scope, roleId, {
  allow: input.allow,
  deny: input.deny,
  revoke: input.revoke,
  actorId: request.user.id,
  reason: input.reason,
});
```

渲染 `sourceRoleIds` 以解释继承和冲突状态，不要把 allow 与 deny 压成一个 checkbox。

## 表单中的行级规则

行条件保存为结构化 `where` DSL。后端校验 field、operator、literal/valueFrom 形状和变量可用性；禁止提交原始 SQL、Mongo filter 或可执行表达式。

## 用户角色绑定

```typescript
await pc.users.setUserRoles('u-1', ['support', 'refund-reviewer']);
```

管理表单全量保存使用 `setUserRoles()`，小范围变化使用 `assign()` / `revoke()`。这些方法会自动失效该用户缓存。替换前校验所有角色存在，返回最终绑定列表，并刷新同一 tenant/app scope 下的 subject 预览。

## Manifest 与并发

- 前端/API manifest 是带 revision 的配置；权威快照用 `replace`，明确的部分所有权才用 `merge`。
- 发布变更前执行 `menu.validate(scope)`。
- 多人编辑同一 scope 时在后端做乐观 revision 检查。
- 记录 actor、reason、request ID、旧/新 revision、diff 和 compensation 状态。
- 存储或审计部分失败就是失败；完整操作未成功前不能显示成功。

## 错误映射

前端响应应清楚但不暴露连接、原始数据库错误或 stack。`ROLE_NOT_FOUND` 映射为过期编辑器/不存在，重复或继承冲突映射 `409`，校验错误映射 `400`，存储或补偿失败映射运行错误，并保留稳定 code 与 request ID。

## 下一步

继续看 [菜单权限](/zh/guide/menu-permissions)、[管理后台保存示例](/zh/examples/management-backend) 与 [错误响应映射](/zh/guide/error-response-mapping)。
