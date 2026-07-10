# Express 接入

这个示例对应典型的 `HTTP-only` 或 `Full standard stack` 场景。核心原则只有一句话：

- 中间件负责接口权限
- Service / DAO 层负责数据权限和字段过滤

不要把所有权限逻辑都塞进 Express 中间件，否则一旦进入数据读写和字段过滤阶段，边界会很快失控。

## 入口结构

最常见的接入顺序是：

1. 先完成登录态解析，拿到 `req.userId`
2. 优先用命中的模板路由构造接口资源，拿不到时再退回 `req.path`
3. 在中间件里统一调用 `assert()`
4. 进入 Service / DAO 层后再做 `db:` 权限判断和字段过滤

## 运行时初始化

```typescript
import express from 'express';
import { MemoryAdapter, PermissionCore } from 'permission-core';

const app = express();
const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();
```

如果后续切到官方标准栈，只需要把 `storage` 和 `cache` 替换为 `MonSQLizeStorageAdapter + cache-hub`，不需要重写中间件职责划分。

## 接口权限中间件

```typescript
function requireInvokePermission() {
  return async (req, res, next) => {
    try {
      if (!req.userId) {
        res.status(401).json({ message: 'UNAUTHENTICATED' });
        return;
      }

      const routePath = typeof req.route?.path === 'string'
        ? `${req.baseUrl ?? ''}${req.route.path}`
        : req.path;
      const resource = `${req.method}:${routePath}`;
      await pc.assert(req.userId, 'invoke', resource);
      next();
    } catch (error) {
      next(error);
    }
  };
}

app.get('/api/orders/:id', requireInvokePermission(), async (req, res, next) => {
  try {
    const result = await orderService.getOrderForUser(req.userId, req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});
```

如果当前接口是 `DELETE /api/orders/123`，而命中的模板是 `/api/orders/:id`，那这里构造出来的资源应当是 `DELETE:/api/orders/:id`，而不是把实际 URL `DELETE:/api/orders/123` 直接写进权限系统。

这个中间件只做一件事：判断当前用户是否能调用这个接口。它不负责数据读写权限，也不负责字段过滤。

## Service / DAO 层继续做数据权限

```typescript
async function getOrderForUser(userId: string, orderId: string) {
  await pc.assert(userId, 'read', 'db:orders');

  const order = await orderRepository.findById(orderId);
  if (!order) {
    return null;
  }

  return pc.filterFields(userId, 'read', 'db:orders', order);
}
```

这样拆开的好处是：

- 接口权限和数据权限不会互相污染
- 后续切换到 `DB-only` 或 `Full standard stack` 时，Service 层可以直接复用
- 字段过滤不会被错误地塞进通用中间件里

## 错误处理建议

建议把权限异常统一映射成明确的 HTTP 响应，而不是直接把底层异常透给调用方。

```typescript
app.use((error, req, res, next) => {
  if (error?.code === 'PERMISSION_DENIED') {
    res.status(403).json({ message: 'FORBIDDEN', code: error.code });
    return;
  }

  next(error);
});
```

## 什么时候该用这个示例

- 你已经有 Express 应用，只想接接口权限
- 你准备逐步从 `HTTP-only` 升级到 `Full standard stack`
- 你想先把接口权限固定下来，再把数据权限下沉到 Service 层

## 常见误区

- 直接在中间件里判断 `db:` 资源
- 用 `req.originalUrl` 拼资源，导致查询串和资源模型混在一起
- 让前端 `getResources()` 结果替代服务端最终鉴权

如果你使用的是 vext，可继续看 [vext 接入](/zh/examples/vext)。

## 下一步看什么

- 想先确认真实接入前有没有漏项：看 [接入检查清单](/zh/guide/integration-checklist)
- 想回到更通用的分层说明：看 [框架接入](/zh/guide/framework-integration)
- 想继续看 vext 版本的接法：看 [vext 接入](/zh/examples/vext)

应用启动时只创建一个共享 runtime 并执行 `await pc.init()`；优雅退出时执行 `await pc.close()`。不要每个请求创建/关闭一次 core，也不要把 storage 或 `NOT_INITIALIZED` 统一吞成 403。
