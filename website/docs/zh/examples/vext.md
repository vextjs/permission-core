# Vext 集成

## 场景

该示例加载原生 Vext 插件、保护路由模板，执行公开/未认证/拒绝/允许请求，证明路由重载要求重启，并验证插件关闭不会关闭宿主数据库。

## 运行

```bash
npm run example:vext
```

规范源码是 `examples/vext/index.mjs` 中 `docs:vext:start` 到 `docs:vext:end` 的内容，以及 `examples/vext/app/src/routes/index.mjs`。

## 源码解读

```js
await permissionPlugin({ monsqlize: database.monsqlize }).setup(app);

app.get('/public', {}, publicHandler);
app.get('/orders/:id', { permission: true }, async (req, res) => {
  res.json({ orderId: req.params.id, userId: req.auth.permission.subject.userId });
});
```

`permission: true` 推导出对 `GET:/orders/:id` 的 `invoke`。测试专用 header middleware 提供可重复 `req.auth`；生产环境使用真实认证插件。

## 预期输出

```json
{
  "example": "vext",
  "ok": true,
  "responses": {
    "public": 200,
    "missingAuthentication": 401,
    "permissionDenied": 403,
    "permissionAllowed": 200,
    "routeReloadRequiresRestart": 503
  },
  "allowedBody": { "orderId": "42", "userId": "u-vext" },
  "lifecycle": {
    "permissionCoreClosedByPlugin": true,
    "hostDatabaseStillConnected": true
  }
}
```

## 生产边界

`createTestApp`、内存数据库和 `x-example-user` 认证都是 fixture。生产环境在正常 Vext 插件图中注册 `permissionPlugin`，先加载认证，传入/发现宿主 MonSQLize 3.1 实例，并在路由变化后执行冷重启。

## 相关内容

参见[Vext 插件](/zh/guide/vext-plugin)、[认证边界](/zh/guide/authentication-boundary)、[Vext 插件 API](/zh/api/vext-plugin)和[故障排查](/zh/guide/troubleshooting)。
