# Vext 插件

如果你的项目已经使用 Vext、认证插件和 MonSQLize，可以用 `permission-core/plugins/vext` 把路由权限接进去。最小接入只做三件事：注册插件、让认证插件写入可信用户、在需要保护的路由上加 `permission: true`。

先记住一句话：Vext 插件采用 **fail closed** 策略。启动期配置不确定就不启动，运行期路由不一致就返回 `503`，没登录返回 `401`，没权限返回 `403`，响应字段按用户裁剪并禁止共享缓存。

## 最小心智模型

```text
注册 permissionPlugin
  -> 认证插件写入 req.auth
  -> 路由配置 permission: true
  -> 给角色授权 api:METHOD:/path
  -> 请求进来后插件自动检查 invoke 权限
  -> handler 可通过 req.auth.permission.data 读取授权数据
```

你只是做普通接口鉴权时，不需要先理解响应字段、数据库自动发现、插件排序或自定义 subject resolver。需要在接口里读业务数据时，再打开 `data` 配置，让 handler 使用受保护的数据门面，而不是裸 MonSQLize collection。

## 前置条件

- Node.js `>=20.19.0`，这是 Vext 0.3.26 的运行要求。
- 安装 `permission-core`、`monsqlize@3.1.0` 和 `vextjs@0.3.26`。
- 宿主已经有一个连接好的 MonSQLize 3.1 实例。
- 认证插件先运行，并写入可信 `req.auth`。

如果暂时只做路由权限，不需要先配置 `data` 或响应字段权限。只有要在 handler 里自动读授权数据时，才配置 `data`；只有要自动裁剪接口响应字段时，才提前用 `menus.responses.set()` 或 `menus.config.save()` 保存字段配置。

## 1. 注册插件

最简单、最好排查的写法是直接传入宿主数据库实例：

```ts
import { permissionPlugin } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: appMonSQLize,
  core: {
    collectionPrefix: 'permission_core',
    tokenSecret: process.env.PERMISSION_TOKEN_SECRET,
  },
});
```

这里发生了两件事：

- Vext 启动时，插件创建并初始化 `PermissionCore`，然后暴露 `app.permission`。
- Vext 关闭时，插件只关闭它自己创建的 `PermissionCore`，不会关闭宿主的 MonSQLize。

`data` 是可选的。不开启时，handler 仍可做路由权限；开启后，`req.auth.permission.data.collection('orders')` 可用。`exposeAs: 'monsqlize'` 只是多挂一个低心智别名 `req.monsqlize`，它不是完整 MonSQLize，只暴露授权集合门面。

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  data: {
    exposeAs: 'monsqlize',
    scopeFields: { tenantId: 'tenantId' },
    collections: {
      orders: { resource: 'db:orders' },
    },
  },
});
```

`authPlugin` 默认是 `authentication`。如果你的认证插件不是这个名字，再显式配置：

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  authPlugin: 'my-auth',
});
```

## 2. 认证插件提供可信用户

权限插件不负责登录，它只读取认证插件已经写好的 `req.auth`。推荐认证插件直接写入 `permissionSubject`：

```ts
req.auth = {
  isAuthenticated: true,
  permissionSubject: {
    userId: 'u-1',
    scope: { tenantId: 'acme' },
    claims: { merchantId: 'm-7' },
  },
};
```

也可以使用简写结构：

```ts
req.auth = {
  isAuthenticated: true,
  userId: 'u-1',
  scope: { tenantId: 'acme' },
  claims: { merchantId: 'm-7' },
};
```

安全边界很重要：`userId`、`scope` 和 `claims` 必须来自可信认证结果，不能直接相信请求头、请求体或 URL 参数里的用户/租户自报值。

## 3. 保护路由

普通受保护接口只需要加 `permission: true`：

```ts
app.get('/public', {}, publicHandler);

app.get('/orders/:id', { permission: true }, async (req, res) => {
  res.json(await loadOrder(req.params.id));
});
```

`permission: true` 会自动要求当前用户拥有：

```ts
{ action: 'invoke', resource: 'api:GET:/orders/:id' }
```

所以你还需要给角色授权：

```ts
const scoped = app.permission.scope({ tenantId: 'acme' });

await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/orders/:id',
});

await scoped.userRoles.assign('u-1', 'order-reader');
```

这样请求 `/orders/42` 时，插件会用路由模板 `api:GET:/orders/:id` 检查权限，而不是用具体 URL `api:GET:/orders/42`。

## 4. 在 handler 里读取授权数据

如果接口要返回数据库里的订单，不要在 handler 中直接调用裸 MonSQLize collection。启用上面的 `data` 配置后，使用请求期数据门面：

```ts
app.get('/orders', { permission: true }, async (req, res) => {
  const orders = req.monsqlize.collection('orders');
  const items = await orders.find(
    { status: { $in: ['paid', 'shipped'] } },
    {
      projection: ['orderNo', 'status', 'amount'],
      sort: { orderNo: 1 },
      limit: 20,
    },
  );
  res.json({ items, total: items.length });
});
```

这段代码里每个参数的含义：

| 写法 | 作用 |
|---|---|
| `req.monsqlize.collection('orders')` | 取名为 `orders` 的受保护集合；默认资源是 `db:orders`，也可在 `data.collections.orders.resource` 改成其他 `db:*`。 |
| `find(filter, options)` | 执行有界 Mongo 风格查询；插件会把调用方 filter、当前租户 equality、角色行规则和字段权限组合后再访问 MonSQLize。 |
| `projection` | handler 希望读取的字段；最终结果还会和字段权限取交集。 |
| `sort/limit` | 普通列表查询选项；排序字段也必须可读。 |

角色除了路由 `invoke`，还需要数据资源 `read`：

```ts
await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/orders',
});
await scoped.roles.allow('order-reader', {
  action: 'read',
  resource: 'db:orders',
});
```

如果当前 subject 的 scope 是 `{ tenantId: 'acme' }`，并且 `scopeFields.tenantId` 配成文档字段 `tenantId`，那么查询会自动限定 `tenantId = 'acme'`。用户没有 `read + db:orders`、filter 不安全、字段不可读或 scope 字段没配置时，请求会 fail closed。

## 请求结果如何判断

| 场景 | HTTP 结果 | 含义 |
|---|---:|---|
| 公开路由 | `200` | 路由没有配置 `permission`。 |
| 缺少可信认证 | `401` | 没有可用的 `req.auth` 或 subject 不合法。 |
| 已登录但没有路由权限 | `403` | 用户没有对应 `api:METHOD:/path` 的 `invoke` 权限。 |
| 有路由权限但没有数据权限 | `403` | handler 使用数据门面时，用户还缺少对应 `db:*` 的 `read/create/update/delete`。 |
| 已登录且有路由权限 | `200` | 允许进入 handler。 |
| 启动后路由图变化 | `503` | 插件要求冷重启，避免使用过期路由权限。 |

这就是插件的稳定性策略：宁可拒绝，也不在权限状态不确定时继续放行。

## 常见扩展

### 路由还需要额外业务权限

如果路由已经通过 `permission: true`，普通 collection 读写继续使用 `req.monsqlize`。只有 handler 里还要检查额外的非 CRUD 业务动作时，才读取请求权限上下文，例如导出报表、审批订单或启动重算任务：

```ts
import { requirePermissionContext } from 'permission-core/plugins/vext';

app.post('/orders/export', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  await permission.assert('export', 'api:POST:/orders/export');
  res.json(await startExport(permission.subject.userId));
});
```

`requirePermissionContext(req)` 返回当前请求专用的 `{ subject, can, assert, filterResponse }`。这个例子里，`permission: true` 已经检查过 `invoke + api:POST:/orders/export`；额外的 `assert('export', ...)` 是给同一个路由再加一层业务动作判断。不要把它当成读取 `db:orders` 的普通写法，也不要跨请求缓存这个对象。

### 一个路由声明多个权限要求

大多数接口用 `permission: true` 就够了。只有需要组合权限时，才使用对象形式：

```ts
app.post('/orders/export', {
  permission: {
    mode: 'all',
    requirements: [
      { action: 'invoke' },
      { action: 'export' },
    ],
  },
}, exportHandler);
```

省略 `resource` 时，默认使用当前路由的 `api:` 资源，因此这里的 `{ action: 'export' }` 表示 `export + api:POST:/orders/export`。`mode: 'all'` 表示全部满足；`mode: 'any'` 表示满足任意一个。组合项最多 `32` 个。

### 响应字段投影

如果路由使用 `permission: true`，并且 handler 通过 `res.json()` 返回数据，插件会自动按默认 `api:METHOD:/path` 资源执行响应字段投影，并写入：

```text
Cache-Control: private, no-store
```

手动裁剪时这样写：

```ts
app.get('/orders/:id', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const payload = await loadOrder(req.params.id);
  const projected = await permission.filterResponse('api:GET:/orders/:id', payload);
  res.json(projected.data);
});
```

受权限保护的路由不能开启共享缓存。插件检测到受保护路由启用缓存时，会以 `VEXT_ROUTE_PERMISSION_INVALID` 拒绝启动，避免把某个用户的响应裁剪结果缓存给其他用户。

## 高级接入选项

默认建议直接传 `monsqlize`。只有宿主架构需要插件间解析时，才考虑下面的选项：

| 选项 | 何时使用 |
|---|---|
| `monsqlize` | 推荐。直接传入宿主已连接实例。 |
| `resolveMonSQLize(app)` | setup 时从 app 或其他插件异步解析实例。 |
| 自动发现 `app.monsqlize` | 宿主数据库插件已经把实例挂到 app 扩展上。 |
| `databasePlugin` | 数据库由另一个 Vext 插件提供，需要 Vext 正确排序。 |
| `subject.resolve(req)` | 认证插件的 `req.auth` 结构不是默认格式，需要自定义转换。 |
| `data.scopeFields` | handler 需要通过请求门面读写业务数据；`tenantId` 必填。 |
| `data.collections` | 物理 collection 名和逻辑资源名不同，或某个 collection 需要单独 scope 映射。 |
| `data.exposeAs` | 传 `'monsqlize'` 时暴露 `req.monsqlize`；传 `false` 或省略时只使用 `req.auth.permission.data`。 |

这些选项三点要注意：

- `monsqlize`、`resolveMonSQLize(app)` 和自动发现 `app.monsqlize` 是三种数据库来源，不能混用。
- `databasePlugin` 只负责插件排序，不会替你创建数据库连接。
- `subject.resolve(req)` 只能读取可信认证对象和宿主上下文，不能相信客户端自报的身份。
- `req.monsqlize` 不是完整 MonSQLize；它只提供 `collection(name)`，返回 permission-core 的 `AuthorizedCollection`。

## 稳定性与关闭边界

- MonSQLize 缺失、不兼容、扩展冲突、路由权限元数据无效：阻止启动。
- 启动后路由图变化：返回 `VEXT_ROUTE_RESTART_REQUIRED`（`503`），直到冷重启。
- 受保护路由开启共享缓存：阻止启动。
- `req.auth.permission` 和 `req.monsqlize`：只属于当前请求，不能跨请求缓存。
- Vext 关闭：插件排空并关闭 PermissionCore；宿主数据库仍由宿主关闭。

运行 [Vext 示例](/zh/examples/vext) 可以看到完整的 `200/401/403/503` 结果；全部选项和类型见 [Vext 插件 API](/zh/api/vext-plugin)。
