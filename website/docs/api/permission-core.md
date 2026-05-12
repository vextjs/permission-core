# PermissionCore

`PermissionCore` 是运行时最主要的入口。你平时会用到的初始化、关闭、权限判断、行级范围、字段过滤、资源读取和缓存失效，都从这里开始。

## 最简单使用示例

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
	storage: new MemoryAdapter(),
});

await pc.init();

try {
	const ok = await pc.can('user-001', 'invoke', 'GET:/api/users');
} finally {
	await pc.close();
}
```

最重要的使用前提只有一条：所有公共 API 都必须在 `await pc.init()` 之后调用。未初始化时会抛 `NOT_INITIALIZED`，而不是悄悄返回一个默认结果。

## 构造器

```typescript
new PermissionCore(options?: PermissionCoreOptions)
```

### 常用选项

| 选项 | 说明 | 默认建议 |
|------|------|---------|
| `storage` | 规则、角色和用户绑定的存储实现 | 生产默认建议 `MonSQLizeStorageAdapter` |
| `cache` | `cache-hub` 兼容缓存实例或缓存配置 | 未显式传入时，内部应创建默认缓存 |
| `strict` | 是否使用严格模式 | 默认 `true`，`deny` 全局优先于 `allow` |

## 完整 API 一览

| 方法 | 返回值 | 用途 |
|------|--------|------|
| `init()` | `Promise<void>` | 初始化运行时和底层适配器 |
| `close()` | `Promise<void>` | 关闭运行时并释放适配器资源 |
| `can()` | `Promise<boolean>` | 权限布尔判断 |
| `cannot()` | `Promise<boolean>` | `!can(...)` 的语义包装 |
| `assert()` | `Promise<void>` | 无权限时抛异常 |
| `getRowScope()` | `Promise<RowScope>` | 获取标准化行级范围 |
| `canRow()` | `Promise<boolean>` | 对单条记录做行级鉴权 |
| `cannotRow()` | `Promise<boolean>` | `!canRow(...)` 的语义包装 |
| `assertRow()` | `Promise<void>` | 单条记录无权限时抛异常 |
| `filterRows()` | `Promise<Record<string, unknown>[]>` | 过滤记录列表 |
| `filterFields()` | `Promise<Partial<Record<string, unknown>>>` | 按字段权限过滤对象 |
| `getPermissions()` | `Promise<PermissionRule[]>` | 读取用户完整规则列表 |
| `getResources()` | `Promise<string[]>` | 读取用户可用资源列表 |
| `for(userId)` | `PermissionCoreContext` | 绑定 `userId` 的链式上下文 |
| `invalidate(userId)` | `Promise<void>` | 精确清理单用户缓存 |
| `invalidateAll()` | `Promise<void>` | 全量清理缓存 |
| `roles` | `RoleManager` | 角色和规则管理入口 |
| `users` | `UserRoleManager` | 用户与角色绑定入口 |

## 按接入路径怎么用

- `HTTP-only` 常用 `assert()`、`can()` 和 `getResources()`
- `DB-only` 常用 `can()`、`assert()`、`getRowScope()`、`filterRows()` 和 `filterFields()`
- `Full standard stack` 会同时使用接口权限、数据权限、行级范围、缓存失效和管理 API

## 必须单独记住的约束

### 匿名请求约定

公开 API 的 `userId` 约定保持为字符串。未登录请求应由调用方在中间件或 Service 入口直接当作无权限处理，而不是把 `null` 或 `undefined` 传进 `PermissionCore`。

### `filterFields()` 的 `action` 不能省略

`filterFields(userId, action, resource, data)` 的第二个参数必须显式表达当前读写动作。这样才能和 `can(userId, action, resource)` 使用同一套判断逻辑。

### `write` 在请求侧是 AND 语义

如果你调用：

```typescript
await pc.filterFields('user-001', 'write', 'db:articles', payload);
```

它会按 `create && update` 去判断，往往会比预期更严格。写入过滤通常更推荐明确使用 `create` 或 `update`。

### 行级权限和字段过滤是两层能力

`can()` / `assert()` 负责集合门禁。

如果规则里还带了 `where`，你通常会继续用：

- `getRowScope()`：在查库前拿到范围
- `canRow()` / `assertRow()`：对单条记录继续判断
- `filterRows()`：对结果列表做收口

最后才轮到 `filterFields()` 去处理字段级收口。

## `getPermissions()` 和 `getResources()` 的区别

| API | 返回内容 | 更适合谁用 |
|-----|---------|-----------|
| `getPermissions()` | 完整规则列表（含 `allow/deny/action`） | 服务端二次判断、调试、管理能力 |
| `getResources()` | 前端可先参考的资源路径列表 | 前端菜单、按钮、路由显隐 |

需要特别注意：`getResources()` 适合做入口显隐，但它不是最终鉴权结果。存在通配 allow 配合精确 deny 时，前端仍应以 `can()` 为最终判断依据。

## 常见返回结果示例

### `can()` / `cannot()`

```typescript
const canInvoke = await pc.can('user-001', 'invoke', 'GET:/api/orders');
const cannotDelete = await pc.cannot('user-001', 'delete', 'db:orders');
```

返回结果就是布尔值：

```typescript
canInvoke;     // true
cannotDelete;  // true
```

### `assert()`

```typescript
await pc.assert('user-001', 'invoke', 'GET:/api/orders');
```

成功时没有返回 payload：

```typescript
// Promise<void>
```

失败时抛出带 `code` 的错误：

```json
{
	"code": "PERMISSION_DENIED",
	"message": "Permission denied"
}
```

### `filterFields()`

```typescript
const safe = await pc.filterFields('user-001', 'read', 'db:orders', {
	id: 'o-1',
	total: 100,
	internalCost: 80,
});
```

返回结果仍然是对象，但只保留有权限的字段：

```json
{
	"id": "o-1",
	"total": 100
}
```

### `getRowScope()`

```typescript
const scope = await pc.getRowScope('user-001', 'read', 'db:orders');
```

返回结果是标准化后的范围结构：

```json
{
	"mode": "conditional",
	"include": {
		"field": "ownerId",
		"op": "eq",
		"valueFrom": "userId"
	}
}
```

### `canRow()` / `cannotRow()`

```typescript
const canReadRow = await pc.canRow('user-001', 'read', 'db:orders', {
	id: 'o-1',
	ownerId: 'user-001',
});

const cannotReadRow = await pc.cannotRow('user-001', 'read', 'db:orders', {
	id: 'o-2',
	ownerId: 'user-009',
});
```

返回结果仍然是布尔值：

```typescript
canReadRow;     // true
cannotReadRow;  // true
```

### `assertRow()`

```typescript
await pc.assertRow('user-001', 'read', 'db:orders', {
	id: 'o-1',
	ownerId: 'user-001',
});
```

成功时仍然没有返回 payload：

```typescript
// Promise<void>
```

### `filterRows()`

```typescript
const visible = await pc.filterRows('user-001', 'read', 'db:orders', orders);
```

返回结果仍然是数组，只保留当前用户有权看到的记录。

### `getPermissions()`

```typescript
const permissions = await pc.getPermissions('user-001');
```

返回的是完整规则数组：

```json
[
	{
		"type": "allow",
		"action": "invoke",
		"resource": "GET:/api/orders"
	},
	{
		"type": "deny",
		"action": "read",
		"resource": "db:orders:internalCost"
	}
]
```

### `getResources()`

```typescript
const resources = await pc.getResources('user-001', 'invoke');
```

返回结构是纯字符串数组，不是对象数组：

```json
[
	"GET:/api/orders",
	"POST:/api/orders",
	"GET:/api/orders/*"
]
```

这里最好直接记住两点：

- 每一项就是资源路径字符串
- 返回值只说明“这个 action 下可先参考的资源列表”，不是最终放行结果

### `invalidate()` / `invalidateAll()`

```typescript
await pc.invalidate('user-001');
await pc.invalidateAll();
```

这两个方法成功时同样没有返回 payload：

```typescript
// Promise<void>
```

## 一个最常见的用法

```typescript
await pc.assert('user-001', 'invoke', 'GET:/api/orders');

await pc.assert('user-001', 'read', 'db:orders');
const visibleOrders = await pc.filterRows('user-001', 'read', 'db:orders', orders);
const safe = await pc.filterFields('user-001', 'read', 'db:orders', visibleOrders[0]);
```

这个顺序更接近推荐用法：

- 接口入口先判断接口权限
- 进入业务后再判断数据权限
- 然后收口记录范围
- 最后对返回对象做字段过滤

## 相关页面

- [PermissionCoreContext](/api/context)
- [RoleManager](/api/role-manager)
- [UserRoleManager](/api/user-roles)
- [matchResource](/api/match-resource)
- [错误码](/api/errors)

## 下一步看什么

- 想在真正接入前做一次完整确认：看 [接入检查清单](/guide/integration-checklist)
- 想理解接口和数据权限怎么分层：看 [框架接入](/guide/framework-integration)
- 想看错误如何映射到接口响应：看 [错误处理与响应映射](/guide/error-response-mapping)
- 想先解开接入中的高频疑问：看 [常见问题](/guide/faq)