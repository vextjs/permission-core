# 错误码

permission-core 为鉴权、校验、生命周期和存储失败提供稳定 error class 与 enum。

## 用途与导入

```typescript
import {
  PermissionCoreError,
  PermissionCoreErrorCode,
  isPermissionCoreError,
} from 'permission-core';
```

应用映射依赖稳定 code，内部 cause 留在日志，不进入公共响应。

## 构造与类型

`new PermissionCoreError(code, message, data?)` 继承 `Error`，公开只读 `code` 与可选 `data`。`isPermissionCoreError(value)` 是公共 type guard。

`PermissionCoreErrorCode` 有九个字符串值，覆盖权限拒绝、角色缺失/重复、循环继承、资源/action/参数非法、存储失败与未初始化。

## 签名索引

| API | 签名 |
|---|---|
| Error | `PermissionCoreError(code, message, data?)` |
| Type guard | `isPermissionCoreError(value): value is PermissionCoreError` |
| Enum | `PermissionCoreErrorCode` |

稳定 code 为 `PERMISSION_DENIED`、`ROLE_NOT_FOUND`、`ROLE_ALREADY_EXISTS`、`CIRCULAR_INHERITANCE`、`INVALID_RESOURCE_PATH`、`INVALID_ACTION`、`INVALID_ARGUMENT`、`STORAGE_ERROR`、`NOT_INITIALIZED`。

## 行为与默认值

Core 断言使用 `PERMISSION_DENIED`，manager 使用角色/冲突 code，validator 使用非法输入 code，adapter 把持久化失败包装为 `STORAGE_ERROR`，runtime 未准备好时使用 `NOT_INITIALIZED`。

认证失败通常由应用产生；Vext 边界映射成 `AUTH_REQUIRED`，Vext route 拒绝映射成 `AUTH_FORBIDDEN`。

## 错误与限制

不要把所有未知错误转换成 `403`，否则会隐藏 storage 与 lifecycle failure。公共 API 应保留稳定应用 code 和 request ID，但不暴露规则内容、stack、连接字符串或私有 payload。

Enum 本身不是 HTTP 映射。状态码与本地化消息由应用决定；测试应证明预期 code 被映射，未知失败会重新抛出。

## 最小示例

```typescript
try {
  await pc.assert(userId, 'invoke', resource);
} catch (error) {
  if (isPermissionCoreError(error) && error.code === PermissionCoreErrorCode.PERMISSION_DENIED) {
    return reply.status(403).send({ code: error.code });
  }
  throw error;
}
```

## 相关页面

参见 [错误响应映射](/zh/guide/error-response-mapping)、[PermissionCore](/zh/api/permission-core) 与 [vext Adapter API](/zh/api/vext-adapter)。
