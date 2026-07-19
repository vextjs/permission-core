# 资源匹配 API

## 用途与前置条件

`permission-core/match` 在不构造 core 的情况下公开内置资源 matcher。配置工具或测试需要与内置 HTTP/API/数据/UI pattern 完全相同的语义时使用。它不判断 action、角色、deny 优先级、条件或自定义资源方案。

## 签名

```ts
import { matchResource } from 'permission-core/match';

matchResource(pattern: string, resource: string): boolean
```

第一个参数是规则侧 pattern，第二个参数是具体请求 resource。颠倒顺序会改变语义。

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

HTTP/API `*` 是尾部 segment wildcard，要求至少剩余一个 segment。`:param` 消费一个 segment。数据字段 pattern 支持精确路径、`profile.*` 和字段级 `*`。规则侧全局 `*` 匹配任意有效内置具体资源。

## 失败与限制

在 `PermissionCore` 配置的自定义方案有意不通过该独立函数使用；应通过 core 判断。query string/fragment、错误模板、具体资源 wildcard、未知 scheme 及超出内置语法限制的资源都返回 `false`。`matchResource` 不实现 action 侧 `write` 语义。

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

## 相关内容

参见[资源与规则](/zh/guide/resources-and-rules)、[资源方案 API](/zh/api/resource-schemes)和[检查权限](/zh/guide/check-permission)。
