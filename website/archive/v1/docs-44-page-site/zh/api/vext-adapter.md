# vext Adapter API

内置 Vext 适配器把 core 检查挂到 request auth，消费原生 route permission metadata，并可管理 plugin 生命周期。

## 用途与导入

```typescript
import { createVextPermissionPlugin } from 'permission-core/adapters/vext';
```

普通 Vext 应用使用 plugin；自定义宿主组合可使用较低层的 middleware/provider factory。

## 构造与类型

`VextPermissionAdapterOptions` 必须传 `core`，可选 `menu`、`defaultScope`、`tenantRequired`、`resolveSubject`、`routeResource`、`guardRoutePermissions`。

`VextPermissionPluginOptions` 可传 `core`、`createCore` 或 `coreOptions`，以及 `init`、`closeOnAppClose`、`ownsCore`、`ownsMenu`。Route requirement 支持 permissions 与 `mode: "any" | "all"`。

## 签名索引

| 接口面 | 签名 |
|---|---|
| Plugin | `createVextPermissionPlugin(options?)` |
| Middleware | `createVextPermissionMiddleware(options)`；factory 变体 |
| Provider | `createVextPermissionAuthProvider(options)` |
| Subject/resource | `resolveVextPermissionSubject`；`resolveVextRouteResource`；`getHeader` |
| Manifest | `loadVextRouteManifest`；`normalizeVextRoutes` |

## 行为与默认值

Plugin 的 `init` 与 `closeOnAppClose` 默认开启。Plugin 拥有自己创建的 core，但默认不拥有外部注入的 menu；`guardRoutePermissions` 默认开启，route group mode 默认 `any`。

资源解析顺序是 custom resolver、route permission resource、`x-permission-resource`、规范化 method/path。认证应先于 adapter；`tenantRequired:true` 要求租户身份。

## 错误与限制

受保护路由缺认证映射为 `401 AUTH_REQUIRED`，权限组拒绝映射为 `403 AUTH_FORBIDDEN`。资源缺失/歧义或租户 subject 非法时使用 core `INVALID_ARGUMENT`。

Adapter 消费 Vext route metadata，但不签发 token。另一 guard 已负责同一 metadata 时，应明确关闭一方并测试边界。连接所有权仍由 core/storage 配置决定。

## 最小示例

```typescript
const plugin = createVextPermissionPlugin({
  core: pc,
  init: false,
  tenantRequired: true,
});

await plugin.setup(app);
```

## 相关页面

参见 [vext 适配器指南](/zh/guide/vext-adapter)、[vext 示例](/zh/examples/vext) 与 [错误码](/zh/api/errors)。
