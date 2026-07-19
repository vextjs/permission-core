# 核心与上下文

## 用途与前置条件

`PermissionCore` 负责初始化、健康状态、scope 管理上下文、subject 运行时上下文、授权便捷调用和关闭。使用宿主持有的 MonSQLize 3.1 实例构造，只调用一次 `init()`，并在宿主关闭 MonSQLize 前关闭 core。

## 签名

```ts
new PermissionCore(options: PermissionCoreOptions)
init(): Promise<PermissionCoreHealth>
health(): Promise<PermissionCoreHealth>
scope(scope: PermissionScope): ScopedPermissionContext
forSubject(subject: PermissionSubject, context?: PolicyContext): SubjectPermissionContext
can(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<boolean>
cannot(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<boolean>
assert(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<void>
getPermissions(subject: PermissionSubject, context?: PolicyContext): Promise<SubjectRuntimeResult<EffectivePermissionSnapshot>>
getResources(subject: PermissionSubject, action?: PermissionAction, context?: PolicyContext): Promise<SubjectRuntimeResult<EffectiveResourcePattern[]>>
explain(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<SubjectRuntimeResult<PermissionExplanation>>
close(): Promise<void>
```

`scope()` 暴露 `roles`、`userRoles`、`menus`、`apiBindings`。`forSubject()` 暴露授权读取、`menus` 和 `data`。两者都要求 core ready，并立即规范化输入。

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
const scoped = pc.scope({ tenantId: 'acme' });
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
