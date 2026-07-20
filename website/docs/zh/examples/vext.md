# Vext 集成

## 场景

该示例加载原生 Vext 插件、保护路由模板，执行公开/未认证/拒绝/允许请求，证明路由重载要求重启，并验证插件关闭不会关闭宿主数据库。

## 运行

```bash
npm run example:vext
```

规范源码是 `examples/vext/index.mjs` 中 `docs:vext:start` 到 `docs:vext:end` 的内容，以及 `examples/vext/app/src/routes/index.mjs`。

## 先看结果

运行成功先看五个状态码：公开路由 `200`、未认证 `401`、无权限 `403`、有权限 `200`、路由变更后 `503`。再确认 `permissionCoreClosedByPlugin` 和 `hostDatabaseStillConnected` 都为 `true`，证明插件关闭边界正确。

## 源码解读

```js
const testApp = await createTestApp({
  rootDir: resolve('examples/vext/app'),
  plugins: false,
  services: false,
  middlewares: false,
  routes: true,
  setupPlugins: async (app) => {
    // Fixture only: production uses a real authentication plugin.
    app.use(async (req, _res, next) => {
      const userId = req.headers['x-example-user'];
      if (userId) {
        Object.defineProperty(req, 'auth', {
          value: { isAuthenticated: true, userId, scope },
          enumerable: true,
        });
      }
      await next();
    });
    await permissionPlugin({
      monsqlize: database.monsqlize,
      core: { collectionPrefix: 'pc_vext_example' },
    }).setup(app);
  },
});
await testApp.app.hooks.emit('server:beforeListen', {
  host: '127.0.0.1', port: 0, adapter: testApp.app.adapter,
});

const scoped = testApp.app.permission.scope(scope);
await scoped.roles.create({ id: 'route-reader', label: 'Route reader' });
await scoped.roles.allow('route-reader', {
  action: 'invoke', resource: 'api:GET:/orders/:id',
});
await scoped.userRoles.assign('u-vext', 'route-reader');

const publicResponse = await testApp.request.get('/public');
const missingAuth = await testApp.request.get('/orders/42');
const denied = await testApp.request.get('/orders/42')
  .set('x-example-user', 'u-denied');
const allowed = await testApp.request.get('/orders/42')
  .set('x-example-user', 'u-vext');

await testApp.app.hooks.emit('routes:ready', { count: 0, routes: [] });
const restartRequired = await testApp.request.get('/public');
await testApp.close();
const hostDatabase = await database.monsqlize.health();
```

受保护路由本身位于 `examples/vext/app/src/routes/index.mjs`：

```js
app.get('/public', {}, publicHandler);
app.get('/orders/:id', { permission: true }, async (req, res) => {
  res.json({ orderId: req.params.id, userId: req.auth.permission.subject.userId });
});
```

`permission: true` 推导出对 `api:GET:/orders/:id` 的 `invoke`。测试专用 header middleware 提供可重复 `req.auth`；生产环境使用真实认证插件。

### 1. 启动 Vext 测试宿主与插件

<!-- docs:operation id=vext-bootstrap calls=createTestApp,permissionPlugin.setup,server:beforeListen outputs=responses.public -->

**目的与目标。** `createTestApp` 启动 fixture host；`permissionPlugin.setup`（即 `permissionPlugin(...)` 返回的 `.setup`）把 permission-core 安装进 Vext；`server:beforeListen` 在接受请求前完成 startup probe。

**状态、参数与结果。** 插件接收宿主已连接的 MonSQLize instance 和 collection prefix，随后暴露 `app.permission`。Public route 保持未保护；它之后返回 200，证明 bootstrap 后 host 与 route graph 可用。

**失败与下一步。** MonSQLize 缺失/不兼容、PermissionCore 初始化失败或 route metadata 无效时，readiness 不应通过。应修正 host configuration 并重启，不能让受保护 route 在插件只初始化一半时对外服务。

**API 参考。** 参见[Vext 插件 API](/zh/api/vext-plugin)，了解 plugin option、setup hook、解析后的 host state 与 startup error。

`createTestApp()` 是 Vext 测试 fixture，返回 app/request/close 控制面；`permissionPlugin(options)` 先返回插件描述符，`.setup(app)` 才初始化 PermissionCore。`server:beforeListen` hook resolve `void`，用于证明启动检查已完成，不是 HTTP 响应。

### 2. 准备路由权限策略

<!-- docs:operation id=vext-policy calls=scope,roles.create,roles.allow,userRoles.assign outputs=responses.permissionDenied,responses.permissionAllowed -->

**目的与目标。** `scope` 选择 Vext host 的 tenant context；`roles.create` 创建 `route-reader`，`roles.allow` 允许对 normalized template `api:GET:/orders/:id` 执行 `invoke`，`userRoles.assign` 把角色追加给 `u-vext`。

**状态、参数与结果。** Permission resource 匹配由 `permission: true` 推导的 template，而不是具体 `/orders/42` URL。正是该持久化状态让 `u-vext` 得到 200，而另一个已认证用户得到 403。

**失败与下一步。** action/resource template 不同、scope 错误或 assignment 缺失都会导致默认拒绝。应对比 route manifest、已存规则与 subject scope，再修正后端策略，不能弱化 route。

**API 参考。** 参见[角色 API](/zh/api/roles)、[用户角色 API](/zh/api/user-roles)和[Vext 插件 API](/zh/api/vext-plugin)。

`app.permission.scope(scope)` 与普通 `pc.scope()` 相同；create/allow/assign 各自返回 mutation envelope。示例省略保存这些返回，只用后续真实 HTTP 结果验证授权生效。

### 3. 覆盖公开、认证与权限结果

<!-- docs:operation id=vext-requests calls=request.get outputs=responses,allowedBody -->

**目的与目标。** 四次 `request.get` 分别访问 public route、没有认证的 protected route、使用无权限身份的同一路由，以及使用 `u-vext` 的同一路由。

**状态、参数与结果。** Fixture header middleware 只为提供了测试用户的请求创建 `req.auth`。插件把缺少认证的 401 与已认证但被拒绝的 403 区分开；允许的 handler 读取可信 permission subject 并生成 `allowedBody`。

**失败与下一步。** 401 表示 authentication 没有提供可信 identity；403 表示 authorization 拒绝具体 route。应分别诊断两层，不能把两者都改成通用 success 或 redirect。

**API 参考。** 参见[Vext 插件](/zh/guide/vext-plugin)了解请求 lifecycle，并参见[Vext 插件 API](/zh/api/vext-plugin)了解 request context helper 与 error mapping。

`testApp.request.get(path)` 返回测试 HTTP response；`.set()` 只在 fixture 中模拟认证插件输入。四个响应分别读取 `status`，允许响应还从 `allowed.body.data` 读取 handler 结果。

### 4. 拒绝热路由重载

<!-- docs:operation id=vext-reload calls=routes:ready,request.get outputs=responses.routeReloadRequiresRestart -->

**目的与目标。** 启动后发出 `routes:ready` 模拟 route graph 变化，再用 `request.get` 验证 permission-core 不会继续使用 stale manifest 服务。

**状态、参数与结果。** 插件把 route graph 标记为 restart-required，并让后续请求返回 503；`routeReloadRequiresRestart` 记录该 operational fail-closed 响应。

**失败与下一步。** 不能忽略 503 或继续使用旧 route permission。必须冷重启进程，让 startup 重新构建并验证完整 route manifest。

**API 参考。** 参见[Vext 插件 API](/zh/api/vext-plugin)和[故障排查](/zh/guide/troubleshooting)，了解 `VEXT_ROUTE_RESTART_REQUIRED` 处理方式。

`hooks.emit('routes:ready', ...)` resolve 后把插件置为 restart-required；它不返回业务状态。随后 `request.get('/public')` 的原始 HTTP response status 为 503，证明整个 app fail closed。

### 5. 只关闭插件拥有的状态

<!-- docs:operation id=vext-close calls=testApp.close,monsqlize.health outputs=lifecycle -->

**目的与目标。** `testApp.close` 让插件关闭它创建的 PermissionCore instance；随后调用 `monsqlize.health`，证明宿主拥有的 database 仍保持连接。

**状态、参数与结果。** Ownership 是非对称的：plugin shutdown 会 drain permission work，而宿主仍负责 shared database。两个 lifecycle 布尔值分别报告契约两侧。

**失败与下一步。** Shutdown 失败时，应停止接受请求，完成 PermissionCore drain/close，再只在 host lifecycle boundary 关闭 MonSQLize。不能让 plugin 静默 dispose shared connection。

**API 参考。** 参见[Vext 插件 API](/zh/api/vext-plugin)了解 teardown ownership，并参见[核心与上下文 API](/zh/api/core-and-contexts)了解 `PermissionCore.close()`。

`testApp.close()` resolve `void` 并触发插件 teardown；`monsqlize.health()` 返回宿主数据库 health object。`permissionCoreClosedByPlugin` 是已完成 close 的教程布尔量，`hostDatabaseStillConnected` 则从 health 字段计算。

## 预期输出

以下 JSON 是 `printExample()` 将五个 HTTP response、允许 body 和两个生命周期事实组合后的**示例汇总输出**，不是 Vext 插件或某个 request 方法的原始响应。

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

<!-- docs:output group=responses producer=vext-requests -->

**`responses` 来源。** 每个 status 都来自一个真实 fixture `request.get` response。Reload status 由独立 route-change probe 生成，因此五个值覆盖 public、authentication、authorization、success 和 restart-required 边界。

<!-- docs:output group=allowedBody producer=vext-requests -->

**`allowedBody` 来源。** 只有允许的 `request.get` 会进入 protected-route handler 并输出该 body；其中 route parameter 与 subject user ID 证明 business code 使用可信 request context 前已经完成授权。

<!-- docs:output group=lifecycle producer=vext-close -->

**`lifecycle` 来源。** `testApp.close` 证明 PermissionCore 一侧；关闭后的 `monsqlize.health` response 证明 host database 仍为 up 且 connected。

## 生产边界

`createTestApp`、内存数据库和 `x-example-user` 认证都是 fixture。生产环境在正常 Vext 插件图中注册 `permissionPlugin`，先加载认证，传入/发现宿主 MonSQLize 3.1 实例，并在路由变化后执行冷重启。

## 相关内容

参见[Vext 插件](/zh/guide/vext-plugin)、[认证边界](/zh/guide/authentication-boundary)、[Vext 插件 API](/zh/api/vext-plugin)和[故障排查](/zh/guide/troubleshooting)。
