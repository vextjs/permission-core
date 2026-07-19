# Vext 插件 API

## 用途与前置条件

`permission-core/plugins/vext` 是可选的 Vext 0.3.26 集成子路径。宿主必须运行 Node.js `>=20.19.0`、提供宿主持有的 MonSQLize 3.1 实例，并安装在权限判断前写入可信请求状态的认证插件。根入口与 `match` 入口仍保持 Node.js `>=18.0.0` 契约。

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
