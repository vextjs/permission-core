# PermissionCache

`PermissionCache` 按 user 与 permission scope 缓存解析后的规则集合。

## 用途与导入

```typescript
import { PermissionCache } from 'permission-core';
```

多数应用通过 `PermissionCore` 配置缓存；只有自定义 runtime 组合或专项测试才需要直接构造。

## 构造与类型

`new PermissionCache(options?: PermissionCacheOptions)` 接受 `enabled`、`ttl`、`maxEntries` 与兼容 `cache-hub` 的 `cache` 实例。

默认 `enabled:true`、`ttl:300000` 毫秒，并创建内部拥有的 `MemoryCache`；提供 `maxEntries` 时会传给内部缓存。

## 签名索引

| 方法 | 返回 |
|---|---|
| `get(userId, scope?)` | `Promise<PermissionRule[] \| null>` |
| `set(userId, rules, scope?)` | `Promise<void>` |
| `invalidate(userId, scope?)` | `Promise<void>` |
| `invalidateScope(scope?)` | `Promise<void>` |
| `invalidateAll()` | `Promise<void>` |
| `close()` | `Promise<void>` |

## 行为与默认值

缓存保存合并后的规则，不保存最终 `can()` 布尔结果。读写都会 clone 规则数组；缓存关闭时读取返回 `null`，写入退化为 no-op。

公共 `pc.users` 写方法自动失效单个用户，公共 `pc.roles` 写方法自动失效对应 scope。手工失效用于直接写 storage 或外部同步。

## 错误与限制

Scope key 隔离租户。`invalidateScope()` / `invalidateAll()` 优先使用 `delPattern`，否则只跟踪并删除已知权限 key；不会清理无关的 MonSQLize query cache。

`close()` 只销毁内部创建的缓存，注入缓存仍由应用拥有。缓存后端失败不会被转换成权限拒绝。

## 最小示例

```typescript
const cache = new PermissionCache({ ttl: 60_000, maxEntries: 1000 });
await cache.set('u-1', rules, { tenantId: 'tenant-a' });
const cached = await cache.get('u-1', { tenantId: 'tenant-a' });
await cache.close();
```

## 相关页面

参见 [权限缓存指南](/zh/guide/cache)、[PermissionCore](/zh/api/permission-core) 与 [生产部署](/zh/guide/production-deployment)。
