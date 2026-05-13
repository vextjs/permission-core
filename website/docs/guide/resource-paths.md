# 资源路径模型

permission-core 用统一的 `action + resource` 方式描述权限。你可以先把它理解成两件事：

- 你想做什么
- 你想对什么做

v1 只支持两类资源：接口资源和数据资源。

## 为什么要先理解资源，而不是先理解角色

因为角色、规则和缓存最后都要落到“某个 action 对某个 resource 是否成立”这个判断上。资源模型如果没读懂，后面的 `allow/deny`、`getResources()`、`filterFields()` 都会看起来像零散 API，而不是一套统一语言。

## 接口资源

格式：`<METHOD>:<path>`

这里的 `path` 不应该理解成“浏览器地址栏里看到的完整 URL”，而应该理解成“当前命中的规范化路由路径”。

- 如果框架能暴露路由模板，优先使用模板路径
- 如果拿不到模板路径，再退回普通 `path`
- 不要把查询串、hash 或完整 URL 一起拼进资源字符串

示例：

- `GET:/api/users`
- `POST:/api/orders`
- `DELETE:/api/users/:id`
- `*:/api/admin/*`

关键规则：

- `METHOD` 必须大写
- `path` 应该是规范化后的命中路由路径，而不是带查询串的实际 URL
- `:id` 表示单段路径参数
- 末段 `*` 表示匹配后续子路径
- `*:/api/users/*` 不会匹配 `GET:/api/users`
- 中间位置的 `*` 不被支持，像 `GET:/api/*/items` 不会命中 `GET:/api/v1/items`

### 路由模板优先，而不是实际 URL

如果你的框架支持路由模板字段，带参数的接口资源应优先使用模板路径。

例如：

- 实际请求：`DELETE /api/users/123`
- 命中的模板路由：`/api/users/:id`
- 正确资源：`DELETE:/api/users/:id`

这样做的目的是让规则保持稳定、低基数，而不是把每个实参后的 URL 都当成新资源。

### 接口通配符边界

当前接口资源的通配符规则，最好按下面这组边界理解：

| 规则资源 | 请求资源 | 是否匹配 | 说明 |
|---------|---------|---------|------|
| `GET:*` | `GET:/api/orders` | 是 | 方法固定为 `GET`，路径任意 |
| `*:/api/users/*` | `GET:/api/users/123` | 是 | 末段 `*` 匹配后续子路径 |
| `*:/api/users/*` | `GET:/api/users` | 否 | 末段 `*` 需要至少多出一段路径 |
| `GET:/api/*/items` | `GET:/api/v1/items` | 否 | 中间位置的 `*` 不支持 |
| `GET:/api/:id` | `GET:/api/42` | 是 | `:id` 只匹配单段路径参数 |
| `GET:/api/:id` | `GET:/api/42/detail` | 否 | `:id` 不会跨多段路径 |

### 设计意图

接口资源使用 `<METHOD>:<path>` 而不是只写路径，是为了避免下面这种歧义：

- `GET:/api/orders`
- `POST:/api/orders`

它们路径相同，但权限语义并不相同。把方法和路径合并成一个资源字符串，可以让接口权限的配置和运行时判断都保持一致；而把 `path` 解释成规范化后的命中路由路径，又能避免参数化路由被实参打散。

## 数据资源

格式：`db:<collection>[:<field>]`

示例：

- `db:users`
- `db:users:email`
- `db:orders:status`
- `db:*`

关键规则：

- v1 只支持集合级和顶层字段级
- 不支持 `address.city` 这种嵌套字段
- 行级权限通过规则的 `where` 条件表达，不通过资源字符串表达

### 设计意图

`db:<collection>[:<field>]` 的好处是：

- 不把权限模型绑死在具体数据库方言
- 集合级和字段级共享同一套资源表达
- `filterFields()` 可以自然把对象字段展开成字段资源进行判断

### 行级权限为什么不改资源格式

如果你想表达“只能看自己的订单”，资源仍然写成 `db:orders`，条件写在规则元数据里：

```typescript
await pc.roles.allow('sales', 'read', 'db:orders', {
	where: { field: 'ownerId', op: 'eq', valueFrom: 'userId' },
});
```

这样做有两个直接好处：

- 资源模型继续保持数据库无关
- 后台规则保存、缓存和运行时判断都能沿用同一套结构

想看完整运行时分层，可以继续看 [行级权限](/guide/row-level)。

也正因为 v1 先只支持顶层字段，所以像 `db:users:address.city` 这样的写法，当前先不要按“已经支持”来理解。

## action 对照

| 资源类型 | action |
|---------|--------|
| 接口资源 | `invoke` / `*` |
| 数据资源 | `read` / `create` / `update` / `delete` / `write` / `*` |

## `write` 为什么值得单独提醒

`write` 看起来像一个普通动作，但它其实是组合动作：

- 规则侧：表示授予 `create + update`
- 请求侧：表示必须同时满足 `create && update`

所以资源模型和 action 模型虽然是两个维度，但在写入场景里会一起影响运行时判断。

## 几个最容易看懂的匹配例子

下面这些例子比较适合帮助建立资源匹配直觉：

| 规则资源 | 请求资源 | 是否应匹配 | 原因 |
|---------|---------|-----------|------|
| `GET:/api/users` | `GET:/api/users` | 是 | 完全相同 |
| `*:/api/users/*` | `GET:/api/users/123` | 是 | 方法通配，路径前缀命中 |
| `*:/api/users/*` | `GET:/api/users` | 否 | 子路径通配不应自动覆盖根路径 |
| `db:users` | `db:users` | 是 | 集合级匹配 |
| `db:users:*` | `db:users:email` | 是 | 字段通配匹配 |
| `db:users:*` | `db:orders:email` | 否 | 集合不同 |

## 常见误区

- 不要把 `invoke` 用在 `db:` 资源上
- 不要把 `read` / `write` 用在接口资源上
- 不要把全局资源 `*` 和细分 action 混写成不清晰规则
- 不要把“是否使用 MonSQLize”误当成“是否启用 db 资源”

## 继续往下读什么

如果你已经理解了资源格式，下一步最好读：

- [角色与规则](/guide/roles-and-rules)：看资源如何进入规则模型
- [权限鉴权](/guide/check-permission)：看资源如何进入运行时判断
- [接入阅读顺序](/guide/implementation-reading-order)：看开始接入时应该怎么排阅读和落地顺序

想继续了解规则怎么组合，下一篇看 [角色与规则](/guide/roles-and-rules)。