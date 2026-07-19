# vext 适配器

`permission-core/adapters/vext` 把 permission-core 接入真实 Vext plugin 和 route guard，同时保持 `vextjs` 为 optional peer。认证必须先运行并写入 `req.auth`，本 adapter 负责授权。

## 第一次成功请求

```js
// src/plugins/permission.mjs
import { PermissionCore } from "permission-core";
import { createVextPermissionPlugin } from "permission-core/adapters/vext";

export default createVextPermissionPlugin({
  createCore: () => new PermissionCore({ storage }),
  tenantRequired: true,
});
```

接口资源直接声明在 route 上。认证 middleware/plugin 必须先于 permission-core 注册。

```js
import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
  app.get("/api/users", {
    auth: {
      permissions: [{ action: "invoke", resource: "api:GET:/api/users" }],
    },
  }, async (_req, res) => {
    res.json({ users: [] });
  });
});
```

给认证用户所在租户的角色授予 `invoke api:GET:/api/users`。有权限时进入 handler；无权限时在 handler 前返回 `403 AUTH_FORBIDDEN`。

仓库内提供真实 `vextjs/testing#createTestApp` 流程：

```bash
npm run example:vext
```

确定输出包含 `allowedStatus: 200`、`deniedStatus: 403`、`deniedCode: "AUTH_FORBIDDEN"`。

## Subject 解析与租户安全

解析规则如下：

1. 自定义 `resolveSubject(req, auth, context)`。
2. 身份来自 `req.auth.userId` 或 `req.auth.subject`。
3. scope 来自 claims 和 header：`tenantId`、`appId`、`moduleId`、`namespace`。
4. 只有请求未提供字段且 `tenantRequired` 允许 fallback 时，才补 `defaultScope`。

claims、header、大小写重复 header 和多值 header 必须一致。冲突会抛 `INVALID_ARGUMENT`，不会静默选择某一个租户。设置 `tenantRequired: true` 后，即使配置了 `defaultScope`，缺少显式租户也会失败。

## 接口资源解析顺序

实际顺序是：

1. Vext 或业务代码显式传给 `req.auth.can/assert` 的 resource。
2. 显式配置的 `routeResource(req, action, context)`。
3. route 中匹配 action 的 `auth.permissions` metadata。
4. 兼容字段 `docs.extensions["x-permission-resource"]`。
5. 自动生成 `api:<METHOD>:<matched-route-path>`。

同一个 action 对应多个 resource 属于授权歧义，会 fail closed。多权限 route 应使用显式 permission object，并声明 Vext `mode: "any" | "all"`。

## Plugin 生命周期

| 配置 | 行为 |
|---|---|
| 不传 `core` / `createCore` | plugin 创建、初始化并关闭自己的 core |
| 传入外部 `core` | 默认初始化；除非 `ownsCore:true`，否则不负责关闭 |
| `menu` + `ownsMenu:true` | 初始化 menu，并在 owned core 前关闭 menu |
| `closeOnAppClose:false` | 不注册关闭钩子，应用必须自行释放 owned 资源 |

共享同一 MonSQLize 实例的多个 storage adapter 不能同时设置 `ownsConnection:true`。

## Route manifest 导入

```ts
import { loadVextRouteManifest, normalizeVextRoutes } from "permission-core/adapters/vext";

const payload = await loadVextRouteManifest(".vext/manifest/routes.json");
await menu.importApiManifest({ tenantId: "tenant-a" }, normalizeVextRoutes(payload));
```

payload 中存在 auth 字段时，`normalizeVextRoutes()` 会保留 `auth.permissions`、`required` 和 `mode:any/all`。registry 的 `vextjs@0.3.26` route manifest writer 目前不会输出 auth metadata，因此不能只靠该文件推断受保护接口。应使用能保留 route options 的 collector、从 route source 补齐 payload，或直接导入显式 API manifest。

## 版本与错误说明

- adapter 在 `vextjs@0.3.26` runtime 上会直接消费 route options；但该 registry 版本的 TypeScript `RouteOptions` 尚未声明 `auth`。可使用 JavaScript、本地类型增强，或升级到包含原生 auth types 的 Vext 版本。
- `401 AUTH_REQUIRED`：认证没有产生 authenticated context。
- `403 AUTH_FORBIDDEN`：subject 解析成功，但权限组未通过。
- tenant/resource 冲突导致的 `INVALID_ARGUMENT` 属于身份源或配置错误，应修正来源，不能换一个租户重试。
- `guardRoutePermissions:false` 会关闭 adapter guard，只有已经证明存在等价 Vext native guard 时才能使用。

精确 adapter options 和 payload 类型从 `permission-core/adapters/vext` 导出；scope API 见 [Scoped Permissions](/zh/api/scoped-permissions)。
