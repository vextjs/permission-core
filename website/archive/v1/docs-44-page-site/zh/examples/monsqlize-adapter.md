# MonSQLize 适配器示例

## 场景

在一个已连接 MonSQLize 实例上运行 core 授权与 menu 持久化，只有一个连接 owner，并共享 `cache-hub` 缓存。

## 可运行源码

`msq.connect()` 后使用以下应用启动组合：

```typescript
const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({ msq, ownsConnection: true }),
  cache: msq.getCache(),
});
const menu = createMenuPermission({
  core: pc,
  storage: new MonSQLizeMenuStorageAdapter({ msq, ownsConnection: false }),
});

await pc.init();
await menu.init();
```

按依赖顺序停机：

```typescript
await menu.close();
await pc.close();
```

## 预期结果

Core 创建 scoped role/binding/rule collections，menu 创建独立 node/API-binding/revision/audit collections。权限规则使用 `msq.getCache()`；关闭 menu 不会在 core 完成前关闭共享连接。

## 适用与不适用

适合已验证 MongoDB-backed MonSQLize 路径上的持久化共享生产授权。它不是业务数据 repository，也不允许两个 adapter 同时拥有一个连接。其他数据库需自定义 `StorageAdapter`；core/menu collections 应一起备份和迁移。
