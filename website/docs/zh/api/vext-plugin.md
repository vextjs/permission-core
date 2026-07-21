# Vext 插件 API

## 用途与前置条件

`permission-core/plugins/vext` 是 Vext 0.3.26 的可选插件入口。它负责在 Vext 生命周期中初始化 PermissionCore、安装路由守卫、把领域错误映射为 HTTP 响应，并为受保护路由提供请求期权限 API 与响应字段投影。

前置条件：

- Node.js `>=20.19.0`。
- 宿主提供已连接的 MonSQLize 3.1 实例。
- 认证插件先运行，并把可信用户身份写入 `req.auth`。
- 菜单响应字段投影需要先通过 `menus.responses.set()` 或 `menus.config.save()` 保存对应 `api:` 资源和字段配置。

## 签名

```ts
permissionPlugin(options?: PermissionVextPluginOptions): VextPlugin
hasPermissionContext(req: VextRequest): req is PermissionVextRequest
requirePermissionContext(req: VextRequest): Promise<VextRequestPermissionApi>
req.auth.permission.filterResponse(apiResource: ApiResource, payload: unknown, context?: PolicyContext): Promise<SubjectRuntimeResult<unknown>>
appExtensions.permission: PermissionCore

interface PermissionVextPluginOptions {
  monsqlize?: MonSQLizeInstance;
  resolveMonSQLize?: (app) => MonSQLizeInstance | Promise<MonSQLizeInstance>;
  databasePlugin?: string;
  authPlugin?: string;
  core?: Omit<PermissionCoreOptions, 'monsqlize'>;
  resolveSubject?: (auth, req) => PermissionSubject | Promise<PermissionSubject>;
}
```

`permission: true` 的路由会检查 `invoke + api:METHOD:/path`，例如 `api:GET:/orders/:id`。若路由启用缓存且没有显式关闭，权限插件会 fail closed，避免把用户级响应投影缓存成共享响应。

## 参数对象

<!-- docs:params owner=PermissionVextPluginOptions locale=zh -->

### `PermissionVextPluginOptions`

| 字段 | 必填/默认 | 作用与约束 |
|---|---|---|
| `monsqlize` | 三种来源之一 | 直接传入宿主持有的 MonSQLize 3.1 实例；插件只借用，不关闭数据库。 |
| `resolveMonSQLize(app)` | 三种来源之一 | setup 时从 Vext app 异步解析实例；不能与 `monsqlize` 同时提供。 |
| 自动发现 `app.monsqlize` | 前两者缺省时 | 只接受宿主扩展上的自有数据属性，并核验 MonSQLize 3.1 兼容性。 |
| `databasePlugin` | 可选 | 声明提供数据库实例的 Vext 插件名，用于 Vext 插件排序。 |
| `authPlugin` | 默认 `authentication` | 认证插件名；必须先写入可信 `req.auth`。 |
| `core` | 可选 | 除 `monsqlize` 外的 `PermissionCoreOptions`，例如 `collectionPrefix/cache/tokenSecret`。 |
| `resolveSubject(auth, req)` | 默认严格解析器 | 把认证对象转换为 `PermissionSubject`；不得信任客户端自报身份。 |

### `RouteOptions.permission`

| 值 | 路由语义 |
|---|---|
| 省略或 `false` | 公开路由，不执行权限守卫。 |
| `true` | 自动要求 `invoke + api:METHOD:/path`。 |
| `{ action, resource? }` | 单个要求；`resource` 省略时使用当前路由的 `api:` 资源。 |
| `{ mode: 'all', requirements }` | `1..32` 个要求全部通过。 |
| `{ mode: 'any', requirements }` | `1..32` 个要求至少一个通过。 |

## 方法详解

<span id="vext-permission-plugin"></span>
### `permissionPlugin(options?)`

<!-- docs:method name=permissionPlugin locale=zh -->

- **用途**：创建交给 Vext 注册的权限插件描述符。
- **参数**：`options` 见上表；数据库来源最多一个，认证插件必须先运行。
- **状态影响**：Vext setup 时创建并初始化 core，安装请求中间件、路由 hooks 和错误映射，暴露 `app.permission`；Vext close 时关闭 PermissionCore。
- **原始返回**：同步返回 `VextPlugin`，不是启动结果，也不是 `PermissionCore` 实例。

<span id="vext-has-permission-context"></span>
### `hasPermissionContext(req)`

<!-- docs:method name=hasPermissionContext locale=zh -->

- **用途**：判断当前 request 是否已有 permission context，并做 TypeScript 类型收窄。
- **参数**：当前 Vext `req`。
- **状态影响**：只检查内部 owner 标记，不触发惰性 subject 解析。
- **原始返回**：`boolean`；`true` 时 req 可视为 `PermissionVextRequest`。

<span id="vext-require-permission-context"></span>
### `requirePermissionContext(req)`

<!-- docs:method name=requirePermissionContext locale=zh -->

- **用途**：取得当前请求的权限 API。
- **参数**：必须是经过 permission 插件中间件的当前 Vext request。
- **状态影响**：惰性解析并冻结 subject，只属于当前请求；不写授权数据库。
- **原始返回**：`Promise<VextRequestPermissionApi>`，包含 `subject`、`can`、`assert` 和 `filterResponse`。

<span id="vext-filter-response"></span>
### `req.auth.permission.filterResponse(apiResource, payload, context?)`

<!-- docs:method name=req.auth.permission.filterResponse locale=zh -->

- **用途**：在 Vext handler 中按当前用户响应字段授权裁剪响应。
- **参数**：`apiResource` 是 `api:METHOD:/path`；`payload` 是准备返回的数据；`context` 可选。
- **状态影响**：只读；会先检查当前 subject 是否能 `invoke` 该 API。
- **原始返回**：`SubjectRuntimeResult<unknown>`，裁剪后的数据在 `data`。

<span id="vext-app-extensions"></span>
### `appExtensions.permission`

<!-- docs:method name=appExtensions.permission locale=zh -->

- **用途**：为 Vext 类型系统声明 `app.permission: PermissionCore`。
- **参数**：无运行时参数。
- **状态影响**：真正的 app 扩展由插件 setup 安装。
- **原始返回**：这是类型扩展定义；业务代码通过 `app.permission` 访问 core。

## 响应与副作用

插件 setup 会初始化 PermissionCore、安装路由守卫、绑定 `req.auth.permission`、暴露 `app.permission` 并注册关闭钩子。受 `permission: true` 保护的路由会在 handler 前检查 `invoke + api:METHOD:/path`；如果 handler 使用 `res.json()`，插件会按响应字段配置自动投影，并写入 `Cache-Control: private, no-store`。

```json
{
  "route": "GET /orders/:id",
  "resource": "api:GET:/orders/:id",
  "guard": "invoke",
  "responseProjection": true
}
```

## 失败与限制

常见错误包括 `VEXT_MONSQLIZE_REQUIRED`、`VEXT_MONSQLIZE_INCOMPATIBLE`、`VEXT_AUTH_REQUIRED`、`VEXT_APP_EXTENSION_CONFLICT`、`VEXT_AUTH_EXTENSION_CONFLICT`、`VEXT_ROUTE_PERMISSION_INVALID` 和 `VEXT_ROUTE_RESTART_REQUIRED`。路由权限要求最多 `32` 项。启动后路由变化需要冷重启。启用缓存的受保护路由会拒绝启动，除非显式关闭路由缓存。

## 示例

```ts
import { permissionPlugin, requirePermissionContext } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: msq,
  authPlugin: 'authentication',
  core: { collectionPrefix: 'permission_core' },
});

app.get('/orders/:id', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const payload = await loadOrder(req.params.id);
  const projected = await permission.filterResponse('api:GET:/orders/:id', payload);
  return res.json(projected.data);
});
```

```json
{ "pluginName": "permission-core", "resource": "api:GET:/orders/:id" }
```

## 相关内容

参见[Vext 插件](/zh/guide/vext-plugin)、[认证边界](/zh/guide/authentication-boundary)、[配置接口与响应字段 API](/zh/api/api-bindings)和可运行的 [Vext 示例](/zh/examples/vext)。
