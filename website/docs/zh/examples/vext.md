# vext 接入

仓库示例会把内置 adapter 挂到真实的 `vextjs/testing` 宿主中，不再模拟 request，也不要求使用者手写一套权限中间件。

```javascript
import { createTestApp } from 'vextjs/testing';
import { PermissionCore } from 'permission-core';
import { createVextPermissionPlugin } from 'permission-core/adapters/vext';

const pc = new PermissionCore();
const permissionPlugin = createVextPermissionPlugin({
  core: pc,
  init: false,
  tenantRequired: true,
});

const app = await createTestApp({
  rootDir: new URL('../../../examples/vext-adapter/app/', import.meta.url),
});

app.use(async (req, _res, next) => {
  req.auth = {
    isAuthenticated: true,
    userId: String(req.headers['x-user-id']),
    tenantId: String(req.headers['x-tenant-id']),
  };
  await next();
});
app.use(permissionPlugin.middleware);
```

路由选项直接声明 adapter guard 消费的权限：

```javascript
app.get('/api/users', {
  auth: {
    permissions: [{ action: 'invoke', resource: 'api:GET:/api/users' }],
    mode: 'all',
  },
}, async (_req, res) => res.json({ ok: true }));
```

在仓库根目录运行：

```bash
npm run example:vext
```

示例会验证允许请求返回 `200`，拒绝请求返回 `403 AUTH_FORBIDDEN`。认证中间件必须先写入身份和租户，再执行权限中间件；集合、行级和字段权限仍应放在 Service 层。

租户冲突、资源解析、`any/all` 权限组、manifest 边界和生命周期所有权见 [vext 适配器指南](/zh/guide/vext-adapter) 与 [API 参考](/zh/api/vext-adapter)。
