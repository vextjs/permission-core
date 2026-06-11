# 权限缓存

permission-core 默认通过 `cache-hub` 缓存“某个用户最后真正能用的规则”，这样就不用每次判断权限都重新展开继承链、重新合并规则。

## 它缓存的不是某一次 `can()` 的结果

它缓存的是“某个用户最后可用的规则集合”，而不是某次 `can()` 返回的 true/false。

这样设计的好处是：

- `can()`、`assert()`、`getPermissions()`、`getResources()` 都能复用同一份展开结果
- 规则合并和继承链展开只需要做一次
- 不会因为缓存了某次布尔结果而把不同资源请求混在一起

## 一次常见的读取过程

1. 先拿用户直接绑定的角色
2. 展开角色继承链
3. 合并 allow / deny 规则
4. 把最终规则集合放入缓存
5. 后续 `can/assert/getPermissions/getResources` 复用这份结果

这也是为什么缓存层对三条接入路径都有效，而不只是 `Full standard stack`。

## 两类失效

### 全量失效

规则变化时触发，常见操作包括：

- `allow`
- `deny`
- `revokeRule`
- `clearRules`
- `roles.update()`
- `roles.delete()`

### 精确失效

用户绑定变化时触发：

- `assign`
- `revoke`
- `setUserRoles`
- `clearUserRoles`

## 为什么规则变化要偏向全量失效

因为角色规则变化可能影响一整条继承链上的多个用户，而不仅仅是直接绑定该角色的用户。首版方案选择“最简单、最安全”的默认策略：

- 规则变更：`invalidateAll()`
- 用户绑定变更：`invalidate(userId)`

你可以把它理解成：宁可多清一点缓存，也先保证结果正确。

如果 `PermissionCore` 复用的是 `msq.getCache()` 返回的共享缓存，`invalidateAll()` 只会清理 `permission-core:rules:*` 前缀下的权限规则缓存，不会调用底层 `cache.clear()` 去清空 MonSQLize 查询缓存。

## 对接入者的意义

- `HTTP-only` 场景依然受益于缓存，因为接口权限同样依赖角色继承和规则合并
- `DB-only` 场景同样受益，因为集合级和字段级权限判断会频繁复用同一份规则集
- `Full standard stack` 场景最能放大 `cache-hub` 的价值，因为接口资源、数据资源和资源列表拉取会同时命中缓存

## 配置建议

### 本地验证或文档演示

默认 `MemoryCache` 即可，重点先确认规则判断和缓存清理是否符合预期。

### 正式生产环境

继续沿用官方标准栈：

- 存储：`MonSQLizeStorageAdapter`
- 缓存：`cache-hub`

这样可以保持规则持久化和缓存策略的一致口径。

## 一个容易误解的点

缓存层不改变权限语义。无论命中缓存与否，`deny` 优先级、`write` 语义和资源匹配规则都必须保持一致。

## 常见误区

- 缓存单次 `can()` 结果，而不是缓存规则集合
- 角色规则变化后只精确失效单用户
- 以为 `HTTP-only` 场景不需要缓存

如果你想看运行时主入口怎么暴露缓存失效 API，可继续看 [PermissionCore](/zh/api/permission-core)。

如果你想直接查缓存构造参数和失效方法，可继续看 [PermissionCache API](/zh/api/permission-cache)。
