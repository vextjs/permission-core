# 故障排查

排查时先看错误 `code` 和 `details.kind`，不要依赖 message 文案。PermissionCore 错误是结构化的，还可能包含 `retryable`、`committed` 和 `operationId`。

## 最小诊断顺序

```ts
const health = await pc.health();
if (health.status !== 'up') {
  logger.warn({ health }, 'permission core is not fully healthy');
}

const scoped = pc.scope({ tenantId: 'acme' });
const directRoles = await scoped.userRoles.getDirect('u-1');
const subject = pc.forSubject({
  userId: 'u-1', scope: { tenantId: 'acme' },
});
const explanation = await subject.explain('invoke', 'GET:/api/orders');
```

| 变量 | 原始结构 | 首先查看 |
|---|---|---|
| `health` | `PermissionCoreHealth` | lifecycle/database/schema/cache/audit，而不只看 status |
| `directRoles` | `VersionedResult<UserRoleBindingSet>` | `data.roleIds/status/revision`，确认角色确实直接绑定 |
| `explanation` | `SubjectRuntimeResult<PermissionExplanation>` | `data.allowed/reason/evaluations` 与 `detailBudget.truncated` |

这三个读取不会修复状态。先根据证据定位层级，再调用相应管理写入或部署恢复；不要在诊断代码中自动追加 allow。

## 安装与初始化

| 现象 | 常见原因 | 恢复方式 |
|---|---|---|
| 无法解析 `monsqlize` | 缺少必需 peer | 在 `permission-core` 同级安装准确版本 `monsqlize@3.1.0` |
| `VEXT_MONSQLIZE_REQUIRED` | Vext 插件没有收到数据库运行时 | 把宿主已连接的 MonSQLize 实例传给 `permissionPlugin` |
| `MONSQLIZE_CONTRACT_UNSUPPORTED` | 实例版本过旧、未连接或不兼容 MonSQLize 3.1 | 核对版本与连接，再重新创建 core |
| `init()` 返回 `DATABASE_UNAVAILABLE` | MongoDB 健康检查或事务探针失败 | 恢复数据库；`health()` 正常前不要接收授权流量 |
| `SCHEMA_VERSION_MISMATCH` 或 `SCHEMA_CONTRACT_MISMATCH` | 持久化授权状态与当前运行时契约不一致 | 停止写入，检查受影响的 scope hash，并恢复兼容状态；不要绕过检查降级 |

`PermissionCore` 构造函数必须接收包含 `monsqlize` 的配置对象，不支持无参数构造，也没有单独的存储适配器。

## Scope、身份与决策

| 现象 | 常见原因 | 恢复方式 |
|---|---|---|
| `INVALID_SUBJECT` | `userId` 或 subject scope 不完整 | 从服务端已认证状态构造 subject，并至少包含 `tenantId` |
| `SCOPE_CONFLICT` | 两个可信身份来源给出的 scope 不一致 | 拒绝请求并修复认证接入，不能静默任选一个 |
| `POLICY_CONTEXT_MISSING` | 规则使用 `valueFrom: 'context.*'`，但没有对应上下文 | 调用 `forSubject(subject, context)` 时提供必需值 |
| 没有 deny 规则但 `can()` 为 `false` | 没有激活的 allow 命中 | 调用 `explain()` 查看 `reason`；`no-allow` 是默认拒绝的正常结果 |
| 已有 allow 仍未通过 | 命中 deny、角色停用、条件未知或来源不可用 | 检查 `explain()`、有效角色、有效规则和来源状态 |

`cannot(action, resource)` 返回的是 `!can(action, resource)`。结果为 `true` 并不能证明存在显式 deny 规则。

## 数据、菜单与并发

| 现象 | 常见原因 | 恢复方式 |
|---|---|---|
| `SCOPE_FIELD_MAPPING_REQUIRED` | 授权集合没有映射某个 scope 维度 | 为实际使用的每个 scope 维度配置 `scopeFields` |
| filter 或 sort 触发 `FIELD_PERMISSION_DENIED` | 查询字段不可读，即使结果没有返回它 | 明确授权该字段，或取消过滤/排序；这用于阻止侧信道推断 |
| `DATA_BULK_SCOPE_MUTATION_UNSAFE` | 批量写可能把数据移出授权条件 | 拆分操作，或使用不会改变租户与策略字段的更新 |
| `REVISION_CONFLICT` | 另一个管理员已经修改实体 | 重新加载当前数据与修订，展示冲突，再让用户决定是否重试 |
| preview 不可执行 | 选择项、来源重写或容量确认尚未解决 | 展示 `conflicts` 和 `choiceRequirements`，只使用返回的 preview token 执行 |
| 菜单可见但按钮不可用 | 按钮权限或必需接口绑定不可用 | 查看 `getButtonMap()` 和绑定的 `apiRisks` |

管理写入采用乐观并发并记录审计。不能用任意当前数字替换 `expectedRevision` 来“自动重试”，必须先重新加载表单状态。

## 缓存与 Vext 恢复

缓存默认旁路。启用后若健康状态降级，权限读取会在可行时回退数据库，并在 `health().cache` 记录事件。应恢复 MonSQLize 缓存后端并监控失效结果，不要再给 permission-core 接入第二个缓存客户端。

受保护 Vext 路由没有可信认证上下文时，插件返回 `VEXT_AUTH_REQUIRED`。启动后若路由 manifest 发生变化，会返回 `VEXT_ROUTE_RESTART_REQUIRED`，所有路由持续响应 503，直到进程用一致 manifest 重启；这是有意的默认拒绝行为。

生产诊断应保留 HTTP request ID、权限 `operationId`、错误码、details 判别字段、租户安全的 scope hash 和当前 `health()` 快照。进一步处理请阅读[生产运维](/zh/guide/production-operations)。
