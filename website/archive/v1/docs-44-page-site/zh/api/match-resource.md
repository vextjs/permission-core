# matchResource

`matchResource` 判断一个内置资源 pattern 是否覆盖目标 resource。

## 用途与导入

```typescript
import { matchResource } from 'permission-core/match';
```

用于测试、诊断和工具。运行时鉴权通常应使用 `PermissionCore.can()` / `assert()`，才能包含 deny 与角色语义。

## 构造与类型

没有构造器或 options；两个参数都是资源字符串，返回 boolean。

Helper 覆盖内置 HTTP、`api:`、`db:`、namespaced UI resource 与全局 `*`。

## 签名索引

`matchResource(pattern: string, resource: string): boolean`

公共 subpath 导出独立资源 matcher；core 规则判定还会通过内部 rule matcher 匹配 action。

## 行为与默认值

匹配感知 scheme。HTTP method 必须一致，除非 pattern 使用 `*`；`:param` 覆盖一个 path segment；末尾 `*` 覆盖后代。`db:orders:*` 只覆盖 orders 字段，不跨 collection。

全局 `*` 覆盖所有资源，一个 scheme 中的 wildcard 不会跨到另一个 scheme：`db:*` 不匹配 `api:GET:/orders`。

## 错误与限制

对不兼容或非法内置形状返回 false，不执行完整角色校验。内置 wildcard 是 suffix-oriented，`GET:/api/*/items` 不是任意中段 glob。

通过 `pc.resourceSchemes` 注册的自定义 scheme 会在 core 检查中使用 registry；独立 helper 不接收 registry，不能用于绕过自定义校验或最终鉴权。

## 最小示例

```typescript
matchResource('GET:/api/*', 'GET:/api/orders'); // true
matchResource('GET:/api/*', 'POST:/api/orders'); // false
matchResource('db:orders:*', 'db:orders:amount'); // true
```

## 相关页面

参见 [资源路径](/zh/guide/resource-paths)、[PermissionCore](/zh/api/permission-core) 与 [权限鉴权](/zh/guide/check-permission)。
