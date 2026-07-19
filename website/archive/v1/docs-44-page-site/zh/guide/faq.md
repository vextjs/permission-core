# 常见问题

## permission-core 是认证库吗？

不是。登录、Session、Token 和身份可信度由应用负责。permission-core 从字符串 `userId` 或完整 `PermissionSubject` 已经可用之后开始工作。

## 必须使用 MongoDB 吗？

不必。存储是适配器选择：`MemoryAdapter` 用于本地验证，`FileAdapter` 适合单进程，`MonSQLizeStorageAdapter` 是内置的共享生产路径。其他数据库需要自定义 `StorageAdapter`。

## HTTP-only 等于只能用内存吗？

不等于。HTTP-only 只决定使用接口资源和哪些运行时 API，不决定存储；接口规则可以放在任何受支持的适配器中。

## 为什么 `getResources()` 不能替代 `can()`？

`getResources()` 用于生成导航参考。后端仍要调用 `can()` 或 `assert()`，因为 deny、通配符和请求上下文都可能改变最终结果。

## `write` 是什么意思？

规则侧 `write` 授予 `create + update`；请求侧 `write` 要求两者同时成立。因此 payload 过滤通常应明确使用 `create` 或 `update`。

## 一个按钮可以要求多个 API 吗？

可以。`permission-core/menu` 通过 `permissionMode: "any" | "all"` 把一个操作绑定到多个 API。敏感操作启用 `strictApiBindings`，每个后端接口仍必须独立鉴权。

## 菜单生产数据该用什么存储？

共享生产状态使用 `MonSQLizeMenuStorageAdapter`；`FileMenuStorageAdapter` 只适合单进程。core 与 menu 是两套存储，并且必须明确唯一连接 owner。

## 多租户怎样安全失败？

使用显式 `PermissionSubject` 和 bound scope。tenant/app 缺失或冲突时返回 `INVALID_ARGUMENT`，不会静默回落到默认 scope。

## Vext 应启用哪些保护？

认证先运行；tenant 路由启用 `tenantRequired`；除非另一条已测试的 guard 明确消费相同元数据，否则保持 `guardRoutePermissions` 开启。

## 为什么必须调用 `init()` 和 `close()`？

`init()` 在鉴权前准备存储和运行时状态；`close()` 在优雅停机时按适配器所有权释放资源。

## 下一步

允许和拒绝两种结果都跑通后，使用 [接入检查清单](/zh/guide/integration-checklist) 完成上线前核对。
