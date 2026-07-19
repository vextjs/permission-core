# 资源路径模型

permission-core 用资源字符串描述被保护对象。资源名应稳定、可预测，并靠近真正执行鉴权的边界。

## 接口资源

格式：

```text
<METHOD>:<path>
```

```text
GET:/api/orders
POST:/api/orders
DELETE:/api/orders/:id
```

优先使用命中的路由模板，不要把带真实 ID 的请求 URL 写成规则。这样规则不会随记录变化。

## 数据资源

格式：

```text
db:<collection>
db:<collection>:<field>
```

```text
db:transactions
db:transactions:amount
db:refunds:internalNote
```

集合资源控制操作是否允许，字段资源决定哪些字段可见或可写。

## 菜单与 API 资源

菜单模块常用：

```text
ui:menu:system.user
ui:page:system.user.list
ui:button:system.user.create
api:POST:/api/users
```

`ui:` 控制导航体验和授权编辑器，`api:` 把一个 UI 操作绑定到一个或多个后端接口。后端仍执行最终鉴权。

## Action

| 范围 | 常用 action |
|------|-------------|
| 接口 | `invoke` |
| 数据 | `read`、`create`、`update`、`delete`、`write`、`*` |

谨慎使用 `write`：规则侧会展开为 `create + update`，请求侧则要求两者都成立。

## 通配符

```typescript
await pc.roles.allow('admin', '*', '*');
```

支付和金融系统应优先使用明确的资源组。内置通配符感知 scheme，并按后缀匹配：`GET:/api/*` 不会授权 `POST:/api/orders`，`db:*` 也不会跨到 `api:` 或 `ui:`；`GET:/api/*/items` 不是通用 glob。

## 行条件不属于资源字符串

把行级限制放在结构化 `where` 中：

```typescript
await pc.roles.allow('merchant-auditor', 'read', 'db:transactions', {
  where: { field: 'merchantId', op: 'eq', valueFrom: 'merchantId' },
});
```

资源仍是稳定的 `db:transactions`，请求上下文提供 `merchantId`，资源匹配与数据谓词因此保持分离。

## 自定义 scheme

通过 `resourceSchemes` 一次注册自定义 scheme。验证器和匹配器会由角色写入、运行时鉴权、菜单校验和授权树共同使用，不要只在一层增加 scheme。

常见错误包括：使用带 ID 或 query 的实际 URL、把 `getResources()` 当最终鉴权、把 tenant ID 不一致地写进资源，以及可以使用受审查前缀时仍授权全局 `*`。

## 下一步

继续看 [角色与规则](/zh/guide/roles-and-rules) 和 [权限鉴权](/zh/guide/check-permission)。
