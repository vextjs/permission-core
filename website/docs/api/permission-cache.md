# PermissionCache

`PermissionCache` 是 permission-core 内部用于缓存“用户合并后规则集”的轻量封装。它不缓存 `can()`、`assert()` 这类最终判断结果，只缓存同一个用户在当前时刻可用的完整规则数组。

如果你只是正常使用 `PermissionCore`，通常不需要直接 new 它。但当你要接自定义 `cache-hub` 实例，或者想显式关闭缓存、调 TTL、限最大条目数时，这个 API 页就是最直接的参考。

## 最简单示例

```typescript
import { MemoryCache } from 'cache-hub';
import { PermissionCache } from 'permission-core';

const cache = new PermissionCache({
	enabled: true,
	ttl: 60_000,
	cache: new MemoryCache({
		enabled: true,
		defaultTtl: 60_000,
	}),
});

await cache.set('user-001', [
	{ type: 'allow', action: 'invoke', resource: 'GET:/api/orders' },
]);

const rules = await cache.get('user-001');
```

## 构造器

```typescript
new PermissionCache(options?: PermissionCacheOptions)
```

### PermissionCacheOptions

| 选项 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `enabled` | `boolean` | 是否启用缓存 | `true` |
| `ttl` | `number` | 单条缓存 TTL，单位毫秒 | `300000` |
| `maxEntries` | `number` | 内部默认 `MemoryCache` 的最大条目数 | `undefined` |
| `cache` | `CacheLike` | 外部传入的 `cache-hub` 兼容实例 | 未传时内部创建 `MemoryCache` |

## 完整 API

| 方法 | 返回值 | 用途 |
|------|--------|------|
| `get(userId)` | `Promise<PermissionRule[] \| null>` | 读取当前用户已缓存的完整规则集 |
| `set(userId, rules)` | `Promise<void>` | 写入当前用户规则集 |
| `invalidate(userId)` | `Promise<void>` | 精确清掉单个用户缓存 |
| `invalidateAll()` | `Promise<void>` | 清空全部缓存 |

## 必须单独记住的约束

### 它缓存的是“合并后规则”，不是最终判定结果

也就是说，缓存命中后仍然会继续走 `Checker`、资源匹配、`where` 评估、字段过滤这些逻辑。

### `set()` 会先做 `structuredClone`

源码里会在写入缓存前 clone 一份规则数组，避免调用方继续修改同一份数组时把缓存里的内容一起污染。

### `enabled=false` 时读写会退化为 no-op

- `get()` 会直接返回 `null`
- `set()` 不做任何写入
- `invalidate()` / `invalidateAll()` 仍会调用底层清理语义

## 更适合从哪里继续看

- 如果你想看运行时怎么接缓存：继续看 [PermissionCore](/api/permission-core)
- 如果你想先理解缓存策略：继续看 [权限缓存](/guide/cache)
