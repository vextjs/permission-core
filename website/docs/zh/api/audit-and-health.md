# 审计与健康 API

## 用途与前置条件

公开运维面由 `init()`/`health()` 以及管理变更返回的审计和 revision 证据组成。permission-core 在事务中写入持久化内部审计行，但有意不公开通用审计日志查询 manager。

## 我想做什么

| 目标 | 入口 |
|---|---|
| 初始化或检查 core 是否可用 | [`pc.init()`](#audit-init)、[`pc.health()`](#audit-health) |
| 判断多实例 token/cursor 是否稳定 | 读取 `health.tokens` |
| 关联一次管理写入的审计证据 | 读取 mutation 返回的 `operationId`、`auditId`、`revisions` |
| 处理 degraded/down 状态 | [失败与限制](#failures-and-limits) |

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

管理选项可以包含 `actorId`、`reason`、`requestId`、`idempotencyKey`。这些值会成为有界关联证据，但不会授予变更权限。直接写入时，如果提供 `requestId` 且没有显式 `idempotencyKey`，核心会自动派生内部幂等键。

## 方法与字段详解

<span id="audit-init"></span>
### `pc.init()`

<!-- docs:method name=init locale=zh -->

- **用途**：校验 MonSQLize 能力、初始化权限 schema/index、验证资源方案并进入 ready。
- **参数**：无；构造 options 已保存在 core。
- **状态影响**：首次成功会改变 core lifecycle；重复并发初始化共享同一初始化过程，成功后不应再次作为迁移命令调用。
- **原始返回**：`Promise<PermissionCoreHealth>`，直接返回 health 对象，没有 `data` envelope。
- **失败**：配置、schema contract、索引或数据库失败会阻止 ready，并在可用时记录 `lastInitError`。

<span id="audit-health"></span>
### `pc.health()`

<!-- docs:method name=health locale=zh -->

- **用途**：读取当前 core、数据库、schema、token、缓存和审计协调状态。
- **参数**：无。
- **状态影响**：只读；数据库 down 可以体现在返回值而不是抛错。
- **原始返回**：`Promise<PermissionCoreHealth>`；`status` 是聚合状态，仍应读取每个子域定位原因。

<!-- docs:params owner=PermissionCoreHealth locale=zh -->

| 字段 | 怎样读取 |
|---|---|
| `status/lifecycle/initialized` | `up` 可服务；`degraded` 需处置但数据库可能仍 up；`down` 不应通过 readiness。 |
| `namespace` | collectionPrefix、资源方案 digest 和命名空间身份；多实例应一致。 |
| `database` | MonSQLize/Mongo 健康及最后检查时间；`unknown` 不等于 up。 |
| `schema` | expected version/contract 与 mismatch 计数；`truncated` 时实际数量可能更大。 |
| `tokens` | ephemeral/configured 及跨实例稳定性；preview/cursor 跨实例依赖 configured secret。 |
| `cache` | 权限层启用状态、读回退、失效事故与风险截止时间。`backendState='opaque'` 不证明后端健康。 |
| `audit.pendingCacheOutcomes` | 数据库已提交但缓存结果仍待协调的操作数。 |
| `lastInitError` | 最近初始化失败的 code/message；不是当前数据库探活的替代。 |

<!-- docs:params owner=MutationAuditOptions locale=zh -->

| 选项 | 是否改变权限 | 真实用途 |
|---|:---:|---|
| `actorId` | 否 | 记录谁发起管理变更。 |
| `reason` | 否 | 记录为什么变更。 |
| `requestId` | 否 | 与宿主请求/日志关联；存在时核心会自动派生内部幂等键。 |
| `idempotencyKey` | 否 | 高级覆盖项；接入外部幂等协议时使用。相同 key 不同 input 会冲突。 |

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

这是 `PermissionCoreHealth` 原始对象的节选。健康响应没有 `committed` 或 `operationId`；那些字段属于 mutation response。

<span id="failures-and-limits"></span>

## 失败与限制

健康计数上限是 `1000`；`truncated: true` 表示实际总量更大。数据库不可用时，health 可以返回 `down` 而不是抛错；错误配置或初始化失败也会保留在 `lastInitError`。Audit ID 是关联 handle，不是受支持的公开查询 API。应用不要将直接读取内部权限集合当作契约。

## 示例

```ts
const result = await scoped.roles.create(
  { id: 'operator', label: 'Operator' },
  { actorId: 'admin-7', reason: 'Initial setup', requestId: 'req-42' },
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

这是 `roles.create()` 原始 `MutationResult<Role>` 的审计字段节选，不是单独的“写审计”方法响应。真正的新角色仍在 `result.data`，完整 envelope 见[公共响应合同](/zh/api/core-and-contexts#common-response-contracts)。

| 字段 | 后续动作 |
|---|---|
| `operationId/auditId` | 写入业务日志和管理操作回执；permission-core 不提供公开通用查询 manager。 |
| `replayed` | `true` 表示同一幂等写入已重放，不要重复外部副作用。 |
| `cache.status` | `degraded` 时数据库提交仍有效；告警并按 health 协调，不要重做创建。 |
| `committed/changed` | committed 固定 true；changed=false 是成功 no-op/幂等，不是失败。 |

## 相关内容

参见[生产运维](/zh/guide/production-operations)、[缓存](/zh/guide/cache)和[错误 API](/zh/api/errors)。
