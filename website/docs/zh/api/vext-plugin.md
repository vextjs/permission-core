# Vext 插件 API

## 用途与前置条件

`permission-core/plugins/vext` 是可选的 Vext 0.3.26 集成子路径。宿主必须运行 Node.js `>=20.19.0`、提供宿主持有的 MonSQLize 3.1 实例，并安装在权限判断前写入可信请求状态的认证插件。根入口与 `match` 入口仍保持 Node.js `>=18.0.0` 契约。

## 我想做什么

| 目标 | 入口 |
|---|---|
| 注册 Vext 权限插件 | [`permissionPlugin(options?)`](#vext-permission-plugin) |
| 在 handler 中取得请求权限上下文 | [`requirePermissionContext(req)`](#vext-require-permission-context) |
| 做无副作用类型检查 | [`hasPermissionContext(req)`](#vext-has-permission-context) |
| 从路由 manifest 生成接口绑定输入 | [`toApiBindingInputs(manifest)`](#vext-to-api-binding-inputs) |
| 理解 route `permission` 语法 | [`RouteOptions.permission`](#route-options-permission) |

## 签名

```ts
permissionPlugin(options?: PermissionVextPluginOptions): VextPlugin
hasPermissionContext(req: VextRequest): req is PermissionVextRequest
requirePermissionContext(req: VextRequest): Promise<VextRequestPermissionApi>
toApiBindingInputs(manifest: VextRoutePermissionManifest): readonly ApiBindingCreateInput[]
appExtensions.permission: PermissionCore

interface PermissionVextPluginOptions {
  monsqlize?: MonSQLizeInstance;
  resolveMonSQLize?: (app) => MonSQLizeInstance | Promise<MonSQLizeInstance>;
  databasePlugin?: string;
  authPlugin?: string;
  core?: Omit<PermissionCoreOptions, 'monsqlize'>;
  resolveSubject?: (auth, req) => PermissionSubject | Promise<PermissionSubject>;
  validateRouteManifest?: (event) => void | Promise<void>;
}
```

`monsqlize` 与 `resolveMonSQLize` 互斥；两者都没有时，插件发现 `app.monsqlize`。`authPlugin` 默认为 `authentication`。`RouteOptions.permission` 接受 `false`、`true`、单 requirement 或 `any`/`all` requirement group。

## 参数对象

<!-- docs:params owner=PermissionVextPluginOptions locale=zh -->

### `PermissionVextPluginOptions`

| 字段 | 必填/默认 | 作用与约束 |
|---|---|---|
| `monsqlize` | 三种来源之一 | 直接提供宿主持有的 MonSQLize 3.1 实例；插件只借用，不负责关闭。 |
| `resolveMonSQLize(app)` | 三种来源之一 | 在 setup 时从 Vext app 异步解析实例；不能与 `monsqlize` 同时提供。 |
| 自动发现 `app.monsqlize` | 前两者缺省时 | 只接受宿主扩展上的自有数据属性，并核验 MonSQLize 3.1 构造器身份。 |
| `databasePlugin` | 可选 | 声明提供数据库实例的 Vext 插件名，使 Vext 正确排序；不是数据库适配器名。 |
| `authPlugin` | 默认 `authentication` | 必须先运行并写入可信 `req.auth` 的认证插件名。 |
| `core` | 可选 | 除 `monsqlize` 外的 `PermissionCoreOptions`，例如 collectionPrefix/tokenSecret/cache/close。 |
| `resolveSubject(auth, req)` | 默认严格解析器 | 把认证插件的可信对象转换为 `PermissionSubject`；不得信任请求头/请求体自报身份。 |
| `validateRouteManifest(event)` | 可选 | 启动期观察/校验 route manifest 和 binding candidates；返回前可持久化自己的契约，但插件不会自动导入 bindings。 |

<!-- docs:params owner=VextRoutePermission locale=zh -->

### `RouteOptions.permission`

| 值 | 路由语义 |
|---|---|
| 省略或 `false` | 公开路由，不安装权限要求。 |
| `true` | 要求 `invoke` 当前规范化 method/path 模板，例如 `GET:/orders/:id`。 |
| `{ action, resource? }` | 单个要求；resource 省略时使用当前 endpoint 资源。 |
| `{ mode:'all', requirements }` | `1..32` 项全部通过。 |
| `{ mode:'any', requirements }` | `1..32` 项至少一项通过。 |

`req.auth.permission` 的 `can/assert` 与核心判定语义一致，但 subject 已由当前请求绑定，不能跨请求缓存或复用。

## 导出详解

<span id="vext-permission-plugin"></span>
### `permissionPlugin(options?)`

<!-- docs:method name=permissionPlugin locale=zh -->

- **用途**：创建交给 Vext 注册的权限插件描述符。
- **参数**：上表 options；数据库来源最多一个，认证插件必须先于权限插件可用。
- **状态影响**：Vext setup 时创建/init core、安装请求中间件和路由 hooks、暴露 `app.permission`；Vext close 时只关闭 core。
- **原始返回**：同步返回 `VextPlugin`，不是 `PermissionCore`，也不是启动结果 JSON。
- **常见失败**：数据库/认证缺失、app/auth 扩展冲突、路由权限元数据无效或启动后路由发生变化。

<span id="vext-has-permission-context"></span>
### `hasPermissionContext(req)`

<!-- docs:method name=hasPermissionContext locale=zh -->

- **用途**：以不可伪造的内部 owner 标记判断当前 request 是否已经解析出 permission context，并做 TypeScript 类型收窄。
- **参数**：当前 Vext `req`。
- **状态影响**：只检查，不触发惰性 subject 解析，也不抛认证错误。
- **原始返回**：`boolean`；`true` 时 req 被收窄为 `PermissionVextRequest`。

<span id="vext-require-permission-context"></span>
### `requirePermissionContext(req)`

<!-- docs:method name=requirePermissionContext locale=zh -->

- **用途**：取得当前请求的 permission API；尚未解析时通过中间件保存的可信状态惰性解析一次。
- **参数**：必须经过 permission 插件中间件的当前 Vext request。
- **状态影响**：只创建请求期 facade，不写授权数据库；解析结果仅归该 request。
- **原始返回**：`Promise<VextRequestPermissionApi>`，含 `subject/can/assert`。
- **常见失败**：中间件未安装、认证缺失、subject 冲突或策略错误会转换为 Vext HTTP 错误。

<span id="vext-to-api-binding-inputs"></span>
### `toApiBindingInputs(manifest)`

<!-- docs:method name=toApiBindingInputs locale=zh -->

- **用途**：把受保护 Vext routes 确定性转换为可供管理流程审查的 `ApiBindingCreateInput[]`。
- **参数**：完整 `VextRoutePermissionManifest`；会重新校验 schema、digest、路由数量和字节预算。
- **状态影响**：纯转换，不连接数据库、不调用 `apiBindings.create/replace`。
- **原始返回**：冻结的只读数组；每项 ID 为 `vext:<routeKey>`、purpose 为 `entry`、owners 初始为空。宿主决定是否补 owner 并导入。

<span id="vext-app-extensions"></span>
### `appExtensions.permission`

<!-- docs:method name=appExtensions.permission locale=zh -->

- **用途**：为 Vext TypeScript 扩展声明提供 `app.permission: PermissionCore` 的类型键。
- **参数**：无运行时调用参数。
- **状态影响**：真正的 app 扩展值由插件 setup 安装；直接读取前必须确保插件已启动。
- **原始返回**：这是扩展定义/类型契约，不是函数响应；业务代码通过 `app.permission` 访问 core。

## 响应与副作用

插件 setup 初始化 core、安装 middleware/hooks、暴露 `app.permission`、校验并提交初始 route manifest、守卫匹配路由、映射领域错误，并随 Vext 关闭 core。`requirePermissionContext()` 惰性创建包含 `subject`、`can`、`assert` 的请求专用 API。`toApiBindingInputs()` 将受保护 manifest entry 转为确定性的 `purpose: 'entry'` binding 输入，但不执行写入。

```json
{
  "manifest": { "schemaVersion": 1, "digest": "...", "routes": 12 },
  "apiBindingCandidates": 9,
  "appExtension": "permission"
}
```

## 失败与限制

插件可能返回 `VEXT_MONSQLIZE_REQUIRED`、`VEXT_MONSQLIZE_INCOMPATIBLE`、`VEXT_AUTH_REQUIRED`、`VEXT_APP_EXTENSION_CONFLICT`、`VEXT_AUTH_EXTENSION_CONFLICT`、`VEXT_ROUTE_PERMISSION_INVALID`、`VEXT_ROUTE_RESTART_REQUIRED`。限制包括 `20000` 条路由、`8 MiB` manifest、每路由 `32` 个 requirement、每请求缓存 `32` 个 policy context。初始提交后的路由变化要求冷重启。

## 示例

```ts
import { permissionPlugin } from 'permission-core/plugins/vext';

const plugin = permissionPlugin({
  monsqlize: msq,
  authPlugin: 'authentication',
  validateRouteManifest: ({ manifest, apiBindings }) => {
    routeContracts.store({ digest: manifest.digest, apiBindings });
  },
});
```

```json
{ "pluginName": "permission-core", "dependencies": ["authentication"] }
```

`validateRouteManifest` 是启动校验/观察 hook。持久化或协调 binding candidates 属于宿主管理决策，不是插件自动写入。

## 相关内容

参见[Vext 插件](/zh/guide/vext-plugin)、[认证边界](/zh/guide/authentication-boundary)、[接口绑定 API](/zh/api/api-bindings)和[基础 RBAC 示例](/zh/examples/basic)。
