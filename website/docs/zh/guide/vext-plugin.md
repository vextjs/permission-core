# Vext 插件

如果你的项目已经使用 Vext、token 认证、Vext database 插件和 MonSQLize，可以用 `permission-core/plugins/vext` 把“认证后的用户”接到接口权限、数据权限和响应字段权限。普通接入时，业务代码最好仍然沿用 Vext 原来的 `app.db.collection()`、`app.db.model()` 和 service 写法；权限插件只负责在受保护请求里把这些入口安全增强。

先记住一句话：前端可以传 token，但 token 必须先由认证插件验证；permissionPlugin 只读取可信 `req.auth`。后面所有路由权限、数据权限和响应字段投影，都基于这个可信用户执行。

## 先看最终写法

接入完成后，插件配置通常长这样：

```ts
import { permissionPlugin } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: appMonSQLize,
  routes: {
    protect: ['/api/**'],
    public: ['/api/auth/**', '/api/health'],
  },
  data: {
    transparent: true,
    scopeFields: { tenantId: 'tenantId' },
  },
});
```

业务代码继续像 Vext 原来那样写：

```ts
export default class OrderService {
  constructor(private app: VextApp) {}

  async listPaidOrders() {
    const Order = this.app.db.model('Order');
    return Order.find(
      { status: { $in: ['paid', 'shipped'] } },
      {
        projection: ['orderNo', 'status', 'amount'],
        sort: { orderNo: 1 },
        limit: 20,
      },
    );
  }
}
```

你只需要先理解三点：

- `routes.protect`：服务端配置哪些路由默认受保护，不需要每个路由都写 `permission: true`。
- `routes.public`：服务端配置哪些路由明确公开，例如登录和健康检查。
- `data.transparent: true`：在受保护请求里，`app.db.collection()` / `app.db.model()` 自动合入租户、数据行和字段权限；后台任务和公开路由仍然使用宿主原始 DB。

## 接入流程一览

```text
前端 token
  -> 认证插件验证 token 并写入可信 req.auth
  -> 注册 permissionPlugin
  -> routes.protect 批量保护业务路由
  -> 给角色授权 api:METHOD:/path
  -> service/handler 沿用 app.db.collection(...) 或 app.db.model(...)
  -> 插件自动做 401/403、数据权限和响应字段裁剪
```

如果暂时只做接口鉴权，只需要配置 `routes.protect/public` 和接口授权；如果 handler 或 service 要读写数据库，再开启 `data.transparent`；如果要裁剪返回字段，再看“响应字段投影”。底层 canonical API、`req.monsqlize` 兼容入口和完整类型见 [Vext 插件 API](/zh/api/vext-plugin)，不作为首次接入主路径。

## 前置条件

- Node.js `>=20.19.0`，这是 Vext 0.3.26 的运行要求。
- 安装 `permission-core`、`monsqlize@3.1.0` 和 `vextjs@0.3.26`。
- 宿主已经有一个连接好的 MonSQLize 3.1 实例；如果使用 Vext database 插件，通常已经有 `app.db` 和 `app.monsqlize`。
- 认证插件先运行，验证 token，并写入可信 `req.auth`。

如果暂时只做路由权限，不需要先配置 `data` 或响应字段权限。只有要让 `app.db.collection()` / `app.db.model()` 在受保护请求里自动套数据权限时，才配置 `data.transparent`；只有要自动裁剪接口响应字段时，才提前用 `menus.responses.set()` 或 `menus.config.save()` 保存字段配置。响应字段的最小配置见本页“响应字段投影”。

## 1. 认证插件先验证 token

permission-core 不负责登录，也不会直接相信前端传来的 token。正确链路是：认证插件验证 token 签名、会话和过期时间，然后把可信用户写入 `req.auth`。推荐认证插件直接写入 `permissionSubject`：

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

## 2. 注册 permissionPlugin

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

`routes` 是可选的，但推荐在业务 API 前缀上统一开启权限：

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  routes: {
    protect: ['/api/**'],
    public: ['/api/auth/**', '/api/health'],
  },
});
```

这表示 `/api/**` 默认都要检查接口权限，`/api/auth/**` 和 `/api/health` 明确公开。是否开启权限由服务端配置决定，不由前端请求头决定。

`data` 是可选的。不开启时，handler 仍可做路由权限；开启 `transparent` 后，受保护请求里的 `app.db.collection()` 和 `app.db.model()` 会自动走权限保护。这里不用手动写 `resource: 'db:orders'`。`collection('orders')` 默认访问宿主的 `orders` collection，并自动推导权限资源 `db:orders`。

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  data: {
    transparent: true,
    scopeFields: { tenantId: 'tenantId' },
  },
});
```

只有物理 collection 名和权限资源名不一致，或某个 collection 需要单独 scope 映射时，才写 `collections` 覆盖：

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  data: {
    transparent: true,
    scopeFields: { tenantId: 'tenantId' },
    collections: {
      vext_orders: { resource: 'db:orders' },
    },
  },
});
```

老项目如果已经用了 `req.monsqlize.collection(...)`，可以继续保留兼容入口：

```ts
export default permissionPlugin({
  monsqlize: appMonSQLize,
  data: {
    exposeAs: 'monsqlize',
    scopeFields: { tenantId: 'tenantId' },
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

## 3. 路由默认保护和单路由覆盖

推荐用 `routes.protect/public` 批量声明大部分业务路由，不需要每个接口重复写 `permission: true`：

```ts
app.get('/public', {}, publicHandler);

app.get('/api/orders/:id', {}, async (req, res) => {
  res.json(await loadOrder(req.params.id));
});
```

如果 `/api/orders/:id` 命中 `routes.protect: ['/api/**']`，插件会自动要求当前用户拥有：

```ts
{ action: 'invoke', resource: 'api:GET:/api/orders/:id' }
```

这样请求 `/api/orders/42` 时，插件会用路由模板 `api:GET:/api/orders/:id` 检查权限，而不是用具体 URL `api:GET:/api/orders/42`。

单路由仍然可以覆盖：

```ts
app.get('/api/public-products', { permission: false }, publicHandler);

app.post('/api/orders/export', {
  permission: {
    mode: 'all',
    requirements: [
      { action: 'invoke' },
      { action: 'export' },
    ],
  },
}, exportHandler);
```

## 4. 给角色授权接口权限

路由被 `routes.protect` 命中，或单独写了 `permission: true` 以后，还需要给角色授予对应 API 权限：

```ts
const scoped = app.permission.scope({ tenantId: 'acme' });

await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/api/orders/:id',
});

await scoped.userRoles.assign('u-1', 'order-reader');
```

## 5. 业务 CRUD 继续使用 app.db

如果接口要返回数据库里的订单，启用 `data.transparent` 后，受保护请求里的 `app.db.collection()` 会自动变成权限保护后的 collection：

```ts
app.get('/api/orders', {}, async (req, res) => {
  const orders = req.app.db.collection('orders');
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

如果你的项目把查询放在 Vext service 里，也可以继续用 `this.app.db`：

```ts
export default class OrderService {
  constructor(private app: VextApp) {}

  async listPaidOrders() {
    const orders = this.app.db.collection('orders');
    return orders.find({ status: 'paid' }, {
      projection: ['orderNo', 'status', 'amount'],
      sort: { orderNo: 1 },
    });
  }
}
```

使用 Vext model 层时，基础 CRUD 也可以这样写：

```ts
export default class OrderService {
  constructor(private app: VextApp) {}

  async listPaidOrdersByModel() {
    const Order = this.app.db.model('Order');
    return Order.find({ status: 'paid' }, {
      projection: ['orderNo', 'status', 'amount'],
      sort: { orderNo: 1 },
    });
  }
}
```

这段代码里每个参数的含义：

| 写法 | 作用 |
|---|---|
| `req.app.db.collection('orders')` / `this.app.db.collection('orders')` | 在受保护请求上下文中取权限保护后的 `orders` 集合；默认资源是 `db:orders`。 |
| `this.app.db.model('Order')` | 在受保护请求上下文中按 model 的 `collectionName` 找到对应 collection，再套数据权限。R1 透明 facade 覆盖基础 CRUD；`raw()`、索引管理、`aggregate()`、`watch()` 等高级能力不会静默绕过权限。 |
| `find(filter, options)` | 执行有界 Mongo 风格查询；插件会把调用方 filter、当前租户 equality、角色行规则和字段权限组合后再访问 MonSQLize。 |
| `projection` | handler 希望读取的字段；最终结果还会和字段权限取交集。 |
| `sort/limit` | 普通列表查询选项；排序字段也必须可读。 |

角色除了路由 `invoke`，还需要数据资源 `read`：

```ts
await scoped.roles.allow('order-reader', {
  action: 'invoke',
  resource: 'api:GET:/api/orders',
});
await scoped.roles.allow('order-reader', {
  action: 'read',
  resource: 'db:orders',
});
```

如果当前 subject 的 scope 是 `{ tenantId: 'acme' }`，并且 `scopeFields.tenantId` 配成文档字段 `tenantId`，那么查询会自动限定 `tenantId = 'acme'`。用户没有 `read + db:orders`、filter 不安全、字段不可读或 scope 字段没配置时，请求会 fail closed。

注意：`app.db.use(...)`、`app.db.pool(...)`、model 的 `raw()`、集合/索引管理、`aggregate()`、`watch()` 等高级能力在受保护请求中不会透明放行。需要这些能力时，应该在服务端明确设计资源、规则和审计边界，而不是默认绕过权限。

## 6. 请求结果如何判断

| 场景 | HTTP 结果 | 含义 |
|---|---:|---|
| 公开路由 | `200` | 路由没有命中 `routes.protect`，或命中了 `routes.public` / `permission: false`。 |
| 缺少可信认证 | `401` | 没有可用的 `req.auth` 或 subject 不合法。 |
| 已登录但没有路由权限 | `403` | 用户没有对应 `api:METHOD:/path` 的 `invoke` 权限。 |
| 有路由权限但没有数据权限 | `403` | handler 使用数据门面时，用户还缺少对应 `db:*` 的 `read/create/update/delete`。 |
| 已登录且有路由权限 | `200` | 允许进入 handler。 |
| 启动后路由图变化 | `503` | 插件要求冷重启，避免使用过期路由权限。 |

这就是插件的稳定性策略：宁可拒绝，也不在权限状态不确定时继续放行。

## 7. 响应字段投影（需要时）

字段权限不是写在 handler 里的。先在管理端保存这个 API 允许返回哪些字段：

```ts
await scoped.menus.responses.set('admin', {
  owner: {
    ownerType: 'load',
    viewId: 'orders-list',
    resource: 'api:GET:/orders',
  },
  response: {
    target: 'items',
    preserve: ['total'],
    fields: [
      { field: 'orderNo', title: 'Order No.' },
      { field: 'status', title: 'Status' },
      { field: 'amount', title: 'Amount' },
    ],
  },
});
```

这表示 `/orders` 返回 `{ items, total }` 时，只裁剪 `items` 里的字段，`total` 保留。保存后，再把字段权限分配给角色；具体分配流程见[接口与响应字段](/zh/guide/api-bindings)。

如果路由被权限保护（来自 `routes.protect` 或单路由 `permission`），并且 handler 通过 `res.json()` 返回数据，插件会自动按默认 `api:METHOD:/path` 资源执行响应字段投影，并写入：

```text
Cache-Control: private, no-store
```

手动裁剪时这样写：

```ts
app.get('/api/orders/:id', {}, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const payload = await loadOrder(req.params.id);
  const projected = await permission.filterResponse('api:GET:/api/orders/:id', payload);
  res.json(projected.data);
});
```

受权限保护的路由不能开启共享缓存。插件检测到受保护路由启用缓存时，会以 `VEXT_ROUTE_PERMISSION_INVALID` 拒绝启动，避免把某个用户的响应裁剪结果缓存给其他用户。

## 8. 额外权限（需要时）

### 一个路由声明多个权限要求

大多数接口命中 `routes.protect` 就够了。只有需要组合权限时，才在单路由使用对象形式：

```ts
app.post('/api/orders/export', {
  permission: {
    mode: 'all',
    requirements: [
      { action: 'invoke' },
      { action: 'export' },
    ],
  },
}, exportHandler);
```

省略 `resource` 时，默认使用当前路由的 `api:` 资源，因此这里的 `{ action: 'export' }` 表示 `export + api:POST:/api/orders/export`。`mode: 'all'` 表示全部满足；`mode: 'any'` 表示满足任意一个。组合项最多 `32` 个。

这适合静态权限：路由一进入 handler 前就要同时满足 `invoke` 和 `export`。普通 collection/model 读写仍然继续使用 `app.db`。

### handler 里动态检查额外权限

只有额外权限取决于 handler 里的业务条件时，才读取请求权限上下文。例如同一个审批接口里，超过某个金额才要求 `approve-large-order`：

```ts
import { requirePermissionContext } from 'permission-core/plugins/vext';

app.post('/api/orders/:id/approve', {}, async (req, res) => {
  const order = await loadOrder(req.params.id);

  if (order.amount >= 10000) {
    const permission = await requirePermissionContext(req);
    await permission.assert('approve-large-order', 'api:POST:/api/orders/:id/approve');
  }

  res.json(await approveOrder(order.id));
});
```

`requirePermissionContext(req)` 返回当前请求专用的 `{ subject, can, assert, filterResponse }`。路由默认保护已经检查过 `invoke + api:POST:/api/orders/:id/approve`；handler 里的 `assert()` 只是追加动态条件。不要把它当成读取 `db:orders` 的普通写法，也不要跨请求缓存这个对象。

## 9. 高级接入选项

默认建议直接传 `monsqlize`。只有宿主架构需要插件间解析时，才考虑下面的选项：

| 选项 | 何时使用 |
|---|---|
| `monsqlize` | 推荐。直接传入宿主已连接实例。 |
| `resolveMonSQLize(app)` | setup 时从 app 或其他插件异步解析实例。 |
| 自动发现 `app.monsqlize` | 宿主数据库插件已经把实例挂到 app 扩展上。 |
| `databasePlugin` | 数据库由另一个 Vext 插件提供，需要 Vext 正确排序。 |
| `routes.protect` | 按服务端路由模式批量开启接口权限，例如 `['/api/**']`。 |
| `routes.public` | 从默认保护里排除公开路由，例如登录、健康检查。 |
| `subject.resolve(req)` | 认证插件的 `req.auth` 结构不是默认格式，需要自定义转换。 |
| `data.transparent` | 受保护请求里透明保护 `app.db.collection()` / `app.db.model()`；推荐主路径。 |
| `data.scopeFields` | 需要透明或显式读写业务数据时配置；`tenantId` 必填。 |
| `data.collections` | 物理 collection 名和逻辑资源名不同，或某个 collection 需要单独 scope 映射。 |
| `data.exposeAs` | 兼容入口。传 `'monsqlize'` 暴露 `req.monsqlize`；传 `'db'` 暴露 `req.db`；传 `false` 或省略时只使用 `req.auth.permission.data`。 |

这些选项三点要注意：

- `monsqlize`、`resolveMonSQLize(app)` 和自动发现 `app.monsqlize` 是三种数据库来源，不能混用。
- `databasePlugin` 只负责插件排序，不会替你创建数据库连接。
- `subject.resolve(req)` 只能读取可信认证对象和宿主上下文，不能相信客户端自报的身份。
- `routes.protect/public` 来自服务端配置；不要让前端请求头决定是否启用或绕过权限。
- `data.transparent` 只在受保护请求上下文中增强 `app.db`；非请求上下文、后台任务和公开路由仍走宿主原始 DB。

## 稳定性与关闭边界

- MonSQLize 缺失、不兼容、扩展冲突、路由权限元数据无效：阻止启动。
- 启动后路由图变化：返回 `VEXT_ROUTE_RESTART_REQUIRED`（`503`），直到冷重启。
- 受保护路由开启共享缓存：阻止启动。
- `req.auth.permission`、`req.monsqlize`、`req.db` 和透明 `app.db` 授权结果：只属于当前请求，不能跨请求缓存。
- Vext 关闭：插件排空并关闭 PermissionCore；宿主数据库仍由宿主关闭。

运行 [Vext 示例](/zh/examples/vext) 可以看到完整的 `200/401/403/503` 结果；全部选项和类型见 [Vext 插件 API](/zh/api/vext-plugin)。
