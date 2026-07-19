# 缓存

权限缓存是可选能力。默认值为 `cache: { enabled: false }`，权限判断直接读取 MonSQLize 持久化状态。只有宿主能够确认 MonSQLize 3.1 缓存后端在全部 permission-core 实例间提供有序的 `get`、`set`、`del`、`delPattern` 行为时，才应启用语义缓存。

## 前置条件

- 在宿主持有的 MonSQLize 实例上配置缓存后端。permission-core 没有 cache-hub 配置项，也不持有第二套缓存客户端。
- 多应用实例需要感知同一批失效事件时，应使用共享后端。
- 保持授权数据库写入与缓存操作的固定顺序：先提交数据库，再执行失效。
- 将配置的 TTL 视为失效失败后的最大风险窗口，而不是“允许使用陈旧权限”的承诺。

## 配置

先在宿主 MonSQLize 3.1 上配置 `getCache()` 将返回的后端。单进程开发可使用其内置内存缓存：

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: {
    maxEntries: 10_000,
    defaultTtl: 30_000,
  },
});
await msq.connect();
```

内存后端只适用于单进程语义。多实例部署最直接的共享配置是把 MonSQLize 的 Redis cache adapter 作为后端，使所有 PermissionCore 实例的 `get/set/del/delPattern` 指向同一存储：

```ts
const sharedCache = MonSQLize.createRedisCacheAdapter(
  'redis://127.0.0.1:6379',
);
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: sharedCache,
});
await msq.connect();
```

这两段配置的是 **MonSQLize 所有的缓存后端**。permission-core 不直接依赖或配置 cache-hub，也不创建 Redis 客户端。若宿主采用 MonSQLize 多级缓存，还必须证明跨实例的模式失效会触达每个 L1；无法证明时保持权限缓存关闭，或对权限层使用直接共享后端。

然后显式启用 permission-core 语义缓存：

```ts
const pc = new PermissionCore({
  monsqlize: msq,
  cache: {
    enabled: true,
    consistency: 'ordered-bounded-stale',
    ttlMs: 30_000,
  },
});

const health = await pc.init();
```

```json
{
  "status": "up",
  "cache": {
    "permissionLayer": "enabled",
    "consistencyAssurance": "caller-attested",
    "backendState": "opaque",
    "readIncidentActive": false,
    "invalidationIncidentActive": false,
    "hits": 0,
    "misses": 0,
    "readFallbacks": 0,
    "invalidationFailures": 0
  }
}
```

这个 JSON 是 `pc.init()` 返回的原始 `PermissionCoreHealth` 中 cache 部分的节选，不是缓存配置回显。`backendState: 'opaque'` 只表示 permission-core 不探测宿主缓存内部健康，不等于后端已经验证可用。

| 配置/调用 | 参数或返回 | 作用 |
|---|---|---|
| `cache.enabled` | 必须显式 `true` | 让 core 在 init 时调用 `monsqlize.getCache()` 并校验必需方法。 |
| `cache.consistency` | 启用时必须为 `ordered-bounded-stale` | 调用方确认后端满足提交后有序失效及有界陈旧窗口。 |
| `cache.ttlMs` | 默认 30000，范围 100..86400000 | permission-core 语义条目的 TTL；不是 MonSQLize 普通业务查询的 cache TTL。 |
| [`pc.init()`](/zh/api/core-and-contexts#core-init) | 无参数 | 初始化持久化/缓存能力并返回当前 health；只允许成功初始化一次。 |
| [`pc.health()`](/zh/api/core-and-contexts#core-health) | 无参数 | 随时重新读取 health，不修改缓存状态。 |
| [`pc.close()`](/zh/api/core-and-contexts#core-close) | 无参数 | 排空 core；不会关闭宿主 MonSQLize 或其缓存后端。 |

`ttlMs` 默认为 `30000`，范围是 `100..86400000`。启用缓存时必须提供 `consistency`，当前唯一值是 `ordered-bounded-stale`。省略 `cache` 或设置 `{ enabled: false }` 都会完全绕过权限缓存。

## 一致性与所有权

缓存保存绑定 revision 的有效授权快照和菜单投影。缓存键包含 core namespace、完整 scope、用户、claims/context 指纹、读取族和选择器。只有 envelope、TTL、数据族与已知 revision 契约都有效时，缓存视图才会被接受。

管理变更先在 MonSQLize 中提交状态和审计证据，再使受影响的 scope、RBAC、菜单或用户键族失效。缓存读取、解码或写入失败时，在安全情况下回退数据库。失效失败不同：健康状态会在记录的风险窗口内保持 degraded，因为其他读者可能仍持有旧条目。

MonSQLize 及其缓存后端都归宿主持有。`PermissionCore.close()` 只解除权限层的缓存使用，不关闭这两个宿主资源。

## 故障处置

1. 读取 `await pc.health()`，检查 `cache.readIncidentActive`、`cache.invalidationIncidentActive`、`cache.invalidationRiskUntil`、回退/失败计数和 `audit.pendingCacheOutcomes`。
2. 独立检查 MonSQLize 健康状态和所配置的缓存后端；`backendState: 'opaque'` 表示 permission-core 不声称已经证明后端存活。
3. 读取故障时应预期数据库回退，在恢复后端前先检查数据库延迟和容量。
4. 失效故障时，必要时停止高风险权限扩张，恢复有序失效，并等待风险窗口和 pending outcome 清零。
5. 不得绕过 revision 检查、手工标记健康，也不得用陈旧 allow 作为恢复捷径。

## 多实例检查清单

- 所有实例使用相同的 `collectionPrefix`、资源方案契约、已配置 `tokenSecret`、缓存后端和 TTL 策略。
- 后端的模式删除能触达所有实例写入的键。
- 健康告警区分读取回退与失效风险，并包含待处理审计结果。
- 部署测试覆盖实例 A 变更权限、实例 B 随后读取权限的路径。

## 回滚

安全回滚方式是在整个实例组一致部署 `cache: { enabled: false }`，恢复数据库直读。旧实例排空前，不应宣称整个集群已经关闭缓存。授权故障期间不要随机对个别实例切换缓存模式。

继续阅读[生产运维](/zh/guide/production-operations)了解就绪处置，并在[审计与健康 API](/zh/api/audit-and-health)查看精确健康结构。
