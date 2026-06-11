# matchResource

`matchResource(pattern, resource)` 是一个单独可用的小工具函数，用来判断规则资源是否覆盖实际资源。它只做“资源模式匹配”，不处理 `allow/deny` 优先级，也不处理 action 语义。

## 导入方式

```typescript
import { matchResource } from 'permission-core/match';
```

推荐使用子路径导入，而不是从主入口整体导入。这样在前端场景下更容易避免把 Node.js 专属代码一起打包进去。

## 它解决什么问题

这个函数最适合回答的问题只有一种：

- “这个资源模式，能不能匹配当前这个具体资源？”

例如：

- `*:/api/users/*` 是否覆盖 `GET:/api/users/123`
- `db:users:*` 是否覆盖 `db:users:email`

## 最常见的几个例子

```typescript
matchResource('*:/api/users/*', 'GET:/api/users/123');
matchResource('db:users:*', 'db:users:email');
matchResource('GET:*', 'POST:/api/users');
matchResource('*', 'db:orders:status');
```

## 常见匹配结论

| pattern | resource | 结果 | 原因 |
|---------|----------|------|------|
| `*:/api/users/*` | `GET:/api/users/123` | `true` | 方法通配，路径前缀命中 |
| `GET:*` | `POST:/api/users` | `false` | 方法不匹配 |
| `db:users:*` | `db:users:email` | `true` | 字段通配命中 |
| `*` | `db:users:email` | `true` | 全局通配 |

## 适合场景

- 前端按钮和菜单显隐
- 纯资源匹配判断
- 不需要完整运行时实例的地方

## 不适合解决什么

它不适合直接回答这些问题：

- 当前用户最终有没有权限
- `deny` 是否覆盖了 `allow`
- `write` 是否应展开成 `create + update`

这些问题都属于 `PermissionCore` 运行时或 checker 语义，而不是纯资源匹配。

## 一个前端场景

如果你的前端已经拿到后端下发的资源列表：

```typescript
const resources = ['GET:/api/users', 'GET:/api/orders/*'];
const visible = resources.some((item) => matchResource(item, 'GET:/api/orders/123'));
```

这类用法是合理的，但它仍然只是“先做页面显示/隐藏”。真正敏感的后端操作仍然应以服务端 `can/assert` 为准。

## 常见误区

- 把 `matchResource()` 当成完整鉴权函数
- 让前端基于它自行推导 `allow/deny` 权重
- 用主入口导入而不是子路径导入，增加不必要的打包体积

如果你想看字段级数据权限如何落地，可继续看 [字段权限示例](/zh/examples/field-permission)。