# 介绍

permission-core 不是“数据库插件”，也不是“某个框架专用中间件合集”。更容易理解的说法是：它是一套专门用来做权限判断的通用底层能力。

它通过一套稳定的模型来表达权限：

- 角色与用户绑定
- allow / deny 规则
- `invoke` 接口动作
- `read/create/update/delete/write` 数据动作
- `<METHOD>:<path>`（`path` 指规范化后的命中路由路径，模板路由优先）与 `db:<collection>[:<field>]` 两类资源

## 它到底解决什么问题

如果把权限系统拆开看，接入方通常会同时面对四类问题：

- 规则怎么定义
- 规则怎么绑定到用户
- 运行时怎么判断权限
- 规则结果怎么缓存与失效

permission-core 的职责就是把这四类问题整理成一套统一做法，而不是让每个业务项目各写一套：

- `roles` / `users` 解决配置侧问题
- `can` / `assert` / `getRowScope` / `filterRows` / `filterFields` 解决运行时问题
- `cache-hub` 兼容缓存解决性能和失效问题
- `StorageAdapter` 解决规则与绑定数据放在哪里的问题

## 它和“数据库权限系统”有什么区别

这是最容易误解的地方。permission-core 支持 `db:` 资源，但这不代表它本质上是某个数据库的插件。

更准确的说法是：

- 它用 `db:<collection>[:<field>]` 统一描述数据资源
- 它用可持久化的 `where` 条件描述行级范围
- 它允许把规则持久化到 `monsqlize`
- 但它没有把权限模型绑死在 MongoDB 或某个 ORM 上

也正因为如此，`HTTP-only` 和 `DB-only` 才能共用一套内核，而不是拆成两套系统。

## 为什么文档一直强调三条接入路径

因为真正让接入者困惑的，不是权限模型本身，而是下面两个问题经常被写在一起：

- 我需不需要 `db:` 权限
- 我要不要把规则存到 `monsqlize`

这两件事不是同一层决策，所以 v1 文档明确拆成三条官方接入路径：

- `HTTP-only`
- `DB-only`
- `Full standard stack`

接入路径决定资源和 API，存储实现决定规则与绑定放在哪里。两者彼此独立，不应互相暗示。

## 什么时候适合用它

适合以下几类场景：

- 你想在 Express、Koa、vext 或其他 Node.js 框架里统一做接口权限判断。
- 你想在 Service / DAO 层做数据权限与字段过滤，但不想把业务逻辑绑死在具体数据库权限模型上。
- 你想把“角色、规则、缓存、继承链”这套逻辑沉淀成一个可复用的内核，而不是散落在各业务项目里。

## 不解决什么

v1 明确不覆盖以下能力：

- 嵌套字段权限
- ORM 自动拦截
- 多数据库区分

行级权限已经纳入当前方案，但表达方式不是把条件写进资源字符串，而是通过规则的 `where` 条件 DSL 来描述。

这些边界不是缺陷，而是为了保证首版实现和文档都足够稳定。

## 首次接入先走这条主路径

如果你是第一次接入，先不要在 API 页、示例页和管理后台页之间来回跳。先按这一条主路径读：

1. [快速开始](/zh/guide/quick-start)
2. [常见问题](/zh/guide/faq)
3. [资源路径模型](/zh/guide/resource-paths)
4. [角色与规则](/zh/guide/roles-and-rules)
5. [权限鉴权](/zh/guide/check-permission)
6. [接入检查清单](/zh/guide/integration-checklist)

当你已经准备开始写接入代码，再继续看 [接入阅读顺序](/zh/guide/implementation-reading-order)。

## 主路径之后按场景补读

### 你在做权限模型或后台规则维护

1. [角色与规则](/zh/guide/roles-and-rules)
2. [RoleManager](/zh/api/role-manager)
3. [UserRoleManager](/zh/api/user-roles)
4. [管理后台接入](/zh/guide/site-preview-release)

### 你在做框架接入或 Service 分层

1. [框架接入](/zh/guide/framework-integration)
2. [Express 接入](/zh/examples/express)
3. [vext 接入](/zh/examples/vext)
4. [PermissionCore](/zh/api/permission-core)

### 你在做数据权限落地

1. [行级权限](/zh/guide/row-level)
2. [字段过滤](/zh/guide/field-filter)
3. [字段权限示例](/zh/examples/field-permission)
4. [PermissionCore](/zh/api/permission-core)