# Menu Module API

从 `permission-core/menu` 导入。

```ts
import { createMenuPermission } from "permission-core/menu";
```

主要 API：

| API | 用途 |
|---|---|
| `createMenuPermission()` | 创建菜单权限管理器 |
| `getVisibleMenuTree(subject)` | 返回 subject 可见菜单树 |
| `getVisibleButtons(subject, pageId)` | 返回页面按钮状态 |
| `getRoutePermission(subject, path)` | 检查直接页面访问 |
| `getAuthorizationTree(scope, roleId)` | 生成角色授权树 |
| `saveRoleAuthorization(scope, roleId, input)` | 通过 `RoleManager` 保存授权变更 |
| `importFrontendManifest(scope, manifest)` | 导入菜单、页面、按钮资产 |
| `importApiManifest(scope, manifest)` | 导入接口绑定 |
| `validate(scope)` | 返回配置诊断 |
| `listAuditEntries(scope)` | 读取审计记录 |

## 构造与生命周期

```ts
createMenuPermission(options: MenuPermissionOptions): MenuPermissionManager
```

| 选项 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `core` | `PermissionCore` | 必填 | 已初始化的权限运行时 |
| `storage` | `MenuPermissionStorageAdapter` | `MemoryMenuStorageAdapter` | 菜单、API、审计和 revision 持久化 |
| `strictApiBindings` | `boolean` | `false` | required API 无权限时禁用可见按钮 |
| `cache` | `false \| { maxEntries?: number }` | 开启，500 条 | 菜单树和按钮 snapshot 缓存 |
| `extensions` | `MenuPermissionExtensionRegistry` | 空 registry | manifest loader、normalizer、validator |

应用显式管理资源时调用 `await manager.init()`；其他公开方法也会懒初始化。`close()` 幂等，会关闭菜单 storage、清空 snapshot，之后调用返回 `NOT_INITIALIZED`。

## 读取 API

```ts
getVisibleMenuTree(subject, options?): Promise<VisibleMenuNode[]>
getVisibleMenuSnapshot(subject, options?): Promise<MenuPermissionSnapshot<VisibleMenuNode[]>>
getVisibleButtons(subject, pageId, options?): Promise<ButtonPermissionMap>
getButtonPermissionSnapshot(subject, pageId, options?): Promise<MenuPermissionSnapshot<ButtonPermissionMap>>
getRoutePermission(subject, path): Promise<RoutePermissionState>
```

Snapshot 返回 `{ data, version, etag }`，version 由 storage revision 和有效权限 hash 组成。路由目标按 `page > menu > external/iframe` 选择；同优先级存在多个目标时返回 `reason: "route-conflict"`。

`ButtonPermissionState.reason` 可能是 `permission-denied`、`required-api-denied`、`disabled`、`not-found`。required API 通过 `permissionGroup` 和 `permissionMode: "any" | "all"` 求值；未分组 binding 保持历史 all-required 语义。

## Manifest API

```ts
importFrontendManifest(scope, manifest, options?): Promise<{
  nodes: ImportSummary;
  apiBindings?: ImportSummary;
}>
importApiManifest(scope, manifest, options?): Promise<ImportSummary>
loadFrontendManifest(scope, loaderName, source, options?): Promise<...>
loadApiManifest(scope, loaderName, source, options?): Promise<ImportSummary>
```

`ManifestImportOptions` 包含 `mode`、`actorId`、`reason`。`mode` 默认 `replace`；`merge` 只 upsert 本次传入 ID。`ImportSummary` 返回计数、单调递增 `revision` 以及 `changes.insertedIds/updatedIds/deletedIds`。

写入前会校验完整候选配置。节点、API 或审计写入失败时恢复两类资产；补偿也失败时抛出带原始 cause 和补偿 cause 的 `STORAGE_ERROR`。

## 角色授权与审计

```ts
getAuthorizationTree(scope, roleId): Promise<AuthorizationTreeNode[]>
saveRoleAuthorization(scope, roleId, input): Promise<PermissionAuditEntry>
listAuditEntries(scope): Promise<PermissionAuditEntry[]>
validate(scope): Promise<MenuValidationDiagnostic[]>
invalidateMenu(scope?): Promise<void>
```

授权树状态包括 `allow`、`deny`、`inherit-allow`、`inherit-deny`、`conflict`、`none`；`sourceRoleIds` 标明形成当前状态的角色来源。

`saveRoleAuthorization()` 接受 `allow`、`deny`、`revoke`、`actorId`、`reason`。它拒绝未知资产和同请求 allow/deny 冲突，记录稳定 added/removed diff 和 `role-authorization.save` 审计；规则写入或审计失败时恢复旧规则。

## Storage adapters

| Adapter | 使用场景 | 持久化与所有权 |
|---|---|---|
| `MemoryMenuStorageAdapter` | 测试和短示例 | 仅进程内存 |
| `FileMenuStorageAdapter({ path })` | 单进程部署 | schema version 文件原子替换；单进程/单写者 |
| `MonSQLizeMenuStorageAdapter({ msq, namespace?, ownsConnection? })` | 共享生产数据库 | scope collections、索引、revision、审计、实例内串行 mutation |

`MenuPermissionStorageAdapter` 必须实现节点/API 的 list、upsert、replace，`getRevision`、审计 list/append，以及可选 `init/close`。每个方法都必须携带 scope。manager 的补偿协议保护跨 store 操作；数据库多进程事务能力由底层平台负责。

## 扩展 registry

`MenuPermissionExtensionRegistry` 提供 `registerFrontendLoader`、`registerApiLoader`、`registerNodeNormalizer`、`registerApiBindingNormalizer`、`registerValidator`。loader 名称必须唯一；normalizer 按注册顺序和资产顺序执行；内置校验始终先执行，不能被移除。

自定义资源 scheme 通过 `core.resourceSchemes.register({ scheme, validate, match })` 注册，角色写入、鉴权、菜单校验和授权树会使用同一个 registry。

## 错误

| 错误码 | 常见原因 |
|---|---|
| `NOT_INITIALIZED` | core 未初始化，或 menu manager 已关闭 |
| `INVALID_ARGUMENT` | manifest 非法、未知资产/loader、重复 ID、授权冲突、扩展返回契约错误 |
| `INVALID_RESOURCE_PATH` / `INVALID_ACTION` | 权限 metadata 非法 |
| `ROLE_NOT_FOUND` | 授权目标角色不存在 |
| `STORAGE_ERROR` | 持久化失败；message 会说明是否已恢复旧状态 |

完整任务流程先看 [菜单权限](/zh/guide/menu-permissions)。
