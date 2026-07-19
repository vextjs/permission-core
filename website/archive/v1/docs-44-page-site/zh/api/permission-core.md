# PermissionCore

`PermissionCore` 是组合存储、缓存、RBAC manager、resource scheme 与运行时鉴权的公共入口。

## 用途与导入

```typescript
import { PermissionCore } from 'permission-core';
```

它负责运行时鉴权以及 `roles`、`users`、scoped context 入口。认证和业务数据查询仍由应用负责。

## 构造与类型

`new PermissionCore(options?: PermissionCoreOptions)`：

| 选项 | 类型 | 默认值 |
|---|---|---|
| `storage` | `StorageAdapter` | `MemoryAdapter` |
| `cache` | `CacheLike \| CacheOptions` | 内部 `PermissionCache` |
| `strict` | `boolean` | `true` |
| `defaultScope` | `PermissionScope` | 内置默认 scope |
| `resourceSchemes` | `ResourceSchemeDefinition[]` | 只有内置 scheme |

公共属性为 `roles: RoleManager`、`users: UserRoleManager` 和 `resourceSchemes: ResourceSchemeRegistry`。

## 签名索引

| 分组 | 签名 |
|---|---|
| 生命周期 | `init(): Promise<void>`；`close(): Promise<void>` |
| 基础检查 | `can/cannot(userId, action, resource)`；`assert(userId, action, resource)` |
| 行级 | `getRowScope`；`canRow/cannotRow`；`assertRow`；`filterRows` |
| 字段 | `filterFields(userId, action, resource, data, context?)` |
| 读取 | `getPermissions(userId)`；`getResources(userId, action?)` |
| Subject | `canSubject/cannotSubject`；`assertSubject`；subject 规则与资源读取 |
| Context | `for(userId)`；`forSubject(subject)`；`scope(scope)` |
| 缓存 | `invalidate(userId)`；`invalidateSubject`；`invalidateScope`；`invalidateAll` |

布尔方法返回 `Promise<boolean>`，断言返回 `Promise<void>`；行和字段过滤返回新数组或局部对象。

## 行为与默认值

使用 manager 或鉴权方法前必须调用 `init()`。Strict 默认开启，deny 优先于 allow，请求侧 `write` 要求 create 与 update 都通过。旧 `userId` API 和 root manager 使用 `defaultScope`；subject API 要求显式 tenant scope。

`getResources()` 只提供显隐结果，不能替代最终 `can()` / `assert()`。先做集合授权，再做行级过滤；先做行级授权，再做字段过滤。

## 错误与限制

初始化前调用抛 `NOT_INITIALIZED`。断言可抛 `PERMISSION_DENIED`；action、resource、subject 或 scope 非法分别使用 `INVALID_ACTION`、`INVALID_RESOURCE_PATH`、`INVALID_ARGUMENT`；存储失败使用 `STORAGE_ERROR`。

字段过滤只处理顶层属性。Context 变量不能替换 API user/subject。`close()` 关闭 runtime 自己拥有的资源；注入存储和缓存的所有权由对应实现决定。

## 最小示例

```typescript
const pc = new PermissionCore();
await pc.init();

await pc.roles.create('reader', { label: 'Reader' });
await pc.roles.allow('reader', 'read', 'db:orders');
await pc.users.assign('u-1', 'reader');

const allowed = await pc.can('u-1', 'read', 'db:orders');
await pc.close();
```

## 相关页面

参见 [权限鉴权](/zh/guide/check-permission)、[Scoped Permissions](/zh/api/scoped-permissions)、[RoleManager](/zh/api/role-manager) 与 [错误码](/zh/api/errors)。
