# Scoped Permissions API

Scoped API 按 tenant/application scope 隔离角色、绑定、规则与缓存 key。

## 用途与导入

```typescript
import type { PermissionScope, PermissionSubject } from 'permission-core';
```

请求鉴权使用 subject 方法，scope 内管理操作使用 `pc.scope(scope)`。

## 构造与类型

`PermissionScope` 必须包含 `tenantId`，可选 `appId`、`moduleId`、`namespace`。`PermissionSubject` 在此基础上增加 `userId`、可选 `roles` 与 `claims`。

`pc.scope(scope)` 返回 `PermissionCoreScopeContext`；`pc.forSubject(subject)` 返回绑定用户的 `PermissionCoreContext`。不要直接构造这两个 context class。

## 签名索引

| 接口面 | 签名 |
|---|---|
| Subject 检查 | `canSubject`；`cannotSubject`；`assertSubject` |
| Subject 读取 | `getPermissionsForSubject`；`getResourcesForSubject` |
| Subject context/cache | `forSubject`；`invalidateSubject` |
| Scope context | `scope(scope)` 后使用 `can/cannot/assert`、`for`、`forSubject` |
| Scoped 管理 | `scoped.roles`；`scoped.users` |
| Scoped 缓存 | `scoped.invalidate(userId)`；`scoped.invalidateScope()`；`pc.invalidateScope(scope)` |

## 行为与默认值

所有 scope 字段都参与稳定 scope key。Root `roles`、root `users` 与旧 `pc.can(userId, ...)` 使用 `defaultScope`；subject API 不会从默认 scope 推断缺失 tenant。

原生 scoped adapter 会隔离每条角色、绑定和规则。旧第三方 `StorageAdapter` 由 `LegacyScopedStorageAdapter` 包装，但只能服务 `defaultScope`。

## 错误与限制

`tenantId` 缺失/为空、`userId` 缺失，或 subject 与 bound context 冲突时，在权限判定前抛 `INVALID_ARGUMENT`。资源非法仍抛 `INVALID_RESOURCE_PATH`；断言拒绝抛 `PERMISSION_DENIED`。

`PermissionScope.namespace` 是逻辑授权分区；adapter `namespace` 是物理 collection 前缀，不产生租户隔离。Menu storage 也是独立的 scoped 契约。

## 最小示例

```typescript
const scope = { tenantId: 'tenant-a', appId: 'admin' };
const subject = { ...scope, userId: 'u-1' };
const scoped = pc.scope(scope);

await scoped.roles.create('admin', { label: 'Admin' });
await scoped.users.assign('u-1', 'admin');
await pc.assertSubject(subject, 'invoke', 'api:GET:/api/users');
```

## 相关页面

参见 [多租户权限](/zh/guide/multi-tenant)、[PermissionCore](/zh/api/permission-core) 与 [StorageAdapter](/zh/api/storage-adapter)。
