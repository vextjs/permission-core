# vext 接入

vext 接入的核心思路和 Express 一样，只是把请求上下文换成了 `ctx`。对 permission-core 来说，vext 最适合承接“统一接口权限中间件”这层职责。

## 什么时候适合用这个示例

- 已经使用 vext 做接口开发
- 想把接口权限统一沉淀成插件或中间件
- 后续准备从 `HTTP-only` 平滑扩展到 `Full standard stack`

## 最小中间件接法

```typescript
app.use('auth:permission', async (ctx, next) => {
  if (!ctx.userId) {
    ctx.status = 401;
    ctx.body = { message: 'UNAUTHENTICATED' };
    return;
  }

  const resource = `${ctx.method}:${ctx.path}`;
  await pc.assert(ctx.userId, 'invoke', resource);
  await next();
});
```

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
- 把 `ctx` 里的动态参数、查询串和路径一起拼成资源
- 以为用了 vext 插件就能自动获得数据权限拦截

如果你想看更通用的分层说明，可以回到 [框架接入](/guide/framework-integration)。