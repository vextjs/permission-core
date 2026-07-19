# 审计与健康 API

## 用途与前置条件

公开运维面由 `init()`/`health()` 以及管理变更返回的审计和 revision 证据组成。permission-core 在事务中写入持久化内部审计行，但有意不公开通用审计日志查询 manager。

## 签名

```ts
pc.init(): Promise<PermissionCoreHealth>
pc.health(): Promise<PermissionCoreHealth>

interface MutationResult<T> {
  committed: true;
  changed: boolean;
  data: T;
  revision: number;
  revisions: RevisionVector;
  operationId: string;
  auditId: string;
  replayed: boolean;
  cache: { status: 'not-needed' | 'completed' | 'bypassed' | 'degraded'; reason?: string };
  warnings: BoundedDetails<ManagementWarning>;
  detailBudget: ResponseDetailBudget;
}
```

管理选项可以包含 `actorId`、`reason`、`requestId`、`idempotencyKey`。这些值会成为有界关联证据，但不会授予变更权限。

## 响应与副作用

`PermissionCoreHealth` 报告 lifecycle/database/schema/token/cache/audit 状态及 namespace hash。`status: 'degraded'` 表示数据库可用，但 schema mismatch、缓存事件或待处理缓存结果需要处置。变更的审计证据与状态变化一起提交；提交后的缓存结果随后可能完成、绕过或被协调。

```json
{
  "status": "degraded",
  "lifecycle": "ready",
  "database": { "status": "up" },
  "cache": {
    "permissionLayer": "enabled",
    "invalidationIncidentActive": true,
    "invalidationFailures": 1,
    "invalidationRiskUntil": 1780000000000
  },
  "audit": {
    "pendingCacheOutcomes": { "value": 1, "cap": 1000, "truncated": false }
  }
}
```

## 失败与限制

健康计数上限是 `1000`；`truncated: true` 表示实际总量更大。数据库不可用时，health 可以返回 `down` 而不是抛错；错误配置或初始化失败也会保留在 `lastInitError`。Audit ID 是关联 handle，不是受支持的公开查询 API。应用不要将直接读取内部权限集合当作契约。

## 示例

```ts
const result = await scoped.roles.create(
  { id: 'operator', label: 'Operator' },
  { actorId: 'admin-7', reason: 'Initial setup', requestId: 'req-42', idempotencyKey: 'role:operator:v1' },
);
businessAudit.info({ operationId: result.operationId, auditId: result.auditId });
```

```json
{
  "committed": true,
  "operationId": "operation_...",
  "auditId": "audit_...",
  "replayed": false,
  "cache": { "status": "completed" }
}
```

## 相关内容

参见[生产运维](/zh/guide/production-operations)、[缓存](/zh/guide/cache)和[错误 API](/zh/api/errors)。
