# 生产部署与监控

生产接入应让权限配置明确、可观测且可以可靠失效。

## 推荐组合

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';
import {
  MonSQLizeMenuStorageAdapter,
  createMenuPermission,
} from 'permission-core/menu';

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

Core 适配器保存角色、规则、继承和用户绑定；menu 适配器另存菜单树、按钮/API binding、manifest revision 和 audit event。两者可共享连接，但不共享 collections 或生命周期所有权。

## 存储与生命周期契约

| 组件 | 生产职责 | 所有权规则 |
|---|---|---|
| `PermissionCore` | 授权规则与用户角色绑定 | 应用停机时关闭 |
| `MenuPermissionManager` | 菜单快照、导入、binding、revision、audit | 依赖 core 时先关闭 |
| `MonSQLizeStorageAdapter` | 持久化 core 授权数据 | 只有连接 owner 才设 `ownsConnection:true` |
| `MonSQLizeMenuStorageAdapter` | 持久化 menu 与 API binding | 共享 core 连接时设 `ownsConnection:false` |

按依赖顺序停机：

```typescript
try {
  await startServer();
} finally {
  await menu.close();
  await pc.close();
}
```

Memory 适配器用于测试和示例。File 适配器只提供单进程持久化，不提供分布式锁、多实例传播或数据库备份语义。

## 变更、恢复与迁移

- Manifest 导入按 revisioned configuration 处理；权威快照用 `replace`，明确的部分所有权才用 `merge`。
- 提升环境前执行 `validate()`；缺父页面、重复 code、非法 API binding 或未知 resource scheme 必须阻断。
- 持久化并监控 menu audit，记录 actor、reason、旧/新 revision 与 diff。
- Core 写入成功但缓存失效失败时，manager 会报告失败；按运维策略重试失效或回滚写入。
- Schema/namespace 迁移前同时备份 core 与 menu collections，并作为一个授权版本恢复。
- 滚动升级时先部署能读取新旧记录的 reader，再写入新格式；数据变化后失效权限缓存。

## 运行检查清单

- 服务启动调用 `pc.init()`，优雅停机调用 `menu.close()` 后再 `pc.close()`。
- 共享 MonSQLize 连接只有一个 owner。
- 接口资源使用匹配到的路由模板。
- 用户绑定通过 `pc.users` 写入；绕过时调用 `pc.invalidate(userId)`。
- 角色、规则与继承通过 `pc.roles` 写入；绕过时调用 `pc.invalidateAll()`。
- 拒绝日志可检索，但不记录敏感值。
- `getResources()` 只用于 UI 显隐，不是最终鉴权。
- 校验导入 manifest，并保留 revision/audit 证据。
- 对补偿失败、缓存失效失败和异常 revision 变化告警。

## 支付与金融场景

高风险操作使用明确资源，例如 `POST:/api/refunds`、`POST:/api/payouts`、`db:transactions`、`db:transactions:amount` 与 `db:refunds:internalNote`。除非角色明确特权且经过审查，不要用宽泛通配符授权退款、出款或账本写入。
