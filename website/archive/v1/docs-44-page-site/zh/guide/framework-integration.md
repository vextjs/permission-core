# 框架接入

permission-core 与框架无关。接入时提取身份、构造资源字符串，再调用 `can()` 或 `assert()`。

## Express 风格 guard

```typescript
async function requirePermission(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ code: 'UNAUTHENTICATED' });
      return;
    }

    await pc.assert(userId, 'invoke', `${req.method}:${req.route.path}`);
    next();
  } catch (error) {
    res.status(403).json({ code: 'PERMISSION_DENIED' });
  }
}
```

## 路由路径选择

优先使用框架匹配到的路由模板。带记录 ID 的真实 URL 会产生不稳定资源。

认证必须先完成。`PermissionSubject` 只能从可信身份与租户来源构造；header、claim 与 route context 冲突时应拒绝请求，不能随意选一个优先。

## Service 层数据检查

数据权限应靠近数据操作：

```typescript
await pc.assert(userId, 'read', 'db:transactions');
const visible = await pc.filterRows(userId, 'read', 'db:transactions', rows, context);
```

先做行级授权，再在序列化前过滤字段。不要加载无界数据集后才在内存中过滤；应先把 `getRowScope()` 转成结构化数据库查询。

## 分层职责

| 层 | 职责 |
|---|---|
| 认证 | 校验 token/session，产生可信身份和租户上下文 |
| 框架 guard | 鉴权规范化接口资源 |
| Service/DAO | 用业务上下文执行集合、行级和字段授权 |
| 前端 | 把菜单/按钮快照当 UX 提示，并处理服务端拒绝 |

## Vext

Vext 应优先使用 `permission-core/adapters/vext` 的 `createVextPermissionPlugin()`。认证先于插件中间件；租户路由启用 `tenantRequired`；由 `guardRoutePermissions` 消费原生 `auth.permissions`。

```javascript
const plugin = createVextPermissionPlugin({
  core: pc,
  init: false,
  tenantRequired: true,
});
await plugin.setup(app);
```

适配器支持 `any/all` 权限组，并在宿主边界返回 `AUTH_REQUIRED` / `AUTH_FORBIDDEN`。

## 生命周期与失败

每个应用初始化一个 runtime，不要每个请求创建实例。关闭时先释放依赖 core 的框架或 menu 资源，再关闭 core；共享数据库连接只能有一个 owner。校验、存储和生命周期异常应交给应用错误处理器，不能一律转换成 `403`。

## 下一步

继续看 [Express 接入](/zh/examples/express) 和 [vext 接入](/zh/examples/vext)。
