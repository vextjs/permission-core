# MemoryAdapter

`MemoryAdapter` 是最轻的内置适配器，主要用于单测、最小验证和文档示例。它不做持久化，进程退出后数据就会丢失。

## 最简单示例

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
	storage: new MemoryAdapter(),
});

await pc.init();
```

## 构造器

```typescript
new MemoryAdapter()
```

它没有额外选项。

## 行为特点

| 能力 | 说明 |
|------|------|
| 持久化 | 不支持，全部在内存中 |
| `init()` / `close()` | 基本是 no-op |
| 角色读写 | 支持 |
| 规则读写 | 支持 |
| 用户绑定读写 | 支持 |
| 角色反向索引 | 内部维护 `role -> users` 索引 |

## API 说明

`MemoryAdapter` 完整实现了 [StorageAdapter](/api/storage-adapter) 的全部方法。

最常见的几个行为要点是：

- `getRoles()` / `getRole()` / `getRules()` / `getUserRoles()` 都返回 clone 后的数据，避免外部直接改内部状态
- `setUserRoles()` 会自动维护 `role -> users` 反向索引
- `deleteRules()` 只删规则，不会删角色本身

## 什么时候优先选它

- 写单测
- 跑 README 或文档里的最小示例
- 快速验证 `PermissionCore` 行为，不想先接真实存储

## 不适合的场景

- 多进程或多实例共享权限数据
- 需要重启保留数据
- 正式生产环境

## 更适合从哪里继续看

- 如果你要文件回退方案：继续看 [FileAdapter](/api/file-adapter)
- 如果你要生产默认路径：继续看 [MonSQLizeStorageAdapter](/api/monsqlize-storage-adapter)
