# 资源匹配 API

## 用途与前置条件

`permission-core/match` 在不构造 core 的情况下公开内置资源 matcher。配置工具或测试需要与内置 HTTP/API/数据/UI pattern 完全相同的语义时使用。它不判断 action、角色、deny 优先级、条件或自定义资源方案。

## 我想做什么

| 目标 | 入口 |
|---|---|
| 在测试中验证资源模式 | [`matchResource(pattern, resource)`](#match-resource-method) |
| 复现 `can/assert` 的字符串匹配结果 | 传入同一 action/resource 资源字符串 |
| 理解 `*`、`:param` 和字段通配 | [示例](#example) |
| 判断是否需要自定义资源方案 | [资源方案 API](/zh/api/resource-schemes) |

## 签名

```ts
import { matchResource } from 'permission-core/match';

matchResource(pattern: string, resource: string): boolean
```

第一个参数是规则侧 pattern，第二个参数是具体请求 resource。颠倒顺序会改变语义。

## 方法详解

<span id="match-resource-method"></span>
### `matchResource(pattern, resource)`

<!-- docs:method name=matchResource locale=zh -->

<!-- docs:params owner=matchResource locale=zh -->

| 参数 | 必填 | 示例 | 语义 |
|---|:---:|---|---|
| `pattern` | 是 | `GET:/orders/:id` | 来自规则侧，可以包含该内置 scheme 允许的 wildcard/parameter。 |
| `resource` | 是 | `GET:/orders/42` | 本次待匹配的具体资源；不能含 wildcard。 |

- **用途**：配置校验器、管理 UI 预览或测试需要复用内置 matcher 时；真实授权判定不应绕过 core。
- **参数**：按上表依次传规则侧 `pattern` 与本次具体 `resource`；顺序不可颠倒，具体资源不能含 wildcard。
- **何时不用**：真实授权决策应调用 `can/assert`；自定义 resource scheme 应由已配置的 core 判定。
- **状态影响**：同步纯函数，无 I/O、缓存、角色或审计副作用。
- **原始返回**：`boolean`；无效格式、不同 scheme 或不匹配都返回 false，不抛领域错误。

## 响应与副作用

该函数同步、纯粹，并且只返回 `true` 或 `false`。无效输入或 scheme 不同返回 `false`；它不抛错，也不修改调用者状态。

```json
{
  "http": true,
  "api": true,
  "field": true,
  "invalid": false
}
```

这是四次 `matchResource()` boolean 返回值组成的教程汇总，不是单次调用的对象响应。

HTTP/API `*` 是尾部 segment wildcard，要求至少剩余一个 segment。`:param` 消费一个 segment。数据字段 pattern 支持精确路径、`profile.*` 和字段级 `*`。规则侧全局 `*` 匹配任意有效内置具体资源。

## 失败与限制

在 `PermissionCore` 配置的自定义方案有意不通过该独立函数使用；应通过 core 判断。query string/fragment、错误模板、具体资源 wildcard、未知 scheme 及超出内置语法限制的资源都返回 `false`。`matchResource` 不实现 action 侧 `write` 语义。

<span id="example"></span>

## 示例

```ts
const result = {
  exact: matchResource('GET:/orders/:id', 'GET:/orders/42'),
  subtree: matchResource('api:POST:/api/orders/*', 'api:POST:/api/orders/export'),
  field: matchResource('db:orders:field:profile.*', 'db:orders:field:profile.name'),
  tooShort: matchResource('GET:/orders/*', 'GET:/orders'),
};
```

```json
{ "exact": true, "subtree": true, "field": true, "tooShort": false }
```

同样，这个对象由示例代码自行组装；每个属性值才是对应同步调用的原始 boolean。

## 相关内容

参见[资源与规则](/zh/guide/resources-and-rules)、[资源方案 API](/zh/api/resource-schemes)和[检查权限](/zh/guide/check-permission)。
