# Scoped Permissions API

从 `permission-core` 导入。

```ts
const scope = { tenantId: "tenant-a", appId: "admin" };
const subject = { ...scope, userId: "u-1" };

await pc.canSubject(subject, "read", "ui:menu:system.user");
await pc.assertSubject(subject, "invoke", "api:GET:/api/users");
```

新增 API：

| API | 用途 |
|---|---|
| `PermissionScope` | 租户、应用、模块和命名空间边界 |
| `PermissionSubject` | scope 加 `userId`、roles 和 claims |
| `canSubject()` / `assertSubject()` | subject 维度鉴权 |
| `forSubject()` | 绑定 subject 的链式上下文 |
| `scope()` | scope 维度 roles/users/checking 上下文 |
| `invalidateSubject()` | 失效一个 subject 缓存 |
| `invalidateScope()` | 失效一个 scope 下的规则缓存 |

## 类型

```ts
interface PermissionScope {
  tenantId: string;
  appId?: string;
  moduleId?: string;
  namespace?: string;
}

interface PermissionSubject extends PermissionScope {
  userId: string;
  roles?: string[];
  claims?: Record<string, unknown>;
}
```

`tenantId` 在运行时也必填，包括无类型 JavaScript 调用。其他字段用于同一租户内继续分区，全部字段都会进入稳定 `scopeKey`。

## Subject 方法

```ts
canSubject(subject, action, resource): Promise<boolean>
cannotSubject(subject, action, resource): Promise<boolean>
assertSubject(subject, action, resource): Promise<void>
getPermissionsForSubject(subject): Promise<PermissionRule[]>
getResourcesForSubject(subject, action?): Promise<string[]>
forSubject(subject): PermissionCoreContext
invalidateSubject(subject): Promise<void>
```

这些方法先校验 subject，再在其精确 scope 中执行。`assertSubject()` 无权限时抛 `PERMISSION_DENIED`；scope 缺失或非法时，会在权限判断前抛 `INVALID_ARGUMENT` 或 `INVALID_RESOURCE_PATH`。

## 绑定 Scope 的上下文

```ts
const scoped = pc.scope(scope);

scoped.can(userId, action, resource): Promise<boolean>
scoped.assert(userId, action, resource): Promise<void>
scoped.getPermissions(userId): Promise<PermissionRule[]>
scoped.getResources(userId, action?): Promise<string[]>
scoped.for(userId): PermissionCoreContext
scoped.forSubject(subject): PermissionCoreContext
scoped.roles: RoleManager
scoped.users: UserRoleManager
scoped.invalidate(userId): Promise<void>
scoped.invalidateScope(): Promise<void>
```

`forSubject()` 要求 subject 的每个 scope 字段都与绑定 scope 一致；不一致时直接抛错，不会把 subject 静默放进另一个租户鉴权。

## Storage 与缓存行为

原生 scoped adapter 会把角色、用户绑定和规则写在各自 scope key 下。旧第三方 `StorageAdapter` 会被 `LegacyScopedStorageAdapter` 包装，只支持 `defaultScope`；访问其他 scope 时抛 `INVALID_ARGUMENT`。

规则缓存 key 包含 scope。`invalidateSubject()` 只清一个 subject，`invalidateScope()` 清一个 scope 下全部权限规则缓存，两者都不会清理其他租户。

## 兼容规则

- 旧 `pc.can(userId, ...)`、根 `pc.roles`、根 `pc.users` 使用 `defaultScope`。
- subject/scoped API 不会用旧默认值推断缺失 `tenantId`。
- `PermissionScope.namespace` 是逻辑权限分区；adapter 的 `namespace` option 是物理 collection 前缀，不提供租户隔离。
- 菜单 storage 是独立契约；启用 `permission-core/menu` 时必须另外配置 scope-aware menu adapter。

可运行设置与失败恢复见 [多租户权限](/zh/guide/multi-tenant)。
