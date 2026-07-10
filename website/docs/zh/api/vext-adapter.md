# vext Adapter API

从 `permission-core/adapters/vext` 导入。该子路径运行时不 import `vextjs`；Vext 是宿主应用按需安装的 optional peer。

## Plugin

```ts
createVextPermissionPlugin(options?: VextPermissionPluginOptions): VextPlugin
```

| 选项 | 类型 | 默认值 / 行为 |
|---|---|---|
| `core` | `PermissionCore` | 外部 core，plugin 默认不拥有 |
| `createCore` | `() => PermissionCore \| Promise<PermissionCore>` | 未传 core 时使用的 factory |
| `coreOptions` | `PermissionCoreOptions` | 默认内部 core factory 的参数 |
| `menu` | `MenuPermissionManagerLike` | 挂到 `app.permissionMenu` |
| `init` | `boolean` | 默认 `true`，初始化选中的 core |
| `ownsCore` | `boolean` | 只有内部创建 core 时默认 true |
| `ownsMenu` | `boolean` | 默认 false；true 时初始化并关闭 menu |
| `closeOnAppClose` | `boolean` | 默认 true；只为 owned 资源注册 close |
| `tenantRequired` | `boolean` | 默认 false；true 时请求必须显式携带租户 |
| `defaultScope` | `PermissionScope` | 仅在 `tenantRequired` 允许时 fallback |
| `guardRoutePermissions` | `boolean` | 默认 true；handler 前计算 route `auth.permissions` |
| `resolveSubject` | callback | 替换默认请求身份/scope 解析 |
| `routeResource` | callback | 显式自定义 route-resource mapper |

Plugin 会暴露 `permissionCore`、可选 `permissionMenu`，挂载 `req.auth.can/assert`，并按所有权注册生命周期钩子。

## Middleware 与 provider

```ts
createVextPermissionMiddleware(options): VextPermissionMiddleware
createVextPermissionMiddlewareFactory(options): () => VextPermissionMiddleware
createVextPermissionAuthProvider(options): {
  can(req, action, resource?, context?): Promise<boolean>;
  assert(req, action, resource?, context?): Promise<void>;
}
```

认证必须先写入 `req.auth.isAuthenticated`、`userId` 或 `subject`、roles/scopes 和 claims。route guard 按 `mode: "any" | "all"` 计算权限数组；拒绝时通过 Vext `app.throw` 返回 `401 AUTH_REQUIRED` 或 `403 AUTH_FORBIDDEN`。

只有其他 guard 已证明消费同一份 route metadata 时，才可设置 `guardRoutePermissions:false`。

## Subject 与 resource helper

```ts
resolveVextPermissionSubject(options, req, context?): Promise<PermissionSubject>
resolveVextRouteResource(options, req, action, context?): Promise<string | undefined>
```

身份或 scope 的多个非空来源不一致时抛 `INVALID_ARGUMENT`。大小写重复 header 和字符串数组 header 会被比较，不能依靠优先级静默接受。

资源顺序是：调用时显式 resource、自定义 mapper、匹配 route auth metadata、docs extension、method + matched route path 自动生成。同 action 多 resource 会 fail closed。

## Route manifest

```ts
loadVextRouteManifest(filePath): Promise<VextRouteManifestPayload>
normalizeVextRoutes(payload): ApiManifest
```

每个非隐藏 route 生成一条或多条 `ApiBinding`。permission object 会保留 action 和字符串 resource；多 permission 使用确定 ID、`permissionGroup/permissionMode`；函数 resource 无法序列化，会退回 route 自动资源。

`VextRouteManifestPayload.routes[]` 支持 method、path、operationId、docsSummary、tags、hidden，以及 `auth` 或 `options.auth`。源 manifest 缺少 auth 时，不能证明 route 已受保护。

## 宿主结构类型

Adapter 导出 `VextPermissionRequest`、`VextPermissionAuthContext`、`VextPermissionRequirement`、`VextRouteAuthRequirement`、middleware types、adapter options 和 plugin options。这些类型描述 adapter 边界，使 runtime bundle 不依赖 optional peer。

## 错误

| 错误 | 含义 |
|---|---|
| `AUTH_REQUIRED` | route 要求 authenticated request |
| `AUTH_FORBIDDEN` | 权限组求值为 false |
| `INVALID_ARGUMENT` | 身份/租户缺失、来源冲突、route resource 歧义 |
| `PERMISSION_DENIED` | 直接 `req.auth.assert` 或 core assertion 失败 |
| `NOT_INITIALIZED` | 使用 `init:false` 时外部 core 实际未初始化 |

Middleware 顺序、真实宿主、版本差异和恢复流程见 [vext 适配器指南](/zh/guide/vext-adapter)。
