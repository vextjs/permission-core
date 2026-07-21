# Vext 插件

当 Vext 负责插件顺序、请求集成、路由守卫、错误映射和 PermissionCore 关闭时，使用 `permission-core/plugins/vext`。插件消费宿主持有的 MonSQLize 3.1 实例；它不是数据库适配器，也不负责登录。

## 目标与前置条件

- Node.js `>=20.19.0`，这是 Vext 0.3.26 的运行要求。
- 安装 `permission-core`、`monsqlize@3.1.0` 和 `vextjs@0.3.26`。
- 认证插件先运行，并写入可信 `req.auth`。
- 如果要自动响应字段投影，先用 `menus.responses.set()` 或 `menus.config.save()` 保存对应 `api:` 资源和字段配置。

## 注册插件

最容易审计的方式是直接传入宿主数据库实例：

```ts
import { permissionPlugin } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: appMonSQLize,
  authPlugin: 'authentication',
  core: {
    collectionPrefix: 'permission_core',
    tokenSecret: process.env.PERMISSION_TOKEN_SECRET,
  },
});
```

`permissionPlugin(options)` 同步返回 Vext 插件描述符；真正的 `core.init()`、middleware 安装和 `app.permission` 扩展发生在 Vext setup 阶段。插件关闭时只关闭它创建的 PermissionCore，不关闭宿主 MonSQLize。

数据库来源有三种，三者互斥：

| 来源 | 何时使用 |
|---|---|
| `monsqlize` | 直接传入宿主已连接实例。 |
| `resolveMonSQLize(app)` | setup 时从 app 或其他插件异步解析。 |
| 自动发现 `app.monsqlize` | 宿主数据库插件已经把实例挂到 app 扩展上。 |

依赖其他 Vext 插件提供数据库时设置 `databasePlugin`，让 Vext 正确排序。`authPlugin` 默认是 `authentication`。

## 提供可信认证

默认解析器接受两种认证形态：

```ts
req.auth = {
  isAuthenticated: true,
  permissionSubject: { userId: 'u-1', scope: { tenantId: 'acme' } },
};

req.auth = {
  isAuthenticated: true,
  userId: 'u-1',
  scope: { tenantId: 'acme' },
  claims: { merchantId: 'm-7' },
};
```

认证插件使用其他结构时，配置 `resolveSubject(auth, req)`。resolver 必须只读取可信认证对象和宿主上下文，不能相信请求头或请求体里的租户/用户自报值。

## 声明路由权限

```ts
app.get('/public', {}, publicHandler);
app.get('/orders/:id', { permission: true }, orderHandler);
app.post('/orders/export', {
  permission: {
    mode: 'all',
    requirements: [
      { action: 'invoke' },
      { action: 'read', resource: 'db:orders' },
    ],
  },
}, exportHandler);
```

`permission: true` 会自动要求 `invoke + api:GET:/orders/:id` 这类路由资源。对象形式可写自定义要求；省略 `resource` 时使用当前路由的 `api:` 资源。`any/all` 组合最多 `32` 项。

处理器需要额外业务判定时，使用请求权限上下文：

```ts
import { requirePermissionContext } from 'permission-core/plugins/vext';

async function exportHandler(req) {
  const permission = await requirePermissionContext(req);
  await permission.assert('read', 'db:orders');
  return startExport(permission.subject.userId);
}
```

`requirePermissionContext(req)` 返回当前请求专用的 `{ subject, can, assert, filterResponse }`。只想判断上下文是否已经存在时用 `hasPermissionContext(req)`，它不会触发惰性解析。

## 响应字段投影

如果路由使用 `permission: true`，且 handler 通过 `res.json()` 返回数据，插件会对默认 `api:METHOD:/path` 资源自动执行响应字段投影，并写入 `Cache-Control: private, no-store`。

手动裁剪时这样写：

```ts
app.get('/orders/:id', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const payload = await loadOrder(req.params.id);
  const projected = await permission.filterResponse('api:GET:/orders/:id', payload);
  return res.json(projected.data);
});
```

缓存边界很重要：受权限保护的路由不能开启共享缓存。插件检测到受保护路由启用缓存时会以 `VEXT_ROUTE_PERMISSION_INVALID` fail closed。

## 失败与关闭边界

- 缺少认证返回 `401`；认证成功但权限不足返回 `403`。
- MonSQLize 缺失/不兼容、扩展冲突、路由权限元数据无效都会阻止启动。
- 启动后路由图变化返回 `VEXT_ROUTE_RESTART_REQUIRED`（`503`），直到冷重启。
- `req.auth.permission` 只属于当前请求，不能跨请求缓存。
- Vext 关闭时插件先排空 PermissionCore；宿主数据库仍由宿主关闭。

运行 [Vext 示例](/zh/examples/vext)，然后在 [Vext 插件 API](/zh/api/vext-plugin) 查看全部选项和导出类型。
