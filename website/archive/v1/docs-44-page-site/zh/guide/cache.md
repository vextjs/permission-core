# 权限缓存

permission-core 缓存用户解析后的权限集合。公共 manager API 会为自身写入自动失效缓存；手工失效主要用于直接写存储、外部同步或跨实例协调。

缓存内容是用户展开并合并后的规则集合，不是某一次 `can()` 的布尔结果。规则仍会在请求时结合 action、resource、deny 优先级和 context 计算，因此不要把缓存层当成最终判定存储。

## 为什么缓存权限

一次鉴权可能合并用户角色、角色规则、继承链、deny 优先级和通配符。缓存避免每次请求都重新解析同一用户图。

## 失效一个用户

```typescript
await pc.invalidate('u-1');
```

通过适配器直写或外部同步改变单个用户绑定后调用。使用 `pc.users.assign()`、`revoke()`、`setUserRoles()` 或 `clearUserRoles()` 后不必再次调用。

精确失效适合只有一个用户的角色绑定变化。外部系统批量同步多个用户时可以逐用户失效；无法可靠列出受影响用户时，全量失效更容易保证正确性。

## 全量失效

```typescript
await pc.invalidateAll();
```

绕过 `pc.roles` 修改角色规则、父角色或共享权限定义后调用。`pc.roles` 的公开写方法已自动处理，无需重复失效。

角色规则可能影响该角色绑定的所有用户，父角色变化还会影响整条继承链，所以不能只清理当前操作者的缓存。直接适配器写入必须由调用方承担这项责任。

当 PermissionCore 共享 `msq.getCache()` 时，只删除 `permission-core:rules:*`，不会清除同一后端中的 MonSQLize 查询缓存。

## 生产说明

推荐生产栈使用 `cache-hub`。缓存后端与 TTL 应匹配部署拓扑；多实例服务需要共享缓存，或确保失效信号能到达每个实例。

停机时调用 `pc.close()`。PermissionCore 只销毁自己创建的缓存实例；外部注入的共享缓存仍由应用或连接 owner 负责生命周期。
