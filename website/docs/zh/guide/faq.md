# 常见问题

这页专门回答第一次接入 permission-core 时最容易搞混的问题。

如果你已经大致看过 [快速开始](/zh/guide/quick-start)，但还不确定该选哪条路径、该把规则放在哪里，先看这页通常比直接跳到 API 参考更有效。

## 1. 我只是想拦接口，需不需要一开始就上完整标准栈？

通常不需要。

如果你现在只是想做下面这些事：

- 判断某个接口能不能访问
- 控制菜单、按钮、路由显示
- 先把接口权限跑通

那从 `HTTP-only` 开始通常就够了。

只有在你同时需要：

- 接口权限
- 数据权限
- 字段过滤
- 统一缓存和持久化

时，才更适合直接走 `Full standard stack`。

## 2. 我用了 monsqlize，是不是就必须打开 `db:` 权限？

不是。

`monsqlize` 解决的是“规则和绑定数据存在哪里”，`db:` 资源解决的是“你要不要做数据权限”。这两件事是分开的。

所以这两种情况都成立：

- 只做接口权限，但规则存在 `monsqlize`
- 要做数据权限，但先用 `MemoryAdapter` 本地验证

## 3. `getResources()` 和 `can()` / `assert()` 到底谁负责什么？

可以直接这样理解：

- `getResources()`：先给前端一份“可以参考”的资源列表
- `can()`：返回 true / false，让你在代码里分支判断
- `assert()`：没有权限就直接报错，适合中间件和守卫

最重要的一点是：

`getResources()` 不是最终放行依据，真正敏感的操作还是要看 `can()` 或 `assert()`。

## 4. 为什么每次都要先 `await pc.init()`？

因为 permission-core 不是纯静态工具，它背后可能还要准备：

- 存储适配器
- 缓存
- 运行时保护状态

如果没有初始化就直接调用权限判断，你很难分清到底是：

- 用户真的没权限
- 还是系统根本还没准备好

所以文档一直强调：先 `init()`，再使用公共 API。

## 5. 为什么接口权限和数据权限不建议都塞进中间件？

因为中间件很适合拦“这个请求能不能进来”，但不适合处理“这个业务对象的哪些字段该保留”。

更好理解的分工是：

- 中间件：判断当前接口能不能访问
- Service / DAO：判断数据能不能读写、字段要不要过滤

这样后面业务复杂起来时，权限逻辑不会混成一团。

## 6. 为什么 `filterFields()` 不建议默认传 `write`？

因为在当前设计里，请求侧的 `write` 不是“普通写权限”，而是：

- `create && update`

这意味着如果你在字段过滤里直接传 `write`，结果往往会比你想的更严格。

大多数写场景里，更推荐明确写成：

- `create`
- `update`

## 7. 我能不能先用 `MemoryAdapter`，以后再换成 `MonSQLizeStorageAdapter`？

可以，而且这就是推荐路线之一。

很多项目在刚开始接入时，先做的是：

1. 用 `MemoryAdapter` 把最简单的流程跑通
2. 确认资源、角色、规则写法没问题
3. 再切到 `MonSQLizeStorageAdapter`

这样比一开始就把所有基础设施都接上，更容易定位问题。

## 8. 我是不是必须先做一个角色管理后台，才能用 permission-core？

不是。

你完全可以先在代码里：

- 创建角色
- 配置规则
- 绑定用户

先把权限流程跑通。管理后台通常是后面的事情，不是第一步的前置条件。

## 9. 什么时候该从 `HTTP-only` 升级？

出现下面这些需求时，通常就该考虑升级了：

- 你开始在 Service 层判断集合读写权限
- 你要对返回对象做字段过滤
- 你要对写入数据做字段白名单控制
- 你想统一接口权限和数据权限

如果只出现了数据权限需求，可以先看 `DB-only`。

如果接口权限和数据权限都要一起做，再看 `Full standard stack`。

## 10. 这套文档最适合怎么用？

可以把它当成三层入口：

- 用 `guide/` 先选接入路径，明确概念边界
- 用 `api/` 再确认具体方法、返回结果和错误码
- 用 `examples/` 最后对照真实接法

如果你是做运营后台或权限配置后台，还可以继续看 [管理后台接入](/zh/guide/site-preview-release)。

## 11. 目前数据库持久化是不是只支持 MongoDB？

可以直接先这样理解：

- 对当前内置官方路径来说，是，数据库持久化实际就是 `MonSQLizeStorageAdapter -> monsqlize -> MongoDB` 这一条
- 但权限模型本身仍保持抽象；如果你现在要接其他数据库，当前更合适的方式仍然是自己实现 `StorageAdapter`

如果你想看完整边界说明，包括“为什么默认推荐 MonSQLize”以及“为什么这不等于 MongoDB 专属权限模型”，直接看 [存储适配器](/zh/guide/adapters)。

## 12. 菜单、按钮和一个按钮多个接口怎么处理？

使用 `permission-core/menu` 建模 menu/page/button 与 API binding。同一个按钮可以绑定多个接口，通过 `permissionGroup` 与 `permissionMode: "any" | "all"` 明确组合语义；敏感操作建议开启 `strictApiBindings`。前端显隐不能替代后端 `assertSubject()` 或框架 route guard。

生产环境还要单独持久化菜单数据：单进程可用 `FileMenuStorageAdapter`，共享生产环境使用 `MonSQLizeMenuStorageAdapter`。

## 13. 多租户和 Vext 应该从哪里开始？

多租户从 [多租户权限](/zh/guide/multi-tenant) 开始，确保每个 subject 都有显式 `tenantId`，并用跨租户拒绝反例验证。Vext 使用 `createVextPermissionPlugin()`，认证先于权限中间件；tenant 场景启用 `tenantRequired`，并保持 `guardRoutePermissions` 消费 route `auth.permissions`。

维护者在声明接入可用前应执行 `npm run test:docs`、`npm run example:all` 与 `npm run test:package`。

## 还不确定先看哪一页？

你可以直接按下面这个顺序继续：

1. 先看 [快速开始](/zh/guide/quick-start)
2. 再看 [资源路径模型](/zh/guide/resource-paths)
3. 然后看 [角色与规则](/zh/guide/roles-and-rules)
4. 最后按需要进入 [框架接入](/zh/guide/framework-integration) 或 [PermissionCore](/zh/api/permission-core)

## 下一步看什么

- 如果你已经准备开始真正接入：看 [接入检查清单](/zh/guide/integration-checklist)
- 如果你还是不确定应该怎么选路径：回看 [快速开始](/zh/guide/quick-start)
- 如果你准备开始写接口层接入：看 [框架接入](/zh/guide/framework-integration)
