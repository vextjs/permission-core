# MonSQLizeStorageAdapter

`MonSQLizeStorageAdapter` 是当前官方默认的生产存储路径。它仍然遵守 `StorageAdapter` 抽象，但会把角色、规则和用户绑定拆到独立 collection 中，方便索引、排障和后台管理。

## 最简单示例

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

const msq = new MonSQLize({
	uri: process.env.MONGO_URI!,
	dbName: 'permission_core_demo',
});

const pc = new PermissionCore({
	storage: new MonSQLizeStorageAdapter({
		msq,
		namespace: 'permission_core',
	}),
});

await pc.init();
```

## 构造器

```typescript
new MonSQLizeStorageAdapter(options: MonSQLizeStorageAdapterOptions)
```

### MonSQLizeStorageAdapterOptions

| 选项 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `msq` | `MonSQLize` | 外部传入的 MonSQLize 实例 | 必填 |
| `namespace` | `string` | collection 名前缀 | `permission_core` |
| `ownsConnection` | `boolean` | 是否由适配器负责关闭 `msq` 连接 | `false` |

## collection 规划

默认会创建三类 collection：

- `${namespace}_roles`
- `${namespace}_user_roles`
- `${namespace}_rules`

并在 `init()` 时建立以下索引：

- 三张表的 `_id` 唯一索引
- `user_roles.roleIds` 普通索引

## API 说明

`MonSQLizeStorageAdapter` 完整实现了 [StorageAdapter](/api/storage-adapter) 的全部方法。

它的几个关键约束是：

### 默认不接管外部连接

只有 `ownsConnection=true` 且 `msq.close` 存在时，`close()` 才会真正去关连接。默认行为是“适配器只用连接，不拥有连接”。

### 底层异常会统一包装成 `STORAGE_ERROR`

无论是建索引失败、查询失败还是写入失败，都会通过内部 `withStorageError()` 转成 `PermissionCoreError`，避免把底层实现细节直接泄漏给上层。

### 文档上的“官方默认生产路径”不等于“权限模型绑定 MongoDB”

这里说的是当前内置数据库适配器路径，而不是说 permission-core 的权限模型只能跑在 MongoDB 上。你仍然可以自己实现别的 `StorageAdapter`。

## 什么时候优先选它

- 你要把接口权限、数据权限、后台管理放在同一套生产链路里
- 你已经在用 `monsqlize`
- 你希望和 `cache-hub` 搭配使用官方默认路径

## 更适合从哪里继续看

- 如果你想看一个完整接入示例：继续看 [MonSQLize 适配器示例](/examples/monsqlize-adapter)
- 如果你还在比较适配器：继续看 [存储适配器](/guide/adapters)
