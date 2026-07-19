# 资源方案 API

## 用途与前置条件

资源方案定义规则 pattern 如何匹配具体 resource。内置方案覆盖 HTTP 路由、`api:`、`db:`、`ui:` 和仅规则侧可用的全局 `*`。只有这些语法不能表示稳定应用资源域时，才添加自定义方案。

## 签名

```ts
interface ResourceSchemeDefinition {
  scheme: string;
  version: string;
  probes: readonly {
    pattern: string;
    resource: string;
    expected: boolean;
  }[];
  validate(resource: string): boolean;
  match(pattern: string, resource: string): boolean;
}

new PermissionCore({
  monsqlize,
  resourceSchemes?: ResourceSchemeDefinition[],
});
```

`scheme` 遵循小写 URI scheme 语法，不能使用 `api`、`db`、`http`、`ui`。`version` 是行为版本，不是包版本。回调是可信同步配置代码，必须具有确定性。

## 响应与副作用

构造时快照最多 `32` 个定义。`init()` 将每个 `1..16` probe 执行两次，要求具体资源通过 validate，并验证预期 match 结果。方案名称/版本/probe 会进入持久化 schema contract digest，并由 health 返回。

```json
{
  "schema": {
    "expectedSchemeContractDigest": "...",
    "expectedSchemaContractKey": "..."
  }
}
```

规则 pattern 交给 `match`；具体 resource 先由 `validate` 接受。Pattern 和 resource 必须保持在声明的 scheme 内。

## 失败与限制

无效定义或不确定/抛错 probe 以 `INVALID_CONFIGURATION` 阻止初始化。未知/格式错误资源返回 `INVALID_RESOURCE`。名称最长 `32` 字符，版本最长 `64`，每个 pattern/resource 最多 `1024` UTF-8 bytes。改变回调行为时必须改变 `version`，并向每个实例部署相同定义；否则 schema contract 可能分叉。

## 示例

```ts
const topicScheme = {
  scheme: 'topic',
  version: '1',
  probes: [
    { pattern: 'topic:orders:*', resource: 'topic:orders:created', expected: true },
    { pattern: 'topic:orders:*', resource: 'topic:users:created', expected: false },
  ],
  validate: (resource: string) => /^topic:[a-z]+:[a-z]+$/u.test(resource),
  match: (pattern: string, resource: string) => {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return pattern.endsWith('*') ? resource.startsWith(prefix) : pattern === resource;
  },
};
```

```json
{ "scheme": "topic", "probeCount": 2, "deterministic": true }
```

## 相关内容

参见[资源与规则](/zh/guide/resources-and-rules)、[资源匹配 API](/zh/api/match-resource)和[核心与上下文](/zh/api/core-and-contexts)。
