# Menu Module API

可选 menu 模块建模目录、菜单、页面、按钮、后端 API binding、授权树、revision 与 audit event。

## 用途与导入

```typescript
import { createMenuPermission } from 'permission-core/menu';
```

Menu 状态用于导航与授权编辑器；后端接口仍通过 core 或框架 guard 做最终鉴权。

## 构造与类型

`createMenuPermission(options: MenuPermissionOptions): MenuPermissionManager` 必须传 `core`，可选 `storage`、`strictApiBindings`、`cache`、`extensions`。

默认使用 `MemoryMenuStorageAdapter`、`strictApiBindings:false`、启用 snapshot cache、`maxEntries:500`。内置持久化实现还有 `FileMenuStorageAdapter` 与 `MonSQLizeMenuStorageAdapter`。

## 签名索引

| 分组 | 方法 |
|---|---|
| 生命周期 | `init`；`close`；`invalidateMenu` |
| 显隐 | `getVisibleMenuTree`；`getVisibleMenuSnapshot`；`getVisibleButtons`；`getButtonPermissionSnapshot`；`getRoutePermission` |
| 导入 | `importFrontendManifest`；`importApiManifest`；loader 变体 |
| 校验 | `validate(scope)` |
| 授权 | `getAuthorizationTree`；`saveRoleAuthorization` |
| 审计 | `listAuditEntries` |

Storage adapter 提供 nodes/API bindings 的 list、upsert、replace，以及 revision 与 audit 方法。

## 行为与默认值

Manifest 是 scope-aware、带 revision 的配置。`replace` 表示权威快照，`merge` 只用于明确的部分所有权。同组 API binding 使用 `permissionGroup`，并选择 `permissionMode: "any" | "all"`。

`saveRoleAuthorization()` 校验资产、写入 core rule、追加 audit，并在部分失败时尝试 compensation。Snapshot 包含 `version` 与 `etag`。

授权树节点通过 `sourceRoleIds` 解释继承和冲突来源。自定义 resource scheme 必须先通过 `core.resourceSchemes.register()` 注册，再执行 menu 校验。

## 错误与限制

树、binding、scheme 或授权输入非法时抛 `INVALID_ARGUMENT`；角色不存在用 `ROLE_NOT_FOUND`；存储和补偿失败用 `STORAGE_ERROR`。Manager 关闭后不能继续复用。

Menu 显隐不能独立授权后端。Core storage 与 menu storage 是两套契约；File 只适合单进程，共享 MonSQLize 连接必须只有一个 owner。

## 最小示例

```typescript
const menu = createMenuPermission({
  core: pc,
  strictApiBindings: true,
});

await menu.init();
const tree = await menu.getVisibleMenuTree(subject);
await menu.close();
```

## 相关页面

参见 [菜单权限](/zh/guide/menu-permissions)、[管理后台接入](/zh/guide/site-preview-release) 与 [管理后台保存示例](/zh/examples/management-backend)。
