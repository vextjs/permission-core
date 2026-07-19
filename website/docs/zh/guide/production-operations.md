# 生产运维

生产就绪依赖健康的宿主 MonSQLize 3.1 连接、兼容的权限 schema、有界授权状态、持久化变更证据和正确关闭顺序。进程能够访问并不代表权限服务已就绪；就绪门禁应读取 `PermissionCore.health()`。

## 前置条件

- 使用支持事务以及 `init()` 所探测 MonSQLize 3.1 能力的 MongoDB 部署。
- 所有实例使用相同的 collection prefix、资源方案定义/版本、scope 模型、缓存策略和已配置 token secret。
- 接受权限流量前只执行一次 `init()`，并将初始化失败保留为启动失败。
- 可能重放的管理写入应提供 `actorId`、`reason`、`requestId` 和当前操作专用的 `idempotencyKey`。

## 就绪检查清单

```ts
const health = await pc.health();
const ready = health.status === 'up'
  && health.lifecycle === 'ready'
  && health.initialized;
```

```json
{
  "status": "up",
  "lifecycle": "ready",
  "initialized": true,
  "database": { "status": "up" },
  "schema": {
    "expectedVersion": 2,
    "indexedContractMismatchScopes": { "value": 0, "cap": 1000, "truncated": false }
  },
  "tokens": { "keySource": "configured", "crossInstanceStable": true },
  "audit": {
    "pendingCacheOutcomes": { "value": 0, "cap": 1000, "truncated": false }
  }
}
```

`down` 表示 core 未就绪或数据库不可用。`degraded` 表示数据库可用，但 schema mismatch、缓存事件或待处理缓存结果需要处置。有界计数可能截断；零值是确定结论，达到上限的非零值并不是完整清单。

## 变更与审计控制

破坏性、结构性、替换型和高影响变更使用 preview/execute。执行时必须使用 preview 返回的原始 `previewToken` 和 `expectedRevisions`；只有审查 assessment 后才能确认容量风险。已提交响应返回 `operationId`、`auditId`、revision vector、重放状态、缓存结果和 warnings。

幂等性按 actor 和 key 隔离。相同 key 搭配相同规范化请求时，返回已提交结果且 `replayed: true`；输入不同则以 `IDEMPOTENCY_CONFLICT` 失败。permission-core 维护持久化内部审计证据及缓存结果协调，但不公开一个无限制审计日志浏览器。宿主应在业务/审计日志中保存返回 ID 以便关联。

## 容量与一致性

将 `LIMIT_EXCEEDED`、`PREVIEW_REQUIRED` 和 `ack-required` 容量结论视为设计反馈，而不是重试循环。拆分过宽角色或菜单授权，并审查受影响用户 sample/digest。处理 `REVISION_CONFLICT`、`READ_CONFLICT`、`PREVIEW_STALE`、`CURSOR_STALE` 时，重新读取当前状态并重建用户意图；不得制造 revision。

## 故障处置

1. 健康状态为 `down`、schema 不兼容或授权真相无法一致读取时，停止新的管理变更流量。
2. 记录公开错误码、details discriminator、retryable、operation ID、request ID、core namespace hash 和租户安全的 scope 关联信息。
3. 恢复 MonSQLize/数据库/缓存依赖及匹配的应用版本；不要手工编辑权限集合。
4. 重新运行 health 和发生故障的精确读取/preview。写入结果不确定时，先用原幂等键重试，不要提交新意图。
5. 只有所需路径恢复一致后才恢复流量；缓存 `degraded` 可以支持只读或暂停变更，而不能成为 blanket allow。

## 回滚与关闭

应用代码应与其资源方案契约和公开路由 manifest 一同回滚。schema contract mismatch 会有意阻止旧二进制解释新授权状态。如果数据已按新契约提交，应执行向前修复，而不是强制旧进程运行。

关闭时先停止新请求，等待 `pc.close()`，再关闭宿主持有的 MonSQLize。`close()` 等待权限操作与借用事务 `1000..300000` ms（默认 `30000`）；超时返回 `CORE_CLOSE_TIMEOUT`，且必须让进程管理器看到该失败。

使用[故障排查](/zh/guide/troubleshooting)按症状恢复，并在[错误 API](/zh/api/errors)查看 HTTP 映射建议。
