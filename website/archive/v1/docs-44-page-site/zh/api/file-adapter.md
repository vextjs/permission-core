# FileAdapter

`FileAdapter` 把 core 授权数据保存到一个 scoped JSON 文件。

## 用途与导入

```typescript
import { FileAdapter } from 'permission-core';
```

用于本地回退、演示和不需要数据库的简单单进程持久化。

## 构造与类型

`new FileAdapter(options?: FileAdapterOptions)` 接受 `path?: string`，默认 `./permission-core-data.json`。

它实现 `StorageAdapter` 与 `ScopedStorageAdapter`；持久化 schema v2 按 scope key 分开保存 role、user binding 和 rule。

## 签名索引

| 范围 | 方法 |
|---|---|
| 生命周期 | `init`；`close` |
| 角色 | get/set/delete/list 及 scoped 变体 |
| 用户绑定 | get/set、反向读取及 scoped 变体 |
| 规则 | get/set/delete 及 scoped 变体 |

## 行为与默认值

`init()` 遇到文件不存在时按空 store 启动。写入会串行、debounce，并通过临时文件原子替换提交；`close()` 等待待写数据落盘。旧 unscoped 数据会归一到默认 scope。

覆盖语义与 `StorageAdapter` 一致；绑定变化时 adapter 会重建或增量更新 role-to-users 反向索引。

## 错误与限制

非法 JSON 或不支持的数据会在初始化阶段失败。磁盘写入失败会被保留，并阻断后续读写，避免内存与磁盘静默分叉；持久化失败使用 `STORAGE_ERROR`。

一个 JSON 文件不适合作为多进程共享存储，也不提供分布式锁、多实例缓存传播或数据库级备份/事务保证。Menu 持久化属于独立 `FileMenuStorageAdapter` 契约。

## 最小示例

```typescript
const pc = new PermissionCore({
  storage: new FileAdapter({ path: './var/permissions.json' }),
});

await pc.init();
await pc.close();
```

## 相关页面

参见 [存储适配器](/zh/guide/adapters)、[StorageAdapter](/zh/api/storage-adapter) 与 [生产部署](/zh/guide/production-deployment)。
