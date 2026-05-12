# 错误处理与响应映射

这页解决的不是“有哪些错误码”，而是更靠近接入落地的问题：

- 这些错误在接口层应该怎么返回
- 哪些错误应该映射成 `400 / 403 / 404 / 409 / 500`
- 响应体结构应该长什么样
- 哪些错误可以直接暴露给调用方，哪些不应该原样透出

如果你已经看过 [错误码](/api/errors)，但还是不确定在中间件、管理 API 或后台接口里该怎么处理，这页更适合继续往下读。

## 一、先区分两层概念

permission-core 抛出的错误，和你最终返回给 HTTP 调用方的响应，不是同一层东西。

更合理的拆法是：

- 权限内核：负责抛出稳定错误码
- 接口层：负责把错误码映射成对外响应

这样做的好处是：

- 内核语义稳定
- HTTP 层可以按框架或业务风格自由映射
- 不会把底层错误对象直接暴露出去

## 二、推荐响应体结构

如果你要把错误返回给前端或外部调用方，推荐至少保持下面这几个字段：

```json
{
  "code": "PERMISSION_DENIED",
  "message": "FORBIDDEN",
  "requestId": "req-20260512-001"
}
```

更复杂的场景里，可以再补一个 `details`：

```json
{
  "code": "INVALID_ARGUMENT",
  "message": "INVALID_ARGUMENT",
  "requestId": "req-20260512-002",
  "details": {
    "field": "resource",
    "reason": "db resource is required"
  }
}
```

推荐约束：

- `code`：稳定错误码，前后端都可以依赖
- `message`：更适合展示或日志搜索的短消息
- `requestId`：便于排查链路
- `details`：只放安全且必要的额外信息

## 三、常见错误到 HTTP 的映射建议

| 错误码 | 推荐 HTTP 状态 | 适合场景 |
|--------|----------------|---------|
| `PERMISSION_DENIED` | `403` | 已登录但无权限 |
| `INVALID_ACTION` | `400` | action 参数非法 |
| `INVALID_RESOURCE_PATH` | `400` | resource 格式非法 |
| `INVALID_ARGUMENT` | `400` | 其他公共参数不合法 |
| `ROLE_ALREADY_EXISTS` | `409` | 创建了已存在的角色 |
| `ROLE_NOT_FOUND` | `404` | 管理 API 引用了不存在角色 |
| `CIRCULAR_INHERITANCE` | `409` | 角色继承关系冲突 |
| `NOT_INITIALIZED` | `500` | 服务端初始化顺序有误 |
| `STORAGE_ERROR` | `500` | 底层持久化或适配器异常 |

这张表的核心不是“唯一正确答案”，而是帮助你保持一个稳定口径：

- 参数错了，用 `400`
- 权限不够，用 `403`
- 资源不存在，用 `404`
- 状态冲突，用 `409`
- 服务端内部状态或存储坏了，用 `500`

## 四、中间件层怎么处理更稳

中间件层最常见的是处理 `assert()` 抛出来的错误。

```typescript
app.use(async (req, res, next) => {
  try {
    const resource = `${req.method}:${req.path}`;
    await pc.assert(req.userId, 'invoke', resource);
    next();
  } catch (error) {
    next(error);
  }
});
```

统一错误处理中，更推荐这样映射：

```typescript
app.use((error, req, res, next) => {
  if (error?.code === 'PERMISSION_DENIED') {
    res.status(403).json({
      code: error.code,
      message: 'FORBIDDEN',
      requestId: req.id,
    });
    return;
  }

  if (error?.code === 'NOT_INITIALIZED') {
    res.status(500).json({
      code: error.code,
      message: 'PERMISSION_RUNTIME_NOT_READY',
      requestId: req.id,
    });
    return;
  }

  next(error);
});
```

## 五、管理 API 层更容易遇到什么错误

如果你在做角色和用户绑定管理接口，更常遇到的不是 `PERMISSION_DENIED`，而是：

- `ROLE_ALREADY_EXISTS`
- `ROLE_NOT_FOUND`
- `CIRCULAR_INHERITANCE`
- `INVALID_ARGUMENT`

例如：

- 创建了一个已存在的角色 → `409`
- 绑定了一个不存在的角色 → `404`
- 把角色 parent 改成形成环 → `409`
- 请求体缺字段或字段格式不合法 → `400`

也就是说，管理 API 层通常更需要“业务错误映射”，而不是只处理权限失败。

## 六、前端怎么理解这些响应

前端或调用方最容易踩的坑，是把不同错误都当成“没权限”。

更推荐这样区分：

- `403`：用户当前无权访问或操作
- `400`：调用方式错了，前端或调用方参数有问题
- `404`：依赖资源不存在
- `409`：当前状态冲突，通常需要先修正数据关系
- `500`：后端内部状态或初始化有问题

这样前端就不会把：

- “系统还没初始化”
- “角色根本不存在”
- “你真的没权限”

这三种完全不同的问题混成一个提示。

## 七、最常见的错误处理误区

- 把 `NOT_INITIALIZED` 当成普通无权限处理
- 把 `STORAGE_ERROR` 的原始堆栈直接返回给调用方
- 所有错误统一返回 `500`
- 把 `getResources()` 当成最终权限判断，而不是菜单/按钮级参考结果

## 八、和 `getResources()` 的关系

这件事单独提醒一次：

`getResources()` 返回的不是错误，也不是最终放行结果，而是“某个 action 下可先参考的资源列表”。

所以如果前端页面是：

- 先用 `getResources()` 做菜单显隐
- 真正提交时再调用接口

那接口层仍然必须保留 `can()` 或 `assert()`，不要把资源列表误当成最终授权结果。

## 下一步看什么

- 想回到错误码本身：看 [错误码](/api/errors)
- 想看接口层真实接法：看 [Express 接入](/examples/express)
- 想看管理能力入口：看 [RoleManager](/api/role-manager) 和 [UserRoleManager](/api/user-roles)
- 想把角色页、用户页和缓存失效串成一条链路：看 [管理后台接入](/guide/site-preview-release)