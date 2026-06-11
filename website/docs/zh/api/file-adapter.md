# FileAdapter

`FileAdapter` 是面向单机、本地演示和文档复核的 JSON 文件持久化适配器。它的目标是“稳定易懂”，不是“多实例高并发”。

## 最简单示例

```typescript
import { FileAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
	storage: new FileAdapter({
		path: './permission-data.json',
	}),
});

await pc.init();
```

## 构造器

```typescript
new FileAdapter(options?: FileAdapterOptions)
```

### FileAdapterOptions

| 选项 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `path` | `string` | 本地 JSON 文件路径 | `./permission-core-data.json` |

## 行为特点

| 能力 | 说明 |
|------|------|
| 启动 | `init()` 读盘并重建反向索引 |
| 关闭 | `close()` 会 flush 仍未落盘的数据 |
| 写盘策略 | 100ms debounce，连续写入时合并成最终状态 |
| 错误处理 | 读写异常统一包装成 `STORAGE_ERROR` |

## API 说明

`FileAdapter` 完整实现了 [StorageAdapter](/zh/api/storage-adapter) 的全部方法。除了抽象契约本身，还要额外记住下面几条：

### 首次启动时文件不存在不算异常

如果目标文件不存在，适配器会以内存空数据启动，而不是直接报错。

### 非法 JSON 会在 `init()` 阶段抛错

这类错误会被包装成 `PermissionCoreError`，错误码是 `STORAGE_ERROR`。

### 写盘失败后会进入“后续读写统一抛错”状态

源码里会把最后一次写盘错误记下来，之后所有读写都会先经过 `throwIfWriteFailed()`。这意味着一旦底层文件系统出错，你能尽早在上层看到失败，而不是继续读到一份不可信状态。

## 适合和不适合的场景

适合：

- 单机调试
- 本地演示
- 文档验证

不适合：

- 多实例共享同一份权限数据
- 高并发写入场景
- 需要数据库级索引、审计或并发控制的生产环境

## 更适合从哪里继续看

- 如果你只需要最轻验证：继续看 [MemoryAdapter](/zh/api/memory-adapter)
- 如果你要生产默认路径：继续看 [MonSQLizeStorageAdapter](/zh/api/monsqlize-storage-adapter)
- 如果你想先理解整体选择：继续看 [存储适配器](/zh/guide/adapters)
