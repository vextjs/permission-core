# 权限鉴权

主要运行时检查是 `can`、`cannot` 和 `assert`。

## 布尔检查

```typescript
const ok = await pc.can('u-1', 'invoke', 'GET:/api/orders');
```

需要布尔值并由调用方决定响应时使用 `can()`。

## 断言

```typescript
await pc.assert('u-1', 'invoke', 'GET:/api/orders');
```

路由 guard 或 Service 方法需要无权限立即抛错时使用 `assert()`。

## 否定辅助方法

```typescript
const blocked = await pc.cannot('u-1', 'invoke', 'POST:/api/refunds');
```

`cannot()` 是 `can()` 否定结果的语义包装。

## Deny 优先

一个角色允许、另一个角色拒绝同一资源时，deny 获胜。strict 模式默认开启；deny 会先于 allow 解析，被拒绝资源也会从 `getResources()` 的显隐结果中移除。

## Context

部分行级和字段检查会从 context 读取变量：

```typescript
await pc.can('u-1', 'read', 'db:transactions', {
  merchantId: 'm-100',
});
```

当前 `userId` 仍来自 API 参数；context 中的 `userId` 不能覆盖调用者身份。

## 请求侧 `write`

规则侧 `write` 展开为 create 与 update 授权；请求侧 `write` 要求两项都通过，是 AND 语义。过滤 payload 时优先传明确的 `create` 或 `update`。

## Subject 与租户检查

```typescript
const subject = { tenantId: 'tenant-a', appId: 'admin', userId: 'u-1' };
await pc.assertSubject(subject, 'invoke', 'api:POST:/api/refunds');
```

Subject API 要求显式 tenant 和精确 scope。subject 与 `pc.scope(scope)` 绑定范围冲突时抛出 `INVALID_ARGUMENT`，不会回退到默认租户。

## 行级与字段检查

集合授权、行范围和字段过滤是三个独立决定：

```typescript
await pc.assert(userId, 'read', 'db:transactions');
const rowScope = await pc.getRowScope(userId, 'read', 'db:transactions', context);
const rows = await repository.findMany({ where: rowScope.where });
const visible = await pc.filterRows(userId, 'read', 'db:transactions', rows, context);
const response = await Promise.all(
  visible.map((row) => pc.filterFields(userId, 'read', 'db:transactions', row)),
);
```

不要把行谓词塞回接口资源，也不要只靠 `can()` 过滤数据集。

## UI 显隐不是最终鉴权

`getResources()` 用于菜单与按钮显隐，服务端仍以 `can()` 或 `assert()` 为最终决定点。菜单的 `permissionMode: "any" | "all"` 和 Vext 的 `guardRoutePermissions` 都是同一核心模型上的集成能力，不替代后端鉴权。

## 典型请求顺序

1. 认证并解析租户身份。
2. 构造规范化接口资源。
3. 执行 `assertSubject()` 或框架 guard。
4. 在 Service 中检查集合与行权限。
5. 过滤响应或写入字段。
6. 只把预期授权错误映射为 `403`，存储和生命周期错误继续上抛。
