# 错误 API

## 用途与前置条件

所有领域失败都使用从 `permission-core` 导出的 `PermissionCoreError`。按 `code` 与 `details.kind` 分支，不要解析 message 文本。`can()` 返回的布尔拒绝不是异常；`assert()` 会把同一拒绝转换为 `PERMISSION_DENIED`。

## 我想做什么

| 目标 | 入口 |
|---|---|
| 捕获并分类 permission-core 错误 | [`PermissionCoreError`](#permission-core-error) |
| 判断是否能安全重试 | 读取 `retryable`、`committed` 和 `operationId` |
| 区分业务拒绝和系统异常 | 使用 `can()` 布尔值或捕获 `subject.assert()` 抛错 |
| 查找具体错误码含义 | [失败与限制](#failures-and-limits) |

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

## 错误对象详解

<!-- docs:params owner=PermissionCoreError locale=zh -->

| 字段 | 类型/来源 | 调用方怎样使用 |
|---|---|---|
| `code` | `PermissionCoreErrorCode` | 稳定机器分支主键；业务逻辑按它判断，不解析 message。 |
| `details.kind` | 判别联合 | 对同一 code 的具体原因继续收窄；例如 revision conflict 读取 owner/expected/current。 |
| `retryable` | `boolean` | 只表示错误类别允许在**修复前置条件后**重试，不代表立即原样无限重试。 |
| `committed` | 可选 boolean | `true` 表示数据库状态已提交；后续故障不能通过重复写入“回滚”。 |
| `operationId` | 可选 string | 关联已开始/已提交操作的审计证据。 |
| `message` | string | 面向维护者的诊断；不作为代码分支，也不保证适合直接暴露。 |
| `cause` | Error cause | 保留底层原因，仅在受控日志中使用。 |

<span id="permission-core-error-class"></span>
### `PermissionCoreError`

<!-- docs:method name=PermissionCoreError locale=zh -->

- **用途**：表示 permission-core 的领域/运行时失败；正常消费者主要捕获它，而不是自行构造。
- **参数**：构造细节不是稳定的消费契约；捕获后读取上表字段，尤其是 `code`、`details.kind`、`retryable` 与 `committed`。
- **识别**：同一包实例中使用 `error instanceof PermissionCoreError`，再按 `error.code/details.kind` 收窄。
- **状态影响**：错误对象本身不修改状态；`committed` 描述抛错前的写入事实。
- **原始返回**：它是被抛出或 reject 的 `PermissionCoreError` 实例，不是 HTTP JSON；Vext 的公开错误响应由插件另行映射。
- **边界**：`can()` 的 `false` 是正常拒绝结果，不会创建 error；需要异常控制流时调用 `assert()`。

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

这是 **Vext HTTP error response**，不是 Node.js `PermissionCoreError` 对象的直接 JSON 序列化。Vext 会按公开边界选择字段，并在 500 时隐藏内部 message。

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

这是示例 handler 自行返回的业务 HTTP 摘要。`subject.assert()` 的原始行为是：允许时 resolve `void`；拒绝时 reject `PermissionCoreError`。catch 中的返回对象不由 permission-core 自动生成。

推荐恢复顺序：

1. `REVISION_CONFLICT/CURSOR_STALE/PREVIEW_STALE`：重新读取当前状态，重新构造用户确认并重试，不复用旧 token/cursor。
2. `DATABASE_UNAVAILABLE/READ_CONFLICT` 且 `retryable=true`：采用宿主有界退避；先检查 `committed`，保留原 idempotency key。
3. `INVALID_*`、权限拒绝、字段拒绝：修正调用或权限，不原样重试。
4. schema/config/persisted-state 错误：停止 readiness，修复部署契约后再启动。

## 相关内容

参见[故障排查](/zh/guide/troubleshooting)、[生产运维](/zh/guide/production-operations)和[Vext 插件 API](/zh/api/vext-plugin)。
