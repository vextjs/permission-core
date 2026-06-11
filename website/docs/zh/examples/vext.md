# vext 接入

vext 接入的核心思路和 Express 一样，但运行时对象是 `req / res / next`，不是 `ctx`。对 permission-core 来说，vext 很适合承接“统一接口权限中间件”这层职责；如果路由带参数，资源构造时优先使用 `req.route` 这样的路由模板字段，而不是实际 URL。

## 什么时候适合用这个示例

- 已经使用 vext 做接口开发
- 想把接口权限统一沉淀成插件或中间件
- 后续准备从 `HTTP-only` 平滑扩展到 `Full standard stack`

## 最小中间件接法

假设你已经在插件里通过 `app.extend('permission', pc)` 暴露了 `PermissionCore` 实例，那么一个最小的 vext 权限中间件可以写成：

```typescript
import { defineMiddleware } from 'vextjs';
import type { PermissionCore } from 'permission-core';

export default defineMiddleware(async (req, _res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    req.app.throw(401, 'UNAUTHENTICATED');
  }

  const routePath = req.route || req.path;
  const resource = `${req.method}:${routePath}`;
  const pc = req.app.permission as PermissionCore;

  await pc.assert(String(userId), 'invoke', resource);
  await next();
});
```

如果你只想保护部分路由，可以把这个中间件放在 `src/middlewares/permission.ts`，然后在路由选项里通过 `middlewares: ['permission']` 引用。

## 参数化路由示例

下面这个例子对应真实的参数化路由：

```typescript
import { defineRoutes } from 'vextjs';
import type { PermissionCore } from 'permission-core';

export default defineRoutes((app) => {
  app.delete(
    '/permission/roles/:id',
    {
      middlewares: ['permission'],
      validate: {
        param: { id: 'string!' },
      },
    },
    async (req, res) => {
      const { id } = req.valid<{ id: string }>('param');
      const pc = app.permission as PermissionCore;

      await pc.roles.delete(id);
      res.json({ deleted: true, id });
    },
  );
});
```

这时：

- 实际请求路径可能是 `DELETE /permission/roles/123`
- `req.route` 命中的模板是 `/permission/roles/:id`
- 应该送进 permission-core 的资源是 `DELETE:/permission/roles/:id`
- 参数值 `123` 继续通过 `req.valid('param')` 或 `req.params.id` 读取

## Service 层继续做数据权限

```typescript
async function getArticleForUser(userId: string, articleId: string) {
  await pc.assert(userId, 'read', 'db:articles');

  const article = await articleRepo.findById(articleId);
  if (!article) {
    return null;
  }

  return pc.filterFields(userId, 'read', 'db:articles', article);
}
```

和 Express 场景一样，这里仍然建议：

- 中间件层只做接口权限
- Service 层再做 `db:` 权限和字段过滤

## 为什么这种拆法更适合 vext

- vext 中间件层很适合统一拦接口
- 数据权限往往依赖具体业务对象，放在中间件层拿不到足够上下文
- 后续如果切到官方标准栈，只需要调整底层适配器和缓存，不需要推翻整体接入结构

## 常见误区

- 让中间件直接承担字段过滤
- 把实际 URL（特别是 `/:id` 这类带实参路径）、查询串和路径参数一起拼成资源
- 明明可以用 `req.route` 拿到模板路径，却仍然只用 `req.path`
- 以为用了 vext 插件就能自动获得数据权限拦截

如果你想看更通用的分层说明，可以回到 [框架接入](/zh/guide/framework-integration)。