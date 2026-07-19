---
pageType: home

hero:
  badge: v2.0.0 预览版
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

## 推荐路径

1. 先完成[快速开始](/zh/guide/quick-start)，得到第一条允许和阻止结果。
2. 按业务需要接入[数据权限](/zh/guide/data-permissions)或[菜单管理](/zh/guide/menu-management)。
3. 上生产前阅读[权限生命周期](/zh/guide/permission-lifecycle)。

站点中的五个[可运行示例](/zh/examples/basic)全部使用这里记录的公开包接口。
