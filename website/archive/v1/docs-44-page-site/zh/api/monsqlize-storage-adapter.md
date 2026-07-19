# MonSQLizeStorageAdapter

`MonSQLizeStorageAdapter` 是由已连接 MonSQLize 实例支持的内置持久化 core storage 路径。

## 用途与导入

```typescript
import { MonSQLizeStorageAdapter } from 'permission-core';
```

角色、规则、继承和用户绑定需要跨进程/重启持久化时使用。

## 构造与类型

`new MonSQLizeStorageAdapter(options: MonSQLizeStorageAdapterOptions)` 必须传 `msq`；`namespace` 默认 `permission_core`，`ownsConnection` 默认 `false`。

Adapter 只要求 MonSQLize 的 `collection()` 与可选 `close()`，同时实现 `StorageAdapter` 和 `ScopedStorageAdapter`。

## 签名索引

| 范围 | 方法 |
|---|---|
| 生命周期 | `init`；`close` |
| 角色 | get/set/delete/list 及 scoped 变体 |
| 用户绑定 | get/set/反向读取及 scoped 变体 |
| 规则 | get/set/delete 及 scoped 变体 |

初始化会为 role、user-role binding 与 rule 建立索引。

## 行为与默认值

Collections 为 `${namespace}_roles`、`${namespace}_user_roles`、`${namespace}_rules`。Document 包含稳定 `scopeKey` 与 scope 字段，使相同逻辑 ID 按 tenant/application 隔离。

只有 `ownsConnection:true` 时 `close()` 才关闭 MonSQLize。Core/menu 共享连接时只能有一个 owner，依赖 adapter 使用 `false`。

## 错误与限制

Collection/index/read/write 失败包装为 `STORAGE_ERROR`。Adapter 不创建或连接 MonSQLize；只有应用把 `msq.getCache()` 传给 `PermissionCore` 时才共享缓存。

它保存授权配置，不保存业务行。Menu 资产使用 `permission-core/menu` 的 `MonSQLizeMenuStorageAdapter` 和独立 collections。

## 最小示例

```typescript
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

## 相关页面

参见 [存储适配器](/zh/guide/adapters)、[生产部署](/zh/guide/production-deployment) 与 [MonSQLize 示例](/zh/examples/monsqlize-adapter)。
