# 错误码

permission-core 的错误设计目标是“显式失败”，而不是悄悄返回默认结果。对权限系统来说，静默失败往往比抛错更危险，因为它会把“无权限”和“系统状态不对”混成同一种结果。

## 常见错误码

| 错误码 | 含义 | 常见触发位置 |
|--------|------|-------------|
| `NOT_INITIALIZED` | 未先调用 `init()` | 运行时主入口 |
| `PERMISSION_DENIED` | 鉴权失败 | `assert()` |
| `INVALID_ACTION` | action 非法 | 参数校验 |
| `INVALID_RESOURCE_PATH` | resource 非法 | 参数校验 |
| `INVALID_ARGUMENT` | 参数不满足要求 | 公共 API / 管理 API |
| `ROLE_ALREADY_EXISTS` | 角色 ID 已存在 | `roles.create()` |
| `ROLE_NOT_FOUND` | 引用的角色不存在 | `roles/users` 管理入口 |
| `CIRCULAR_INHERITANCE` | 角色继承形成环 | `roles.create/update` |
| `STORAGE_ERROR` | 存储层异常 | `init()` / 持久化读写 |

## 推荐按层处理

### 中间件层

优先关心：

- `PERMISSION_DENIED`
- `NOT_INITIALIZED`

前者通常映射成 `403`，后者通常是服务端初始化缺陷，不应被当成普通无权限。

### 管理 API 层

优先关心：

- `ROLE_ALREADY_EXISTS`
- `ROLE_NOT_FOUND`
- `CIRCULAR_INHERITANCE`
- `INVALID_ARGUMENT`

这类错误更适合返回明确的业务错误响应，而不是统一吞成 `500`。

### 适配器层

优先关心：

- `STORAGE_ERROR`

它通常意味着底层存储不可用、初始化失败或持久化读写异常。

## 为什么 `NOT_INITIALIZED` 很重要

这类错误必须单独保留，而不是让 `can()` 在未初始化时默认返回 `false`。否则你无法分辨：

- 这是真的没权限
- 还是系统根本还没完成初始化

## 推荐测试覆盖

文档和测试至少应覆盖这些场景：

- 忘记 `await pc.init()`
- 非法 `action`
- 非法 `resource`
- 创建已存在的角色
- 给不存在的角色做绑定或授权
- 角色继承形成环
- 底层适配器初始化或持久化失败

## 一个简单的 HTTP 映射建议

| 错误码 | 常见 HTTP 映射 |
|--------|----------------|
| `PERMISSION_DENIED` | `403` |
| `INVALID_ACTION` / `INVALID_RESOURCE_PATH` / `INVALID_ARGUMENT` | `400` |
| `ROLE_ALREADY_EXISTS` | `409` |
| `ROLE_NOT_FOUND` | `404` 或明确业务错误 |
| `CIRCULAR_INHERITANCE` | `409` |
| `NOT_INITIALIZED` / `STORAGE_ERROR` | `500` |

具体错误处理可以结合 [Express 接入](/zh/examples/express) 一起看。

## 推荐响应体结构

如果你要把错误返回给前端或外部调用方，推荐至少固定：

- `code`
- `message`
- `requestId`

例如：

```json
{
	"code": "PERMISSION_DENIED",
	"message": "FORBIDDEN",
	"requestId": "req-20260512-001"
}
```

## 下一步看什么

- 想看更完整的错误处理和接口响应映射：看 [错误处理与响应映射](/zh/guide/error-response-mapping)
- 想看错误码在真实接口里怎么处理：看 [Express 接入](/zh/examples/express)
- 想回到运行时主入口：看 [PermissionCore](/zh/api/permission-core)
- 想看角色和用户管理接口怎么落进后台：看 [管理后台接入](/zh/guide/site-preview-release)