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

## 定义字段与生命周期

<!-- docs:params owner=ResourceSchemeDefinition locale=zh -->

| 字段 | 必填/约束 | 由谁调用 | 返回怎样使用 |
|---|---|---|---|
| `scheme` | 小写 URI scheme，最长 32；不能占用内置名 | core 构造/资源解析 | 选择 `scheme:` 前缀对应 matcher。 |
| `version` | 非空，最长 64 | schema contract | matcher 行为变化必须同步升级，进入 contract digest。 |
| `probes` | `1..16` 个 `{ pattern, resource, expected }` | `init()` 各执行两次 | 验证确定性和预期匹配，不是生产规则。 |
| `validate(resource)` | 同步、确定、不得抛错 | 对具体资源及 probe resource | true 才允许具体资源进入判定。 |
| `match(pattern, resource)` | 同步、确定、不得抛错 | 规则匹配和 probes | 返回该 pattern 是否覆盖具体 resource。 |

<span id="resource-schemes-configure"></span>
### `new PermissionCore({ resourceSchemes })`

<!-- docs:method name=PermissionCore.resourceSchemes locale=zh -->

- **用途**：在 core 构造期注册应用自定义资源语法。
- **参数**：定义数组最多 32 项；core 会快照配置，之后修改原对象无效。
- **状态影响**：构造本身只创建实例；`init()` 才运行 probes 并比对持久化 schema contract。
- **原始返回**：同步返回 `PermissionCore`，不是 scheme 注册结果。

<span id="resource-schemes-validate"></span>
### `validate(resource)` 与 `match(pattern, resource)`

<!-- docs:method name=ResourceSchemeDefinition.callbacks locale=zh -->

- **用途**：`validate` 定义具体资源语法，`match` 定义规则 pattern 覆盖关系。
- **参数**：都只接收字符串；match 的第一个参数永远是规则 pattern。
- **状态影响**：可信同步纯函数；不得访问时间、网络、随机数或可变外部状态。
- **原始返回**：boolean。抛错、返回非 boolean 或 probes 两次不一致都会使 `init()` 失败。

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

const pc = new PermissionCore({
  monsqlize,
  resourceSchemes: [topicScheme],
});
const health = await pc.init();
```

```json
{ "scheme": "topic", "probeCount": 2, "deterministic": true }
```

该 JSON 是教程根据 `topicScheme` 与成功的 `health` 自行整理的摘要，不是 constructor、callback 或 `init()` 的原始返回。`pc.init()` 原始返回完整 `PermissionCoreHealth`；scheme contract 位于 `health.schema.expectedSchemeContractDigest` 和 `health.namespace.schemeContractDigest`。

初始化成功后，角色规则可以使用 `topic:orders:*` pattern，而 `can/assert` 传入 `topic:orders:created` 具体资源。独立的 `permission-core/match` 只覆盖内置方案，不会读取这里的自定义定义。

## 相关内容

参见[资源与规则](/zh/guide/resources-and-rules)、[资源匹配 API](/zh/api/match-resource)和[核心与上下文](/zh/api/core-and-contexts)。
