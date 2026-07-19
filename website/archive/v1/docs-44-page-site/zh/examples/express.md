# Express 接入

## 场景

用共享 runtime 鉴权一个 Express 请求：认证先得到 `userId`，route guard 检查命中的路由模板，数据权限仍由 Service 负责。

## 可运行源码

仓库 HTTP-only 源码验证同一 core route 契约：

```bash
npm run example:http
```

Express 使用下面的 guard 形状：

```typescript
async function requirePermission(req, res, next) {
  try {
    if (!req.user?.id) return res.status(401).json({ code: 'UNAUTHENTICATED' });
    await pc.assert(req.user.id, 'invoke', `${req.method}:${req.route.path}`);
    next();
  } catch (error) {
    if (error instanceof PermissionCoreError && error.code === 'PERMISSION_DENIED') {
      return res.status(403).json({ code: error.code });
    }
    next(error);
  }
}
```

## 预期结果

`npm run example:http` 输出 `[http-only] ok`，允许 `GET:/api/orders`，拒绝 `DELETE:/api/orders`，并关闭 runtime。Express 中身份缺失返回 `401`，预期拒绝返回 `403`，storage/lifecycle error 进入应用错误处理器。

## 适用与不适用

适合 Express 风格 route guard 和稳定模板资源。它不替代认证，也不替代 Service/DAO 的集合、行级和字段检查。每个应用调用一次 `pc.init()`，优雅停机调用 `pc.close()`，不要每请求创建。
