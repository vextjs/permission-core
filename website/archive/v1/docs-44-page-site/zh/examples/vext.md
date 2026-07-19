# vext 接入

## 场景

在真实 `vextjs/testing` 宿主中运行内置 adapter，证明 tenant-aware route metadata 允许一个请求并拒绝另一个请求。

## 可运行源码

本页直接使用仓库源码：其中通过 `createTestApp()` 创建宿主，安装 `createVextPermissionPlugin()`，开启 `tenantRequired`，并声明 route `auth.permissions`：

```js file="<root>/../examples/vext-adapter/index.mjs"

```

```bash
npm run example:vext
```

## 预期结果

示例先执行认证，再执行权限中间件；允许路由返回 `200`，拒绝路由返回 `403 AUTH_FORBIDDEN`，最后关闭自己拥有的 plugin/core 生命周期。

## 适用与不适用

适合 Vext 原生 route `auth.permissions`、`any/all` group、request `auth.can/assert` 与 tenant-required route。它不会把集合、行级、字段授权搬进 route middleware，也不替代认证 provider。
