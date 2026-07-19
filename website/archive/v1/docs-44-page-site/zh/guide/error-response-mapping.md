# 错误处理与响应映射

把 permission-core 错误映射为稳定的应用响应，不要把原始运行时错误直接暴露给公共 API。

## 常见映射

| 条件 | 建议状态 | 建议 code |
|------|----------|-----------|
| 没有登录身份 | `401` | `UNAUTHENTICATED` |
| 权限拒绝 | `403` | `PERMISSION_DENIED` |
| 权限输入非法 | `400` | `INVALID_PERMISSION_INPUT` |
| Runtime 未初始化 | `500` | `PERMISSION_RUNTIME_NOT_READY` |
| 角色不存在 | `404` | `ROLE_NOT_FOUND` |
| 角色重复 | `409` | `ROLE_ALREADY_EXISTS` |
| 循环继承/revision 冲突 | `409` | 稳定领域冲突 code |
| 存储或补偿失败 | `503` 或 `500` | `PERMISSION_STORAGE_ERROR` |

认证与授权必须分开：登录缺失或无效是 `401`，已认证主体鉴权失败是 `403`。

## 示例

```typescript
try {
  await pc.assert(userId, 'invoke', 'POST:/api/refunds');
} catch (error) {
  if (error instanceof PermissionCoreError && error.code === 'PERMISSION_DENIED') {
    return res.status(403).json({
      code: error.code,
      message: 'You do not have permission to perform this action.',
      requestId: req.id,
    });
  }
  throw error;
}
```

不要捕获所有错误再返回 `403`，否则非法资源、存储不可用和生命周期缺陷都会被伪装成用户拒绝。

## 稳定响应结构

```json
{
  "code": "PERMISSION_DENIED",
  "message": "You do not have permission to perform this action.",
  "requestId": "req-123"
}
```

客户端依赖稳定 `code`，`message` 在应用边界本地化。管理 API 可以包含字段级校验详情，公共接口 guard 不应暴露规则内容或存储原因。

## 日志

记录稳定 user ID、action、resource、request ID 和服务名。可用时增加 tenant/app scope、匹配路由模板、判定层与稳定错误码。`STORAGE_ERROR` 的原始异常和补偿异常只在内部日志中使用同一 request/change ID 关联。

敏感值是否记录遵循项目策略；默认响应仍不应返回连接字符串、token、完整支付凭据或原始私有 payload。

Vext 适配器把未认证受保护路由映射为 `401 AUTH_REQUIRED`，把权限组拒绝映射为 `403 AUTH_FORBIDDEN`。即使直接 `req.auth.assert` 背后的 core error 是 `PERMISSION_DENIED`，宿主响应契约也应保持稳定。

前端可以用菜单/按钮状态解释不可用操作，但仍必须处理 `401/403/409`，因为渲染后服务端状态可能变化。
