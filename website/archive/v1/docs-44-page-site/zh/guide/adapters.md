# 存储适配器

Core 适配器持久化角色、规则和用户角色绑定。可选 menu 模块使用另一套存储契约，保存菜单节点、API binding、revision 与 audit event。

## 内置适配器

| 适配器 | 适用场景 |
|--------|----------|
| `MemoryAdapter` | 测试、演示、示例 |
| `FileAdapter` | 本地回退和单进程持久化 |
| `MonSQLizeStorageAdapter` | 官方生产持久化路径 |

Menu 对应适配器从 `permission-core/menu` 导入：

| 适配器 | 适用场景 |
|---|---|
| `MemoryMenuStorageAdapter` | 测试和短期示例 |
| `FileMenuStorageAdapter` | 本地单进程菜单持久化 |
| `MonSQLizeMenuStorageAdapter` | 生产菜单与 API binding 持久化 |

## 适配器边界

Core 适配器只存授权配置，不执行业务数据库查询，也不替代支付账本或交易存储。Menu 适配器只存展示与绑定配置，不做后端最终鉴权；可见按钮仍需要 API binding 和服务端 `assertSubject()` 或框架 guard。

## 如何选择

- 测试和示例从 `MemoryAdapter` 开始。
- `FileAdapter` 只用于简单本地持久化。
- 规则与绑定需要持久化时使用 `MonSQLizeStorageAdapter`。
- 需要其他数据库时实现 `StorageAdapter`。
- 启用 `permission-core/menu` 后，独立选择对应的 menu 适配器。

## 两套存储的生产配置

```typescript
const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({
    msq,
    namespace: 'permission_core',
    ownsConnection: true,
  }),
  cache: msq.getCache(),
});

const menu = createMenuPermission({
  core: pc,
  storage: new MonSQLizeMenuStorageAdapter({
    msq,
    namespace: 'permission_core_menu',
    ownsConnection: false,
  }),
});

await pc.init();
await menu.init();
```

共享 MonSQLize 连接只能由一个适配器拥有。关闭时先 `await menu.close()`，再 `await pc.close()`。

## 一致性边界

- Core 授权保存通过公共 manager 失效权限缓存。
- Menu 导入是带 revision 的快照，并生成审计事件。
- Menu 写入无法完成关联授权保存时会报告补偿失败，不会静默成功。
- 同一版本同时改变两套契约时，core 与 menu collections 应一起备份和迁移。
- File 适配器不是分布式一致性方案，Memory 适配器也不是持久化生产存储。

## 下一步

继续看 [StorageAdapter API](/zh/api/storage-adapter)、[Menu Module API](/zh/api/menu)、[生产部署](/zh/guide/production-deployment) 与 [自定义适配器](/zh/guide/custom-adapter)。
