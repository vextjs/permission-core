# Vext 插件

当 Vext 需要负责插件顺序、请求集成、路由守卫、错误映射和 PermissionCore 关闭时，使用 `permission-core/plugins/vext`。插件仍消费宿主持有的 MonSQLize 3.1 实例；它不是数据库适配器，也不实现登录。

## 目标与前置条件

- 使用 Node.js `>=20.19.0`。这是 Vext 0.3.26 的运行时要求；permission-core 根入口和 `match` 入口仍支持 Node.js `>=18.0.0`。
- 安装精确 peer：`monsqlize@3.1.0` 和 `vextjs@0.3.26`。
- 在 `permission-core` 前加载宿主数据库插件和认证插件。
- 确保认证过程写入可信 `req.auth`；请求头或请求体本身不是权限主体。
- 从文档规定的 `permission-core/plugins/vext` 包子路径导入该集成。

## 注册插件

最显式、最容易审计的方式是直接传入宿主实例：

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

`permissionPlugin(options)` **同步返回 Vext 插件描述符**；真正的 `core.init()`、middleware 安装和 `app.permission` 扩展发生在 Vext setup 阶段。上例各参数：

| 参数 | 值来源 | 作用 |
|---|---|---|
| `monsqlize` | 宿主已连接实例 | 插件借用数据库；不能再同时传 `resolveMonSQLize`。 |
| `authPlugin` | Vext 插件注册名 | 建立启动顺序，默认 `authentication`。 |
| `core` | PermissionCore 配置（不含 monsqlize） | collectionPrefix/tokenSecret/cache/close 等传给内部 core。 |

精确 options、失败码和原始返回类型见[`permissionPlugin()`](/zh/api/vext-plugin#vext-permission-plugin)。

也可以提供 `resolveMonSQLize(app)`，或让插件发现 `app.monsqlize` 自有数据属性。自动发现会有意校验同一个 MonSQLize 3.1 构造器身份。依赖其他 Vext 插件完成发现时设置 `databasePlugin`，以便 Vext 排序；`authPlugin` 默认是 `authentication`。

三种数据库来源互斥。插件调用 `core.init()`、扩展 `app.permission`、安装请求中间件与 hooks，并将 `core.close()` 注册到 Vext。权限插件关闭后，宿主数据库仍保持连接。

## 提供可信认证

默认解析器严格接受以下两种已认证形态之一：

```ts
req.auth = {
  isAuthenticated: true,
  permissionSubject: { userId: 'u-1', scope: { tenantId: 'acme' } },
};

// 或：
req.auth = {
  isAuthenticated: true,
  userId: 'u-1',
  scope: { tenantId: 'acme' },
  claims: { merchantId: 'm-7' },
};
```

认证插件使用其他结构时，配置 `resolveSubject(auth, req)`。如果认证对象同时存在规范 user/scope 字段，resolver 必须返回同一个 owner，否则请求以 `SCOPE_CONFLICT` 失败。只有受保护路由或应用代码真正请求时，`req.auth.permission` 才会惰性创建。

`resolveSubject` 每次接收认证插件写入的只读 `auth` 与当前 `req`，返回 `PermissionSubject | Promise<PermissionSubject>`。它不返回登录态，也不应查询/信任客户端自报 tenant。插件会规范化并冻结结果后再创建请求期 facade。

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

`app.get/post` 是 Vext 路由注册，不是 permission-core API。permission-core 读取其中的 `permission` 元数据：`false/省略` 公开，`true` 使用当前 endpoint 的 invoke 资源，单对象定义一个要求，`mode='all'|'any'` 组合 `1..32` 项。路由 guard 在 handler 前执行，拒绝时 handler 不会被调用。

处理器需要复用同一 subject 做额外业务判定时，可显式取得请求上下文：

```ts
import { requirePermissionContext } from 'permission-core/plugins/vext';

async function exportHandler(req) {
  const permission = await requirePermissionContext(req);
  await permission.assert('read', 'db:orders');
  return startExport(permission.subject.userId);
}
```

`requirePermissionContext(req)` 返回 `{ subject, can, assert }` 的请求专用 API；若上下文已创建会返回同一对象。只想做无副作用类型检查时使用 `hasPermissionContext(req)`，它只返回 boolean，不触发惰性解析。两者精确区别见[Vext 插件 API](/zh/api/vext-plugin#vext-has-permission-context)。

省略或 `false` 表示公开路由。`true` 表示对匹配路由模板执行 `invoke`，例如 `GET:/orders/:id`。单个对象声明一个要求；`any`/`all` 接受 `1..32` 个要求。插件在 `routes:ready` 构建路由 manifest，将 API binding 候选传给 `validateRouteManifest`，并在监听前提交初始契约。

## 失败与关闭边界

- 缺少认证返回 `401`；权限拒绝返回 `403`。
- MonSQLize 缺失/不兼容、扩展冲突和初始路由元数据无效都会阻止启动。
- 初始 manifest 提交后的任何路由重载都会返回 `VEXT_ROUTE_RESTART_REQUIRED`（`503`），直到冷重启；插件不会静默接受变化后的授权契约。
- `req.auth.permission` 归单个请求所有，请求结束后不能复用。
- Vext 关闭时先排空 permission-core，再由数据库插件或宿主关闭 MonSQLize。

运行 [Vext 示例](/zh/examples/vext)，然后在 [Vext 插件 API](/zh/api/vext-plugin)查看全部选项和导出类型。
