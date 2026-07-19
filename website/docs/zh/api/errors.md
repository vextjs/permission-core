# 错误 API

## 用途与前置条件

所有领域失败都使用从 `permission-core` 导出的 `PermissionCoreError`。按 `code` 与 `details.kind` 分支，不要解析 message 文本。`can()` 返回的布尔拒绝不是异常；`assert()` 会把同一拒绝转换为 `PERMISSION_DENIED`。

## 签名

```ts
class PermissionCoreError extends Error {
  readonly code: PermissionCoreErrorCode;
  readonly details?: PermissionCoreErrorDetails;
  readonly retryable: boolean;
  readonly committed?: boolean;
  readonly operationId?: string;
}
```

Details discriminator 包括 `validation`、`limit-exceeded`、`data-value-unsupported`、`close-timeout`、`revision-conflict`、`read-conflict`、`preview-stale`、`cursor-stale`、`preview-required`、`capacity-risk-ack-required`、`persisted-state-invalid`、`unexpected-post-image-field`、`schema-version-mismatch`、`schema-contract-mismatch`、`database-failure`、`audit-lookup`、`reconcile-superseded`。

## 响应与副作用

Vext 插件将错误映射为以下公开 JSON 结构，并保留请求/操作关联：

```json
{
  "code": "PERMISSION_DENIED",
  "message": "The subject is not allowed to invoke this route.",
  "retryable": false,
  "requestId": "req-42"
}
```

状态为 `500` 时，插件把公开 message 替换为 `Internal Server Error`。仅在存在时包含 `details`、`committed`、`operationId`。

## 失败与限制

| Vext 状态 | 错误码 |
|---|---|
| 400 | `INVALID_ARGUMENT`、`INVALID_ACTION`、`INVALID_RESOURCE`、`INVALID_FILTER`、`INVALID_POLICY`、`POLICY_CONTEXT_MISSING`、`INVALID_CURSOR`、`MENU_HIERARCHY_INVALID`、`DATA_OPERATION_UNSUPPORTED`、`DATA_BULK_SCOPE_MUTATION_UNSAFE`；caller-input `LIMIT_EXCEEDED`/`DATA_VALUE_UNSUPPORTED` |
| 401 | `VEXT_AUTH_REQUIRED`、`INVALID_SUBJECT`、`SCOPE_CONFLICT` |
| 403 | `PERMISSION_DENIED`、`FIELD_PERMISSION_DENIED` |
| 404 | `ROLE_NOT_FOUND`、`MENU_NOT_FOUND`、`API_BINDING_NOT_FOUND`、`AUDIT_ENTRY_NOT_FOUND` |
| 409 | `REVISION_CONFLICT`、`CURSOR_STALE`、`IDEMPOTENCY_CONFLICT`、`PREVIEW_REQUIRED`、`PREVIEW_STALE`、`ROLE_ALREADY_EXISTS`、`ROLE_IN_USE`、`CIRCULAR_INHERITANCE`、`MENU_ALREADY_EXISTS`、`DEPENDENCY_EXISTS`、`API_BINDING_ALREADY_EXISTS`、`STALE_REFERENCE` |
| 503 | `NOT_INITIALIZED`、`CORE_CLOSED`、`CORE_CLOSE_TIMEOUT`、`SCHEMA_VERSION_MISMATCH`、`SCHEMA_CONTRACT_MISMATCH`、`PERSISTED_STATE_INVALID`、`DATABASE_UNAVAILABLE`、`READ_CONFLICT`、`VEXT_ROUTE_RESTART_REQUIRED`；persisted/budget `LIMIT_EXCEEDED`/`DATA_VALUE_UNSUPPORTED`；retryable `DATABASE_ERROR`/`TRANSACTION_FAILED` |
| 500 | `INVALID_CONFIGURATION`、`MONSQLIZE_CONTRACT_UNSUPPORTED`、`SCOPE_FIELD_MAPPING_REQUIRED`、`VEXT_MONSQLIZE_REQUIRED`、`VEXT_MONSQLIZE_INCOMPATIBLE`、`VEXT_APP_EXTENSION_CONFLICT`、`VEXT_AUTH_EXTENSION_CONFLICT`、`VEXT_ROUTE_PERMISSION_INVALID`、`INDEX_CONFLICT`；non-retryable `DATABASE_ERROR`/`TRANSACTION_FAILED` |

不要只根据状态码重试。revision/preview/cursor 冲突要重新读取；配置/schema/持久化状态要先修复；不确定写入使用原幂等键。`committed: true` 表示即使后续运维步骤失败，状态变化也已经发生。

## 示例

```ts
import { PermissionCoreError } from 'permission-core';

try {
  await subject.assert('delete', 'db:orders');
} catch (error) {
  if (error instanceof PermissionCoreError && error.code === 'PERMISSION_DENIED') {
    return { status: 403, code: error.code };
  }
  throw error;
}
```

```json
{ "status": 403, "code": "PERMISSION_DENIED" }
```

## 相关内容

参见[故障排查](/zh/guide/troubleshooting)、[生产运维](/zh/guide/production-operations)和[Vext 插件 API](/zh/api/vext-plugin)。
