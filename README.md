# permission-core

permission-core 是一个面向 Node.js 生态的细粒度权限核心库，围绕统一的 `action + resource` 模型提供接口权限、数据权限、字段过滤、角色规则管理与缓存失效控制。

## 当前状态

- 当前最完整的公开说明位于 `website/docs/**`。
- 根 README 只保留接入路径、权限模型和阅读入口，不重复展开整站正文。
- 如果你准备真正接入，优先从文档站首页、快速开始和常见问题进入。

## 三条官方接入路径

### HTTP-only

适合只做接口权限的场景，例如菜单、按钮、路由和接口守卫。

- 资源模型只需要 `<METHOD>:<path>`
- 常用能力是 `assert`、`can`、`getResources`
- 不要求配置 `db:` 资源

### DB-only

适合只做集合级、行级和字段级数据权限的场景，例如在 Service / DAO 层主动校验权限、收口记录范围和过滤字段。

- 资源模型使用 `db:<collection>[:<field>]`
- 常用能力是 `can`、`assert`、`getRowScope`、`filterRows`、`filterFields`
- 不要求先接 HTTP 中间件

### Full standard stack

适合同步做接口权限、数据权限、行级范围和后台管理能力，并采用官方默认生产路径的场景。

- 官方标准栈为 `cache-hub + monsqlize`
- 同时启用接口资源与 `db:` 资源
- 更适合和管理后台、独立文档站一起推进

## 统一权限模型

- 接口资源：`<METHOD>:<path>`
- 数据资源：`db:<collection>[:<field>]`
- 接口动作：`invoke`
- 数据动作：`read`、`create`、`update`、`delete`、`write`、`*`
- `write` 语义：规则侧表示授予 `create + update`，请求侧表示必须同时满足 `create && update`

## 官方标准栈

- 缓存底座：`cache-hub`
- 生产默认存储：`MonSQLizeStorageAdapter`
- 回退实现：`FileAdapter`、`MemoryAdapter`
- 核心原则：保留 `StorageAdapter` 抽象，不把权限模型改写成 MongoDB 专属库

## 文档入口

- 站点首页：`website/docs/index.md`
- 快速开始：`website/docs/guide/quick-start.md`
- 资源路径模型：`website/docs/guide/resource-paths.md`
- API 参考：`website/docs/api/permission-core.md`
- 示例：`website/docs/examples/basic.md`

推荐阅读顺序：

1. `website/docs/guide/quick-start.md`
2. `website/docs/guide/faq.md`
3. `website/docs/guide/resource-paths.md`
4. `website/docs/guide/roles-and-rules.md`
5. `website/docs/guide/check-permission.md`
6. `website/docs/guide/integration-checklist.md`

如果你已经准备开始写接入代码，再继续看 `website/docs/guide/implementation-reading-order.md`。

## 本地查看文档站

```bash
cd website
npm install
npm run dev
```

构建静态站点：

```bash
cd website
npm run build
```

## 当前边界

- 当前公开文档已经覆盖接入路径、资源模型、运行时 API、管理 API、缓存语义和典型接入方式。
- 如果你准备进入实现阶段，继续看 `website/docs/guide/implementation-reading-order.md`。
- 如果你想看更细的 API 和示例，继续进入 `website/docs/api/**` 与 `website/docs/examples/**`。