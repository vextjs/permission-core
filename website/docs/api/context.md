# PermissionCoreContext

`PermissionCoreContext` 是通过 `pc.for(userId)` 创建的链式上下文，用于减少重复传入 `userId`。它最适合放在“已经拿到当前用户”的请求链路里。

## 创建方式

```typescript
const ctx = pc.for('user-001');
```

## 什么时候该用它

- 已经在请求上下文拿到 `userId`
- 希望在 Service 层减少重复参数
- 想让调用更接近业务语义，而不是反复传 `userId`

## 常用方法

| 方法 | 对应主类方法 |
|------|-------------|
| `ctx.can(action, resource)` | `pc.can(userId, action, resource)` |
| `ctx.cannot(action, resource)` | `pc.cannot(userId, action, resource)` |
| `ctx.assert(action, resource)` | `pc.assert(userId, action, resource)` |
| `ctx.getRowScope(action, resource, context?)` | `pc.getRowScope(userId, action, resource, context?)` |
| `ctx.canRow(action, resource, row, context?)` | `pc.canRow(userId, action, resource, row, context?)` |
| `ctx.cannotRow(action, resource, row, context?)` | `pc.cannotRow(userId, action, resource, row, context?)` |
| `ctx.assertRow(action, resource, row, context?)` | `pc.assertRow(userId, action, resource, row, context?)` |
| `ctx.filterRows(action, resource, rows, context?)` | `pc.filterRows(userId, action, resource, rows, context?)` |
| `ctx.filterFields(action, resource, data, context?)` | `pc.filterFields(userId, action, resource, data, context?)` |
| `ctx.getPermissions()` | `pc.getPermissions(userId)` |
| `ctx.getResources(action?)` | `pc.getResources(userId, action?)` |

## 一个典型用法

```typescript
async function getProfile(ctx: PermissionCoreContext) {
	await ctx.assert('read', 'db:users');

	const profile = await repo.findProfile();
	await ctx.assertRow('read', 'db:users', profile);
	return ctx.filterFields('read', 'db:users', profile);
}
```

这类写法的优点是：

- 业务方法的参数表更干净
- 接口权限和数据权限语义仍保持一致
- 从主类切到上下文只是少传了一个 `userId`，不会改变行为

## 返回结果怎么理解

链式 API 的返回结果和主类 API 一致，只是少传了一个 `userId` 参数。

例如：

```typescript
const canRead = await ctx.can('read', 'db:users');
const cannotReadRow = await ctx.cannotRow('read', 'db:users', profile);
const resources = await ctx.getResources('invoke');
```

对应结果仍然是：

```typescript
canRead;   // boolean
cannotReadRow; // boolean
resources; // string[]
```

而 `ctx.assert()`、`ctx.filterFields()`、`ctx.getPermissions()` 的结果也分别保持：

- `assert()`：`Promise<void>`，无权限时抛错
- `getRowScope()` / `filterRows()`：行级范围结果
- `canRow()` / `cannotRow()`：布尔结果
- `filterFields()`：过滤后的对象
- `getPermissions()`：完整规则数组

## 注意事项

- `for(userId)` 不是新的运行时实例，只是上下文包装
- `init()` 仍然必须在主类实例上先执行
- 上下文不负责身份鉴别，`userId` 的合法性仍由调用方保证

## 什么时候不需要它

如果你只做一次简单判断，例如只在中间件里调用一次 `assert()`，直接用主类 API 会更直接。

如果你想理解主类与上下文的职责边界，可返回看 [PermissionCore](/api/permission-core)。