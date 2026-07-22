# 核心与上下文

## 用途与前置条件

`PermissionCore` 负责初始化、健康状态、scope 管理上下文、subject 运行时上下文、授权便捷调用和关闭。使用宿主持有的 MonSQLize 3.1 实例构造，只调用一次 `init()`，并在宿主关闭 MonSQLize 前关闭 core。

## 我想做什么

| 目标 | 从这里开始 |
|---|---|
| 初始化与健康 | [`new PermissionCore()`](#core-constructor)、[`init()`](#core-init)、[`health()`](#core-health) |
| 创建管理上下文 | [`scope()`](#core-scope) |
| 创建用户判断上下文 | [`forSubject()`](#core-for-subject) |
| 执行权限判断 | [`can()`](#core-can)、[`cannot()`](#core-cannot)、[`assert()`](#core-assert) |
| 读取与解释 | [`getPermissions()`](#core-get-permissions)、[`getResources()`](#core-get-resources)、[`explain()`](#core-explain) |
| 安全关闭 | [`close()`](#core-close) |

## 签名

```ts
new PermissionCore(options: PermissionCoreOptions)
init(): Promise<PermissionCoreHealth>
health(): Promise<PermissionCoreHealth>
scope(scope: PermissionScope, defaults?: ScopedMutationDefaults): ScopedPermissionContext
forSubject(subject: PermissionSubject, context?: PolicyContext): SubjectPermissionContext
can(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<boolean>
cannot(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<boolean>
assert(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<void>
getPermissions(subject: PermissionSubject, context?: PolicyContext): Promise<SubjectRuntimeResult<EffectivePermissionSnapshot>>
getResources(subject: PermissionSubject, action?: PermissionAction, context?: PolicyContext): Promise<SubjectRuntimeResult<EffectiveResourcePattern[]>>
explain(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<SubjectRuntimeResult<PermissionExplanation>>
close(): Promise<void>
```

## 构造参数与公共输入

<!-- docs:params owner=PermissionCoreOptions locale=zh -->

<span id="permission-core-options"></span>
### `PermissionCoreOptions`

| 字段 | 类型 | 必填 | 默认值 | 作用与约束 |
|---|---|:---:|---|---|
| `monsqlize` | `MonSQLizeInstance` | 是 | 无 | 宿主已经连接的 MonSQLize 3.1 实例。permission-core 只借用，不会在 `close()` 时关闭它。 |
| `collectionPrefix` | `string` | 否 | `permission_core` | 权限集合名前缀，必须匹配 `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`。同一数据库部署多套权限域时才需要修改。 |
| `cache` | `PermissionSemanticCacheOptions` | 否 | `{ enabled: false }` | 开启后复用 `monsqlize.getCache()`；不创建第二个缓存客户端。 |
| `closeDrainTimeoutMs` | `number` | 否 | `30000` | `close()` 等待在途操作结束的毫秒数，必须是 `1000..300000` 的整数。 |
| `tokenSecret` | `string \| Uint8Array` | 否 | 进程内随机 32 bytes | 签发 preview/cursor 等 token。多实例或重启后仍需验证旧 token 时必须显式配置，至少 32 bytes。 |
| `resourceSchemes` | `ResourceSchemeDefinition[]` | 否 | `[]` | 追加自定义资源 scheme，最多 32 个；内置 scheme 不需要重复声明。 |

启用语义缓存时必须同时声明一致性模式：

```ts
cache: {
  enabled: true,
  consistency: 'ordered-bounded-stale',
  ttlMs: 30_000,
}
```

`ttlMs` 默认 `30000`，范围 `100..86400000`。`enabled: false` 时不能再传 `ttlMs` 或 `consistency`。

### `PermissionScope`

<!-- docs:params owner=PermissionScope locale=zh -->

| 字段 | 类型 | 必填 | 值从哪里来 | 说明 |
|---|---|:---:|---|---|
| `tenantId` | `string` | 是 | 宿主可信租户上下文 | 第一隔离维度；不能直接信任请求体或查询参数。 |
| `appId` | `string` | 否 | 宿主应用上下文 | 同一租户需要按应用再隔离时使用。 |
| `moduleId` | `string` | 否 | 宿主模块上下文 | 按业务模块隔离角色、菜单和规则时使用。 |
| `namespace` | `string` | 否 | 宿主固定配置 | 为同一 tenant/app/module 再划分权限命名空间。 |

scope 使用完整对象做身份比较。`{ tenantId: 'acme' }` 与 `{ tenantId: 'acme', appId: 'ops' }` 是两个不同权限域。

### `PermissionSubject` 与 `PolicyContext`

<!-- docs:params owner=PermissionSubject locale=zh -->

| 参数/字段 | 类型 | 必填 | 值从哪里来 | 说明 |
|---|---|:---:|---|---|
| `subject.userId` | `string` | 是 | 宿主认证结果 | 被鉴权用户 ID；permission-core 不负责登录和用户目录。 |
| `subject.scope` | `PermissionScope` | 是 | 宿主可信租户上下文 | 决定从哪个权限域读取角色与规则。 |
| `subject.claims` | `Record<string, PolicyValue>` | 否 | 宿主认证/业务上下文 | 行规则中 `valueFrom: 'claims.xxx'` 的可信取值来源。 |
| `context` | `PolicyContext` | 否 | 当前业务调用 | 一次判定使用的补充值，不会持久化到用户或角色。 |

<span id="common-response-contracts"></span>
## 公共响应合同

管理 API 会复用以下 envelope。看到某个方法返回 `MutationResult<Role>` 时，`Role` 只是 `data` 的类型，外层字段仍按本节解释。

### `MutationOptions` 与 revision options

<!-- docs:params owner=MutationOptions locale=zh -->

| 字段 | 使用位置 | 必填 | 说明 |
|---|---|:---:|---|
| `actorId` | 写入/preview | 否 | 操作者 ID，写入审计证据；不要传被授权用户 ID 冒充管理员。 |
| `reason` | 写入/preview | 否 | 本次变更原因，供审计和后台展示。 |
| `requestId` | 写入/preview | 否 | 宿主请求关联 ID，用于日志追踪；直接写入时也会用于自动派生内部幂等键。 |
| `idempotencyKey` | 直接写入 | 否 | 高级覆盖项；不传时可由 `requestId` 自动派生。重放时 `replayed` 为 `true`。preview 不接受该字段。 |
| `expectedRevision` | 单实体 update/remove/set/clear | 是 | 调用读取结果中的当前 `data.revision` 或方法要求的实体 revision；不一致返回 `REVISION_CONFLICT`。 |
| `expectedRevisions` | 跨实体 execute | 是 | preview 返回的 revision vector；必须原样传给 execute。 |
| `previewToken` | preview 对应 execute | 是 | 只使用当前 preview 返回的 token；过期或状态变化会失败。 |
| `acknowledgeCapacityRisk` | 部分高影响 execute | 条件 | preview 要求确认容量风险时传 `true`，不要默认无条件设置。 |

### 读取与分页响应

<!-- docs:response owner=read-envelopes kind=raw locale=zh -->

| 返回类型 | 关键字段 | 调用方怎样使用 |
|---|---|---|
| `VersionedResult<T>` | `data`、`revision`、`revisions`、`etag`、`detailBudget` | 读取单个实体或快照；后续写入通常使用 `data.revision` 或对应 revision vector。 |
| `SubjectRuntimeResult<T>` | `data`、`detailBudget` | subject 运行时诊断；没有管理 revision，不能拿来做管理写入 CAS。 |
| `PageResult<T>` | `items`、`pageInfo.hasNext`、`pageInfo.endCursor`、revision/etag | `hasNext=true` 时把 `endCursor` 作为下一次 `after`；不要自己解析 cursor。 |
| `BoundedDetails<T>` | `total`、`items`、`truncated`、`digest` | `items` 只是有界明细；`truncated=true` 时用 `total/digest` 做诊断，不能把 items 当完整集合。 |

### 写入与 preview 响应

<!-- docs:response owner=mutation-preview kind=raw locale=zh -->

| 返回类型/字段 | 含义 | 下一步 |
|---|---|---|
| `MutationResult<T>.data` | 提交后的领域数据 | 更新页面状态或继续读取。 |
| `committed` / `changed` | 已提交；是否真的改变状态 | `changed=false` 可能是幂等/no-op，不代表失败。 |
| `revision` / `revisions` | 新的实体/全局 revision | 保存为下一次并发写入基线。 |
| `operationId` / `auditId` | 操作与审计关联 ID | 写入业务日志或返回管理后台。 |
| `replayed` | 是否命中幂等重放 | `true` 时不要重复触发外部副作用。 |
| `cache.status` | 缓存失效结果 | `degraded` 时写入仍已提交，应告警而不是重做数据库写入。 |
| `ImpactPreview.executable` | 当前计划是否可执行 | 只有 `true` 时才存在 token 与 expected。 |
| `previewToken` / `expected` | execute 所需的一次性依据 | 原样传入对应 execute/grant/remove 操作。 |
| `conflicts` / `warnings` / `capacity` | 阻断、提醒和容量评估 | 先解决 conflict；warning/capacity 按后台流程确认。 |

## 方法详解：初始化与健康

<span id="core-constructor"></span>
### `new PermissionCore(options)`

<!-- docs:method name=PermissionCore locale=zh -->

- **用途**：校验并快照配置，创建尚未初始化的 core。
- **参数**：`options` 必填，字段见上面的 `PermissionCoreOptions` 表。
- **状态影响**：只创建内存对象，不连接数据库、不建索引；生命周期为 `new`。
- **原始返回**：`PermissionCore` 实例，不是 Promise。
- **失败**：无效字段、过短 `tokenSecret`、非法 prefix/cache 配置立即抛 `INVALID_CONFIGURATION`。

<span id="core-init"></span>
### `init()`

<!-- docs:method name=init locale=zh -->

- **用途**：在接受鉴权请求前准备 schema、索引、事务、资源 scheme 和可选缓存。
- **参数**：无；同一实例只初始化一次。
- **状态影响**：`new -> initializing -> ready`；失败时保持不可服务并记录健康错误。
- **原始返回**：`PermissionCoreHealth`，重点检查 `status`、`database.status`、`schema`、`tokens` 和 `cache`。
- **失败**：数据库/schema/索引不满足要求时拒绝 ready，不会降级成默认 allow。

<span id="core-health"></span>
### `health()`

<!-- docs:method name=health locale=zh -->

- **用途**：读取当前生命周期、数据库、schema、token 和缓存健康状态。
- **参数**：无。
- **状态影响**：只刷新健康探测，不修改授权数据。
- **原始返回**：`PermissionCoreHealth`；`status='degraded'` 需要结合 `cache`/`audit` 字段判断，`down` 表示不能继续授权服务。

<span id="core-scope"></span>
## 方法详解：创建管理与用户上下文

### `scope(scope, defaults?)`

<!-- docs:method name=scope locale=zh -->

- **用途**：进入一个确定权限域，随后管理该域的角色、用户角色和菜单配置。
- **参数**：`scope: PermissionScope` 必填，字段见本页输入表；`defaults` 可绑定本次管理请求的 `actorId/reason/requestId`，后续写入和 preview 会自动合并这些审计默认值。
- **状态影响**：同步创建轻量上下文，不读取数据库。
- **原始返回**：`ScopedPermissionContext`，包含 `withDefaults()`、`roles`、`userRoles`、`menus`；接口契约通过 `menus.config` 中的 `load/actions/response` 配置。
- **失败**：core 未 ready 或 scope 非法时抛错。

<span id="core-for-subject"></span>
### `forSubject(subject, context?)`

<!-- docs:method name=forSubject locale=zh -->

- **用途**：为一次用户授权流程绑定可信 user/scope/claims，避免每次调用重复传 subject。
- **参数**：`subject` 必填；`context` 可选，只对当前上下文的判定生效。
- **状态影响**：同步创建运行时上下文，不会创建用户或持久化 claims。
- **原始返回**：`SubjectPermissionContext`，提供 `can/cannot/assert/explain/getPermissions/getResources/menus/data`。

<span id="core-can"></span>
## 方法详解：执行权限判断

### `can(subject, action, resource, context?)` / `subject.can(action, resource)`

<!-- docs:method name=can locale=zh -->

- **用途**：判断一个具体操作是否允许，适合 `if` 分支或返回 403 前的布尔检查。
- **参数**：`action` 是 `read/invoke/...`；`resource` 是完整资源字符串；主类形式还需 `subject`，可选 `context`。
- **状态影响**：只读有效角色和规则；deny-first，找不到 allow 时默认返回 `false`。
- **原始返回**：`boolean`。`true` 才表示允许。
- **失败**：无效输入、core 不可用或数据库失败会抛错，不会把系统故障当作 `false` 静默吞掉。

<span id="core-cannot"></span>
### `cannot(subject, action, resource, context?)` / `subject.cannot(action, resource)`

<!-- docs:method name=cannot locale=zh -->

- **用途**：需要以“是否阻止”命名条件时使用。
- **参数**：与 `can` 相同；主类形式传 subject/action/resource/context，subject 形式传 action/resource。
- **状态影响**：只读有效角色和规则，不创建或修改 deny 规则。
- **原始返回**：`!can(...)`。`true` 表示不能执行，不表示系统给用户新增了一条 deny 规则。
- **选择建议**：普通授权分支优先用 `can`；只有变量语义明确是 `blocked/forbidden` 时使用 `cannot`。

<span id="core-assert"></span>
### `assert(subject, action, resource, context?)` / `subject.assert(action, resource)`

<!-- docs:method name=assert locale=zh -->

- **用途**：命令式 guard；不允许时直接中断当前业务流程。
- **参数**：与 `can` 相同；主类形式传 subject/action/resource/context，subject 形式传 action/resource。
- **状态影响**：只读授权状态；拒绝时只抛错，不写入角色或规则。
- **原始返回**：允许时 `Promise<void>`；没有可用于渲染页面的数据。
- **失败**：拒绝时抛 `PERMISSION_DENIED`；调用方在 HTTP 层把它映射为自己的 403 响应。

<span id="core-get-permissions"></span>
## 方法详解：读取与解释

### `getPermissions(subject, context?)` / `subject.getPermissions()`

<!-- docs:method name=getPermissions locale=zh -->

- **用途**：构建用户权限诊断页，读取直接角色、有效角色、规则和 deny 冲突。
- **参数**：主类形式需要 `subject`；subject 上下文形式无参数。
- **状态影响**：只读，不替代具体 `can/assert` 判定。
- **原始返回**：`SubjectRuntimeResult<EffectivePermissionSnapshot>`；使用 `data.directRoleIds`、`data.roles`、`data.rules`、`data.conflicts`。
- **限制**：明细受 `detailBudget` 限制，不能把 `items` 当无限完整导出。

<span id="core-get-resources"></span>
### `getResources(subject, action?, context?)` / `subject.getResources(action?)`

<!-- docs:method name=getResources locale=zh -->

- **用途**：按 action 读取当前 subject 的有效资源模式，适合诊断或生成有界提示。
- **参数**：`action` 可选；省略时返回全部 action 的有效资源模式。
- **状态影响**：只读。
- **原始返回**：`SubjectRuntimeResult<EffectiveResourcePattern[]>`；读取 `data`，同时检查 `detailBudget`。
- **边界**：资源模式不是前端可信安全边界，后端仍须对具体资源调用 `can/assert`。

<span id="core-explain"></span>
### `explain(subject, action, resource, context?)` / `subject.explain(action, resource)`

<!-- docs:method name=explain locale=zh -->

- **用途**：解释一次 allow/deny/no-allow 判定，用于排错和管理后台诊断。
- **参数**：与 `can` 相同。
- **状态影响**：只读；比 `can` 返回更多有界 trace。
- **原始返回**：`SubjectRuntimeResult<PermissionExplanation>`；常用 `data.allowed`、`data.reason`、`data.evaluations`。
- **选择建议**：业务热路径只要布尔值时用 `can`；需要说明“为什么”时再调用 `explain`。

<span id="core-close"></span>
## 方法详解：关闭

### `close()`

<!-- docs:method name=close locale=zh -->

- **用途**：宿主停止服务时拒绝新权限工作并等待在途操作结束。
- **参数**：无。
- **状态影响**：`ready -> closing -> closed`；不会关闭宿主持有的 MonSQLize。
- **原始返回**：`Promise<void>`。
- **失败**：超过 `closeDrainTimeoutMs` 抛 `CORE_CLOSE_TIMEOUT`；宿主仍需根据自己的生命周期决定何时关闭数据库。

`scope()` 暴露 `roles`、`userRoles` 和 `menus`。`forSubject()` 暴露授权读取、`menus` 和 `data`。两者都要求 core ready，并立即规范化输入。

## 响应与副作用

`init()` 创建/探测索引、schema、事务、资源方案和可选缓存，然后返回健康状态。`health()` 刷新可观察数据库/仓库状态。上下文工厂是同步方法，只有执行具体方法时才查询授权状态。`assert()` 和 `close()` 成功时返回 `void`。

例如，`explain()` 返回以下 envelope；`getPermissions()` 使用同一 envelope，但其 `data` 是包含主体、直接角色、有效角色、规则与冲突的 `EffectivePermissionSnapshot`。

```json
{
  "data": {
    "allowed": false,
    "action": "read",
    "resource": "db:orders",
    "reason": "no-allow",
    "evaluations": [{
      "action": "read",
      "allowed": false,
      "reason": "no-allow",
      "evaluatedAllows": { "total": 0, "items": [], "truncated": false, "digest": "..." },
      "evaluatedDenies": { "total": 0, "items": [], "truncated": false, "digest": "..." }
    }]
  },
  "detailBudget": { "limit": 100, "returned": 0, "truncated": false, "digest": "..." }
}
```

管理读取与写入使用对应领域页面说明的 versioned/mutation envelope。

## 失败与限制

ready 前调用返回 `NOT_INITIALIZED`；开始关闭后调用返回 `CORE_CLOSED`。无效 scope/subject/context 返回校验错误。数据库/schema/事务故障绝不会降级成 allow。`closeDrainTimeoutMs` 范围为 `1000..300000`（默认 `30000`）；超时是 `CORE_CLOSE_TIMEOUT`，并包含活动 lease 计数。

## 示例

```ts
const pc = new PermissionCore({ monsqlize: msq });
await pc.init();
const scoped = pc.scope(
  { tenantId: 'acme' },
  { actorId: 'admin', requestId: 'req-42' },
);
const subject = pc.forSubject({ userId: 'u-1', scope: { tenantId: 'acme' } });
const allowed = await subject.can('read', 'db:orders');
await pc.close();
```

```json
{ "allowed": false }
```

没有匹配 allow 规则时，`can()` 返回 `false`；这是默认拒绝，不是异常。

## 相关内容

参见[角色 API](/zh/api/roles)、[授权集合 API](/zh/api/authorized-collection)和[审计与健康 API](/zh/api/audit-and-health)。
