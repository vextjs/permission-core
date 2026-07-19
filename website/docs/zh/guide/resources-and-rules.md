# 资源与规则

一条权限规则包含 `effect`、action 模式、resource 模式和可选的持久化行条件。只有激活的 allow 命中且没有适用 deny 胜出时，请求才被允许。

## 内置资源方案

| 类型 | 具体资源 | 规则模式 | 用途 |
|---|---|---|---|
| HTTP 路由 | `GET:/orders/:id` | `GET:/orders/:id`、`GET:/orders/*`、`*:/orders/*` | 框架无关的匹配路由 |
| API | `api:POST:/api/orders/export` | `api:POST:/api/orders/*` | 菜单或按钮拥有的后端接口 |
| 数据集合 | `db:orders` | `db:orders`、`db:*` | 集合级数据操作 |
| 数据字段 | `db:orders:field:profile.name` | 精确字段、`profile.*` 或 `*` 字段模式 | 字段读写 |
| UI | `ui:page:orders` | `ui:page:*`、`ui:*` | 菜单、页面、按钮和自定义 UI 类别 |
| 全局 | 不能作为具体请求 | `*` | 明确的规则侧全局模式 |

HTTP 与 API 资源使用不带 query 和 fragment 的规范化路由模板。末尾 `*` 消费一个或多个剩余路径段，并不是任意子字符串通配；`:id` 等参数匹配一个路径段。

## Action

内置请求 action 包括 `invoke`、`read`、`create`、`update`、`delete`、`write`、`manage`，也支持应用自定义字符串。规则侧 `*` 匹配所有 action；规则侧 `write` 匹配 `create` 和 `update`，不会自动匹配 read 或 delete。

```ts
await scoped.roles.allow('order-writer', {
  action: 'write',
  resource: 'db:orders',
});
```

`roles.allow(roleId, rule, options?)` 的第一个参数是当前 scope 的角色 ID，第二个参数是规则输入；原始返回为 `MutationResult<PermissionRuleView>`。`action='write'` 保存在规则侧，运行时对具体 create/update action 展开匹配，不会创建两条规则。

这会允许 `db:orders` 上具体的 `create` 与 `update` 检查。高风险规则若需要管理员分别审查，建议使用明确 action。

## Allow、deny 与默认拒绝

```ts
await scoped.roles.allow('order-reader', {
  action: 'read',
  resource: 'db:orders',
});
await scoped.roles.deny('order-reader', {
  action: 'read',
  resource: 'db:orders:field:secret',
});
```

两次调用各自返回独立 mutation envelope。allow 建立 collection read；deny 只拒绝 secret 字段 read。它不会让角色失去其他允许字段，也不会因为有 deny 就自动授予 collection read。

| 规则字段 | 必填 | 值从哪里来 | 作用 |
|---|:---:|---|---|
| `effect` | 由 `allow()`/`deny()` 决定 | 方法选择 | 冲突时适用 deny 优先 |
| `action` | 是 | 业务操作词 | 规则可用具体 action、`write` 或 `*` |
| `resource` | 是 | 稳定资源命名契约 | 规则侧可包含 scheme 允许的 pattern |
| `where` | 否 | 管理员持久化策略 | 行条件 AST；不接受函数或 Mongo filter 对象 |
| `source` | 系统生成 | manual/menu | 读取响应用于解释，调用方不能在 allow/deny 中伪造 |

直接角色与继承角色的规则会合并，任意适用 deny 都优先于命中的 allow。没有 allow 命中时原因是 `no-allow`；这是默认拒绝，不需要保存 deny 规则。

语义相同的规则共享一条规范规则，同时保留有界来源信息。手工授权和菜单生成授权可以贡献相同语义而不丢失来源。

## 条件规则

`where` 保存可序列化的行条件 AST。`all`、`any`、`not` 组合叶子比较，`valueFrom` 读取可信 subject、claims 或显式 context。没有具体数据行或上下文时，条件也可能让通用 `can` 结果变为 unknown。

```ts
await scoped.roles.allow('merchant-reader', {
  action: 'read',
  resource: 'db:orders',
  where: {
    all: [
      { field: 'merchantId', op: 'eq', valueFrom: 'claims.merchantId' },
      { field: 'archived', op: 'eq', value: false },
    ],
  },
});
```

这次 `allow()` 仍返回规则 mutation envelope。`where.all` 是一个持久化字段；每个叶子的 `valueFrom` 在判定/数据访问时解析。缺少 `claims.merchantId` 会让条件 unknown 并收紧授权，不会把 undefined 当通配值。

策略 `where` 为何与调用方 Mongo `filter` 分离，请阅读[数据权限](/zh/guide/data-permissions)。

## 自定义方案

构造 `PermissionCore` 时最多传入 32 个自定义 `ResourceSchemeDefinition`。每项包含唯一 scheme、行为版本、确定性的 `validate`/`match` 回调和 1～16 个正向或负向探针。初始化会执行每个探针两次，并把方案契约纳入持久化 Schema 摘要。

```ts
const pc = new PermissionCore({
  monsqlize: msq,
  resourceSchemes: [{
    scheme: 'topic',
    version: '1',
    probes: [
      { pattern: 'topic:orders:*', resource: 'topic:orders:created', expected: true },
    ],
    validate: (resource) => /^topic:[a-z]+:[a-z]+$/u.test(resource),
    match: (pattern, resource) => {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      return pattern.endsWith('*') ? resource.startsWith(prefix) : pattern === resource;
    },
  }],
});
```

constructor 同步返回尚未初始化的 core。必须随后 `await pc.init()`；init 会两次执行 probes、比对 scheme contract 并返回 `PermissionCoreHealth`。`validate/match` 是同步 boolean callbacks，不是持久化到数据库的代码，也没有各自的 API envelope。

自定义回调是可信配置代码，不是持久化规则函数。修改方案行为却不修改 `version` 会产生 Schema 契约风险；每个实例必须部署相同定义。

不创建 core 的直接匹配见[资源匹配 API](/zh/api/match-resource)，完整规则管理方法见[角色 API](/zh/api/roles)。
