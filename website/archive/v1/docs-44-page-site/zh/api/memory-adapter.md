# MemoryAdapter

`MemoryAdapter` 是同时实现 core 与 scoped storage 契约的内置内存适配器。

## 用途与导入

```typescript
import { MemoryAdapter } from 'permission-core';
```

用于测试、示例、本地原型，也是零配置 `PermissionCore` 的默认存储。

## 构造与类型

`new MemoryAdapter()` 没有选项，实现 `StorageAdapter` 与 `ScopedStorageAdapter`。

数据保存在进程内的 role map、user-role map、rule map 和 role-to-users 反向索引中。

## 签名索引

| 范围 | 方法 |
|---|---|
| 生命周期 | `init`；`close` |
| 角色 | get/set/delete/list 及 scoped 变体 |
| 用户绑定 | get/set、`getUsersByRole` 及 scoped 变体 |
| 规则 | get/set/delete 及 scoped 变体 |

所有方法都保持异步，以满足统一 adapter 契约。

## 行为与默认值

每个 permission scope 使用独立内部 key。角色缺失返回 `null`，绑定或规则缺失返回空数组；覆盖写会替换旧绑定或规则列表。

`init()` / `close()` 是 no-op 生命周期。其上层 PermissionCore manager 仍负责校验与缓存失效。

## 错误与限制

进程重启后数据消失，多个进程也不共享状态。Adapter 不提供锁、分布式传播、备份或外部事务语义。

不要当作持久化生产存储。和其他 adapter 一样，低层写入会绕过 manager 的校验与缓存失效。Menu 状态使用独立 `MemoryMenuStorageAdapter`。

## 最小示例

```typescript
const pc = new PermissionCore({ storage: new MemoryAdapter() });
await pc.init();
await pc.roles.create('reader', { label: 'Reader' });
await pc.close();
```

## 相关页面

参见 [存储适配器](/zh/guide/adapters)、[StorageAdapter](/zh/api/storage-adapter) 与 [FileAdapter](/zh/api/file-adapter)。
