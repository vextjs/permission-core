# PermissionCoreContext

`PermissionCoreContext` 绑定 user 或 subject，让连续鉴权不必重复传身份参数。

## 用途与导入

```typescript
import type { PermissionCoreContext } from 'permission-core';
```

通常通过 `pc.for(userId)`、`pc.forSubject(subject)` 或 scoped context 获取；类型导入可用于 Service 签名。

## 构造与类型

不要直接调用构造器。`pc.for(userId)` 绑定默认 scope；`pc.forSubject(subject)` 校验并绑定 subject 的精确 scope；`pc.scope(scope).for(userId)` 绑定显式 scope。

Context 保留绑定身份，并复用父 `PermissionCore` 的 checker 与 resource registry。

## 签名索引

| 分组 | 方法 |
|---|---|
| 基础 | `can`；`cannot`；`assert` |
| 行级 | `getRowScope`；`canRow`；`cannotRow`；`assertRow`；`filterRows` |
| 字段 | `filterFields` |
| 读取 | `getPermissions`；`getResources(action?)` |

每个方法省略已绑定身份，action、resource、data 和可选 context 仍显式传入。

## 行为与默认值

方法沿用父 core 的 strict/deny 语义与缓存行为。Bound context 只是便捷接口，不是新的权限模型或缓存分区。

一次请求或 Service 操作中多次检查同一 subject 时使用它。角色管理与缓存失效仍留在 `PermissionCore` 或 `PermissionCoreScopeContext`。

## 错误与限制

创建 subject context 会校验租户 scope，可能抛 `INVALID_ARGUMENT`。运行方法与 core 一样可能抛 `NOT_INITIALIZED`、`INVALID_ACTION`、`INVALID_RESOURCE_PATH`、`PERMISSION_DENIED`、`STORAGE_ERROR`。

可选 context 中名为 `userId` 的字段不能替换已绑定身份。该 context 不暴露 `roles`、`users`、`invalidate` 或生命周期方法。

## 最小示例

```typescript
const auth = pc.forSubject({
  tenantId: 'tenant-a',
  appId: 'admin',
  userId: 'u-1',
});

await auth.assert('invoke', 'api:GET:/api/orders');
const fields = await auth.filterFields('read', 'db:orders', order);
```

## 相关页面

参见 [PermissionCore](/zh/api/permission-core)、[Scoped Permissions](/zh/api/scoped-permissions) 与 [权限鉴权](/zh/guide/check-permission)。
