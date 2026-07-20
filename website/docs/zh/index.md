---
pageType: home

hero:
  badge: v2.0.0
  name: permission-core
  text: 深入数据层的权限控制
  tagline: 用一套租户感知的 RBAC 模型统一控制 Node.js 服务的接口、菜单、数据行与字段。
  image:
    src: /permission-authorization-visual.svg
    alt: 身份经过角色到达应用资源的权限流程
  actions:
    - theme: brand
      text: 10 分钟快速开始
      link: /zh/guide/quick-start
    - theme: alt
      text: 查看完整示例
      link: /zh/examples/basic

features:
  - title: MonSQLize 3.1 持久化
    details: 复用应用已连接的 MonSQLize，持久化角色、规则、修订、审计记录并使用真实事务。
    link: /zh/guide/permission-lifecycle
  - title: 完整后台权限
    details: 管理菜单、页面、按钮、接口绑定和角色授权，再为每个用户投影安全的可见树。
    link: /zh/guide/menu-management
  - title: 行级与字段级协同
    details: 将 Mongo 风格业务 filter 与租户范围、规则条件、字段读写权限自动组合。
    link: /zh/guide/data-permissions
  - title: 真实租户隔离
    details: 每次读写、缓存键和审计都带 scope，使相同用户与角色 ID 在不同租户内保持独立。
    link: /zh/guide/multi-tenant
  - title: 原生 Vext 插件
    details: 消费路由权限和可信认证上下文，接入生命周期钩子，并在路由重载时明确要求重启。
    link: /zh/guide/vext-plugin
  - title: 可观测且默认拒绝
    details: 通过修订检查、预览、审计 ID、健康状态、有界响应和明确恢复路径支撑生产运行。
    link: /zh/guide/production-operations
---

# permission-core

permission-core 位于可信身份与应用资源之间，负责回答：谁可以调用接口、看到菜单、访问后端 API，以及读取或修改哪些数据行和字段。

它明确**不负责**登录、凭据校验、应用数据库连接所有权，也不能用前端菜单显隐替代后端接口鉴权。宿主完成认证并持有已连接的 MonSQLize 3.1 实例；permission-core 负责授权状态与决策。

## 按需接入，不必一次学完

1. **核心 RBAC 是起点。** 创建角色和规则、绑定用户、用 `can()` 做后端判断。
2. **菜单与接口绑定是可选层。** 后台系统需要菜单、页面、按钮和接口联动时再接入。
3. **行级与字段级数据权限是可选层。** 业务需要限制“能看哪些记录、哪些字段”时再接入。
4. **Vext 与生产运维是集成层。** 使用 Vext 或准备部署时，再处理插件、缓存、审计和健康检查。

第一次使用只需要完成第 1 层。后面的能力共享同一套租户、用户、角色与规则，不要求一次全部启用。

## 先认识四个入口

| 入口 | 由什么创建 | 负责什么 | 不负责什么 |
|---|---|---|---|
| `PermissionCore` | `new PermissionCore(options)` + `await init()` | 生命周期、健康、创建 scope/subject 上下文 | 不连接或关闭宿主数据库 |
| `scoped` | `pc.scope({ tenantId, ... })` | 当前 scope 内管理角色、绑定、菜单和接口 | 不代表某个请求用户 |
| `subject` | `pc.forSubject({ userId, scope, claims? })` | 当前用户判定、菜单投影和数据访问 | 不执行登录认证 |
| `AuthorizedCollection` | `subject.data.collection(name, options)` | 强制组合业务 filter、scope、行/字段权限并调用 MonSQLize | 不向调用方返回可选的权限 filter |

所有入口的准确参数和原始响应都可以从[核心与上下文 API](/zh/api/core-and-contexts)开始查找。

## 推荐路径

1. 先完成[快速开始](/zh/guide/quick-start)，得到第一条允许和阻止结果。
2. 按[管理角色与用户授权](/zh/guide/manage-roles-and-users)搭建后台基础流程。
3. 按业务需要接入[数据权限](/zh/guide/data-permissions)或[菜单管理](/zh/guide/menu-management)。
4. 上生产前阅读[权限生命周期](/zh/guide/permission-lifecycle)和[生产运维](/zh/guide/production-operations)。

站点中的五个[可运行示例](/zh/examples/basic)全部使用这里记录的公开包接口。

## 项目入口

- [GitHub 仓库](https://github.com/vextjs/permission-core)：源码、Issue 与当前开发状态。
- [CHANGELOG](https://github.com/vextjs/permission-core/blob/main/CHANGELOG.md)：已记录的版本变化。
- [CONTRIBUTING](https://github.com/vextjs/permission-core/blob/main/CONTRIBUTING.md)：贡献与仓库验证流程。
- [SECURITY](https://github.com/vextjs/permission-core/blob/main/SECURITY.md)：安全边界与私下报告方式。
- [Apache-2.0 LICENSE](https://github.com/vextjs/permission-core/blob/main/LICENSE)：许可证原文。
