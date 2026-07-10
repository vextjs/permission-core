# 生产部署与监控

这页不是教你“怎么把 permission-core 跑起来”，而是帮你确认：当你准备真的上线时，哪些运行时、缓存、存储和监控点必须提前定好。

如果你还没完成最小接入，先回看 [快速开始](/zh/guide/quick-start) 和 [接入检查清单](/zh/guide/integration-checklist)。

## 先说结论

如果你准备把 permission-core 用在生产环境，默认建议是：

- 运行时入口继续使用 `PermissionCore`
- 存储层优先使用 `MonSQLizeStorageAdapter`
- 缓存层继续使用 `cache-hub`
- 应用启动时显式执行 `await pc.init()`
- 应用退出时显式执行 `await pc.close()`

`MemoryAdapter` 更适合单测、演示和临时接入。`FileAdapter` 适合本机验证或单机回退，不建议作为多实例生产部署的长期主存储。

## 一、上线前最少要确认什么

### 1. 你已经确认接入路径

- 只做接口权限：`HTTP-only`
- 只做数据权限：`DB-only`
- 同时做接口权限和数据权限：`Full standard stack`

这一点决定你会不会用到 `db:` 资源、行级权限和字段过滤。不要等上线前才发现自己其实选错了路径。

### 2. 你已经确认权限数据放在哪里

- `MemoryAdapter`：仅适合进程内临时数据
- `FileAdapter`：适合单机、本地、回退场景
- `MonSQLizeStorageAdapter`：适合正式持久化路径

如果你会有多个应用实例、滚动发布、后台改规则后多进程同时生效这些需求，优先把持久化放到 `MonSQLizeStorageAdapter`，不要把 `FileAdapter` 当成长期主方案。

### 3. 你已经确认缓存策略

permission-core 缓存的是“用户最终规则集合”，不是某一次 `can()` 的结果。

这意味着你至少要明确：

- 规则变化是否都通过 `pc.roles` 写入；绕过它时谁负责调用 `invalidateAll()`
- 用户角色变化是否都通过 `pc.users` 写入；绕过它时谁负责调用 `invalidate(userId)`
- 缓存命中率低时是规则设计问题、流量问题，还是缓存配置问题

## 二、推荐的生产组合

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'permission_core',
  config: { uri: process.env.MONGO_URI! },
  cache: { defaultTtl: 300_000, maxEntries: 1000 },
});

await msq.connect();

const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({
    msq,
    namespace: 'permission_core',
    ownsConnection: true,
  }),
  cache: msq.getCache(),
});

await pc.init();
```

这套组合的重点不是“官方推荐所以照抄”，而是它把三件事拆清楚了：

- `PermissionCore` 负责规则判定与过滤
- `MonSQLizeStorageAdapter` 负责持久化角色、规则和用户绑定
- `cache-hub` 负责缓存用户最终规则集合

## 三、部署时重点盯哪些指标

在完整管理后台场景里，核心权限数据和菜单数据是两套独立持久化契约。推荐共享一个已经连接的 MonSQLize 实例，但明确连接所有权：

```typescript
import {
  MonSQLizeMenuStorageAdapter,
  createMenuPermission,
} from 'permission-core/menu';

const menu = createMenuPermission({
  core: pc,
  storage: new MonSQLizeMenuStorageAdapter({
    msq,
    namespace: 'permission_core_menu',
    ownsConnection: false,
  }),
  strictApiBindings: true,
});

await menu.init();
```

`MonSQLizeStorageAdapter` 保存角色、规则、继承和用户角色绑定；`MonSQLizeMenuStorageAdapter` 保存菜单树、按钮/API binding、manifest revision 和菜单审计。两者不能因为共享连接就混用 collection。

应用关闭时按依赖顺序释放：

```typescript
try {
  await startServer();
} finally {
  await menu.close();
  await pc.close();
}
```

共享连接只能有一个 owner。若 core adapter 使用 `ownsConnection: true`，menu adapter 就应使用 `ownsConnection: false`。

最少建议把下面这些指标接入到你自己的日志、指标或告警系统。

| 类别 | 指标 | 为什么要看 |
|------|------|------------|
| 鉴权结果 | `permission_denied` 数量与比例 | 突然升高时，常见原因是规则变更、资源拼写漂移或调用层传参错误 |
| 存储层 | 权限读取耗时、写入耗时、异常次数 | `getRules()`、角色更新、用户绑定更新都依赖底层存储稳定性 |
| 缓存层 | 命中率、失效次数、全量失效频率 | 命中率过低会拖慢每次鉴权；全量失效过频通常表示管理接口粒度过粗 |
| 管理操作 | 角色变更、规则变更、用户角色变更 | 这些操作通常是后续权限异常排查的第一条线索 |
| 资源模型 | 未识别 action / resource 的异常 | 可以尽早发现调用层拼错资源路径或错误拼接查询串 |

## 四、日志建议

日志里最有价值的通常不是“这次返回了 true 还是 false”，而是下面这些上下文：

- `userId`
- `action`
- `resource`
- 当前调用的是 `can`、`assert`、`filterRows` 还是 `filterFields`
- 命中的是缓存、存储还是管理变更路径

但要注意：

- 不要把完整 token、cookie、连接串打进日志
- 不要把整条业务数据记录原样塞进权限失败日志
- 对 `filterRows()` / `filterFields()` 场景，优先记录被过滤的数量和字段名，不要直接全量打印行数据

## 五、滚动发布和回滚时要注意什么

如果你的规则模型、资源字符串或字段过滤逻辑发生变更，滚动发布时建议同时做这几件事：

1. 先发布兼容旧规则的读路径。
2. 再执行管理端或脚本侧的规则变更。
3. 变更完成后执行必要的缓存失效。
4. 最后再切流到依赖新规则的写路径或严格校验路径。

如果要回滚，也遵守反方向顺序：

1. 先回退依赖新规则的读写逻辑。
2. 再回退规则数据。
3. 再次执行缓存失效。

否则最容易出现“代码已经回滚，但缓存里还挂着新规则结果”的短时异常。

菜单 manifest 也要纳入同一套变更治理：

- 前端 manifest 是权威快照时使用 `replace`；只有明确的局部所有权场景才使用 `merge`
- 上线前执行 `menu.validate()`，阻断缺失父节点、重复 code、无效 API binding 和未知资源 scheme
- 保存 revision、diff、actor、reason 和审计事件，不能只记录“导入成功”
- 迁移前同时备份核心权限 collection 与菜单 collection，恢复时把两者视为同一个权限版本
- role/rule 保存后的缓存失效或补偿失败必须告警并重试，不能把部分成功当成完整成功

## 六、最常见的生产误区

### 误区一：把 `getResources()` 当成最终权限判断

`getResources()` 适合给菜单、按钮和页面显隐做参考列表，不适合直接替代接口最终放行。

真正的接口放行仍然建议走 `assert()` 或 `can()`。

### 误区二：绕过管理 API 写规则，不做失效策略

如果你通过 `pc.roles` / `pc.users` 写入，公开 manager 会处理对应缓存失效。如果你直接写存储适配器、跑外部同步或跨实例传播规则，却没有配套执行 `invalidateAll()` 或针对用户执行 `invalidate(userId)`，线上看到的就会是“后台改了，前台没生效”。

### 误区三：把 `FileAdapter` 当作多实例共享存储

`FileAdapter` 主要解决单机演示或本地回退，不负责多实例之间的数据同步、锁竞争和一致性广播。

### 误区四：把权限内核当成身份系统

permission-core 不负责用户登录态、token 校验、会话续期和账号禁用，这些仍然要在你的业务认证体系中处理。

## 七、上线前最后一遍确认

上线前建议至少再检查一次：

- [ ] 已确认使用哪种 `StorageAdapter`
- [ ] 已确认缓存 TTL、最大条目数和失效触发点
- [ ] 已确认 `pc.init()` / `pc.close()` 已接入应用生命周期
- [ ] 启用菜单模块时已确认 `menu.init()` / `menu.close()` 和共享连接唯一 owner
- [ ] 菜单 manifest 已经过 `validate()`，并保留 revision、diff 和 audit 证据
- [ ] 核心权限数据与菜单数据已纳入同一备份、迁移和回滚方案
- [ ] 已确认管理变更通过 `pc.roles` / `pc.users` 写入，或在绕过 manager 时触发正确的缓存失效
- [ ] 已确认日志里不会输出敏感值
- [ ] 已确认对 `Permission denied` 有可观测、可告警、可排查的记录

如果你还没确认当前依赖和运行时边界，继续看 [兼容性矩阵](/zh/guide/compatibility-matrix)。
