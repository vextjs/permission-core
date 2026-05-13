# 框架接入

permission-core 本身不是框架插件，但很适合接到中间件或服务层里。真正需要先想清楚的，不是“要不要写框架专属封装”，而是下面这条分工：

- 框架层负责身份识别和接口权限
- Service / DAO 层负责数据权限、行级范围和字段过滤
- 前端层使用 `getResources()` 先做菜单和按钮的显示/隐藏

## 不管什么框架，接法都差不多

无论你使用 Express、Koa、vext 还是其他 Node.js 框架，核心结构都一样。

### 第 1 层：请求入口处理接口权限

```typescript
const routePath = req.route ?? req.path;
const resource = `${req.method}:${routePath}`;
await pc.assert(userId, 'invoke', resource);
```

这里的 `path` 不应该理解成带实参的实际 URL，而应该理解成“当前命中的规范化路由路径”。

- 支持路由模板字段的框架，优先使用模板路径
- 没有模板字段时，再退回普通 `path`

例如实际请求是 `DELETE /permission/roles/123`，但命中的路由模板是 `/permission/roles/:id`，那么权限资源应该写成 `DELETE:/permission/roles/:id`，而不是 `DELETE:/permission/roles/123`。

参数值本身仍然单独读取，比如：

- `req.params.id`
- `req.valid('param').id`

### 第 2 层：业务层处理数据权限

```typescript
await pc.assert(userId, 'read', 'db:articles');
const visibleRows = await pc.filterRows(userId, 'read', 'db:articles', rows);
const safe = await pc.filterFields(userId, 'read', 'db:articles', data);
```

## 一个重要边界

permission-core 不会自动拦数据库操作。接口权限可以靠中间件统一接入，数据权限必须在业务层主动调用。

这意味着它更像“统一权限内核”，而不是 ORM hook 或数据库代理层。

## 更推荐这样分层

### 框架层

负责：

- 解析登录态
- 构造 `<METHOD>:<path>` 资源，其中 `path` 指规范化后的路由路径；支持模板路由时优先使用模板
- 调 `assert()` 做接口拦截
- 映射权限异常到 HTTP 响应

### Service / DAO 层

负责：

- 对 `db:<collection>[:<field>]` 资源做集合级判断
- 用 `getRowScope()` / `filterRows()` 收口记录范围
- 调用 `filterFields()` 做字段过滤
- 在同一业务方法里组织查询、过滤和返回值结构

### 前端层

负责：

- 调 `getResources()` 获取前端可以先参考的资源列表
- 做菜单、按钮、路由显隐
- 最终敏感操作仍依赖服务端 `can/assert`

## 为什么不要把一切都塞进中间件

如果你把 `db:` 权限和字段过滤也塞回框架中间件，很快会遇到这些问题：

- 中间件拿不到真正的业务对象和字段上下文
- 一个接口内部的多次数据访问无法被清晰区分
- 接口权限和数据权限的失败原因会混在一起

## 三条接入路径分别由哪一层处理

| 路径 | 框架层职责 | 业务层职责 |
|------|-----------|-----------|
| `HTTP-only` | 主要职责都在中间件层 | 业务层不一定需要 `db:` 权限 |
| `DB-only` | 可没有统一中间件 | 业务层主动判断集合级、行级和字段级权限 |
| `Full standard stack` | 中间件 + 业务层同时启用 | 同时启用接口权限、数据权限与行级范围 |

## 更推荐的接入顺序

推荐按这个顺序推进：

1. 先在请求入口跑通 `assert(userId, 'invoke', resource)`
2. 再在 Service / DAO 层加入 `db:` 权限判断
3. 再把 `getRowScope()` / `filterRows()` 接进数据查询链路
4. 最后再加 `filterFields()` 和前端 `getResources()`

这样最容易从 `HTTP-only` 平滑演进到 `Full standard stack`。

## 常见误区

- 用查询串或完整 URL 构造接口资源，而不是只用方法和路径
- 在支持路由模板的框架里，仍用带实参的实际路径拼资源，例如把 `/permission/roles/123` 直接写进权限资源
- 让前端 `getResources()` 结果替代服务端最终鉴权
- 期望框架中间件自动处理 `db:` 权限和字段过滤

具体框架示例看 [Express 接入](/examples/express) 和 [vext 接入](/examples/vext)。

## 下一步看什么

- 想开始按步骤检查自己有没有漏项：看 [接入检查清单](/guide/integration-checklist)
- 想直接看 Node.js 常见接法：看 [Express 接入](/examples/express)
- 想看主运行时 API：看 [PermissionCore](/api/permission-core)