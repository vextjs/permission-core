# permission-core

permission-core 是一个面向 Node.js 生态的细粒度权限核心库，围绕统一的 `action + resource` 模型提供接口权限、数据权限、字段过滤、角色规则管理与缓存失效控制。

## 当前状态

- 当前最完整的公开说明位于 `website/docs/**`。
- 当前仓库已经落地核心运行时、三种存储适配器、RBAC 管理器和行级权限 API。
- 当前角色管理入口已支持直接检查某个角色的 own rules、effective rules 和继承链。
- 当前实现已通过 `typecheck`、完整单测、构建产物生成，以及语句 / 分支 / 函数 / 行覆盖率 `100%` 验证。
- 根目录 `examples/` 提供可直接运行的 `HTTP-only`、`DB-only` 和完整接入流示例。
- 根 README 只保留接入路径、权限模型和阅读入口，不重复展开整站正文。
- 如果你准备真正接入，优先从文档站首页、快速开始和常见问题进入。

## 三条官方接入路径

### HTTP-only

适合只做接口权限的场景，例如菜单、按钮、路由和接口守卫。

- 资源模型只需要 `<METHOD>:<path>`，其中 `path` 指规范化后的命中路由路径；框架能暴露模板路由时优先使用模板
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

- 接口资源：`<METHOD>:<path>`（`path` 指规范化后的命中路由路径，模板路由优先）
- 数据资源：`db:<collection>[:<field>]`
- 接口动作：`invoke`
- 数据动作：`read`、`create`、`update`、`delete`、`write`、`*`
- `write` 语义：规则侧表示授予 `create + update`，请求侧表示必须同时满足 `create && update`

## 官方标准栈

- 缓存底座：`cache-hub`
- 生产默认存储：`MonSQLizeStorageAdapter`
- 回退实现：`FileAdapter`、`MemoryAdapter`
- 核心原则：保留 `StorageAdapter` 抽象，不把权限模型改写成 MongoDB 专属库

## 角色检查能力

如果你要做角色详情页、调试面板或联调接口，除了 `roles.getRules(roleId)` 之外，还可以直接调用：

- `roles.getRoleChain(roleId)`：读取当前角色到父角色的继承链
- `roles.getEffectiveRules(roleId)`：读取当前角色连同父链展开后的有效规则
- `roles.inspect(roleId)`：一次返回 `role`、`ownRules`、`effectiveRules`、`roleChain`

## 文档入口

- 站点首页：`website/docs/index.md`
- 快速开始：`website/docs/guide/quick-start.md`
- 生产部署：`website/docs/guide/production-deployment.md`
- 兼容性矩阵：`website/docs/guide/compatibility-matrix.md`
- 资源路径模型：`website/docs/guide/resource-paths.md`
- API 参考：`website/docs/api/permission-core.md`
- 示例：`website/docs/examples/basic.md`
- 可运行示例：`examples/README.md`

推荐阅读顺序：

1. `website/docs/guide/quick-start.md`
2. `website/docs/guide/faq.md`
3. `website/docs/guide/resource-paths.md`
4. `website/docs/guide/roles-and-rules.md`
5. `website/docs/guide/check-permission.md`
6. `website/docs/guide/integration-checklist.md`

如果你已经准备开始写接入代码，再继续看 `website/docs/guide/implementation-reading-order.md`。

## 安全与兼容性

- 安全边界与漏洞提交流程：`SECURITY.md`
- 当前运行时与依赖支持范围：`website/docs/guide/compatibility-matrix.md`
- 生产部署与监控建议：`website/docs/guide/production-deployment.md`

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

运行仓库内示例：

```bash
npm run example:all
```

或分别执行：

```bash
npm run example:http
npm run example:db
npm run example:complete
```

## 当前边界

- 当前公开文档已经覆盖接入路径、资源模型、运行时 API、管理 API、缓存语义和典型接入方式。
- 当前治理文档已经补齐安全策略、生产部署与兼容性矩阵，但这些内容仍然是“如何安全使用这个内核”，不是替代你自己的认证、密钥管理和审计平台。
- 如果你准备对照当前源码阅读实现顺序，继续看 `website/docs/guide/implementation-reading-order.md`。
- 如果你想看更细的 API 和示例，继续进入 `website/docs/api/**` 与 `website/docs/examples/**`。