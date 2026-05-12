# 权限鉴权

permission-core 提供三组最常用的运行时 API：

- `can()`
- `cannot()`
- `assert()`

当你进入数据权限场景后，还会继续用到第二组 API：

- `getRowScope()`
- `canRow()`
- `cannotRow()`
- `assertRow()`
- `filterRows()`

## 在运行时它们分别适合用在哪里

这三个 API 不只是写法不同，它们本来就是给不同位置用的：

- `can()`：业务逻辑里需要布尔结果
- `cannot()`：希望条件语义更直接
- `assert()`：中间件、Service 守卫和失败时直接报错退出的场景

在使用它们之前，先做到一件事：先执行 `await pc.init()`。

## `can`

```typescript
const ok = await pc.can('user-001', 'invoke', 'GET:/api/orders');
```

适合：

- 需要布尔值分支判断
- 想把权限判断嵌到业务逻辑中

不适合：

- 想把失败直接当异常抛出时
- 中间件里需要统一终止当前请求时

## `assert`

```typescript
await pc.assert('user-001', 'invoke', 'GET:/api/orders');
```

适合：

- 中间件拦截
- Service / DAO 层前置守卫
- 想把“无权限”当成异常出口处理

这也是更适合接口入口守卫的写法。

## `cannot`

是 `!can(...)` 的语义包装，适合让业务语义更直接。

最小片段可以先记成：

```typescript
const blocked = await pc.cannot('user-001', 'delete', 'db:orders');
```

## `can` 和 `assert` 应该怎么选

| 场景 | 更推荐 |
|------|--------|
| 中间件或守卫 | `assert()` |
| Service 内部条件分支 | `can()` |
| 需要读起来更自然的否定判断 | `cannot()` |

不要把它们理解为完全等价的三种写法。对权限系统来说，“返回 true/false”和“直接报错退出”通常应该分开使用。

## `write` 的特殊点

`write` 有两层语义：

- 规则侧：`write` 表示同时授予 `create + update`
- 请求侧：`can(userId, 'write', resource)` 等价于 `create && update`

所以它不是简单别名，而是一个需要在文档和测试里都写清楚的组合动作。

### 为什么这会影响日常使用

因为很多开发者第一直觉会把 `write` 当成“普通写权限”。但在当前设计里，`write` 更像一个快捷动作：

- 在规则中它方便配置
- 在请求中它更严格

所以读写分明的业务代码，通常更推荐直接传 `create` 或 `update`。

## `getResources`

接口权限场景经常配合：

```typescript
const resources = await pc.getResources('user-001', 'invoke');
```

它的返回结构就是字符串数组：

```json
[
	"GET:/api/orders",
	"POST:/api/orders"
]
```

用途：

- 菜单和按钮的显示/隐藏
- 登录后初始化前端资源列表

限制：

- 返回结果看起来像有权限，但实际不一定最终放行
- 最终权限判断仍以 `can()` 为准

也就是说，`getResources()` 更像“前端先参考的一份资源清单”，不是最终放行结果，也不是对象结构。

### 为什么它看起来有权限，实际却不一定能放行

因为它返回的是资源列表，而不是完整的最终判定过程。遇到“通配 allow + 精确 deny”这类组合时，前端只看资源列表可能会高估用户权限。

## 行级权限不应该继续塞回 `can()` 里

`can()` / `assert()` 回答的是“这个集合能不能进入”。

如果你要继续回答“进入以后，哪些记录允许保留”，就该切到：

- `getRowScope()`：拿到标准化范围，适合做查询下推
- `canRow()` / `cannotRow()` / `assertRow()`：判断单条记录
- `filterRows()`：过滤列表结果

最小片段可以先记成：

```typescript
const canReadRow = await pc.canRow('user-001', 'read', 'db:orders', order);
const cannotReadForeign = await pc.cannotRow('user-001', 'read', 'db:orders', foreignOrder);
await pc.assertRow('user-001', 'read', 'db:orders', order);
```

这层分工的好处是：集合门禁、记录范围、字段收口三件事不会混成一个黑盒 API。

## 最常见的一次调用顺序

```typescript
await pc.assert('user-001', 'invoke', 'GET:/api/orders');

await pc.assert('user-001', 'read', 'db:orders');

const visibleOrders = await pc.filterRows('user-001', 'read', 'db:orders', orders);

return Promise.all(
	visibleOrders.map(order => pc.filterFields('user-001', 'read', 'db:orders', order)),
);
```

这个顺序体现的是：

- 先拦接口
- 再拦数据集合
- 然后收口记录范围
- 最后过滤字段

如果你要继续看集合、行、字段三层怎么拆，下一篇先看 [行级权限](/guide/row-level)，再看 [字段过滤](/guide/field-filter)。