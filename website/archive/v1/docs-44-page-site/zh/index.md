---
pageType: home

hero:
  badge: v1.1.0 预览版 · 站点根目录为 v1.0.10 稳定版
  name: permission-core
  text: 细粒度权限控制内核
  tagline: 用统一规则控制接口权限、数据权限和字段过滤的 Node.js 权限库
  image:
    src: /permission-authorization-visual.svg
    alt: 支付权限控制流程图
  actions:
    - theme: brand
      text: 跑通 First Success
      link: /zh/guide/quick-start
    - theme: alt
      text: 稳定版 v1.0.10
      link: https://vextjs.github.io/permission-core/
    - theme: alt
      text: 基础示例
      link: /zh/examples/basic

features:
  - title: 三条官方接入路径
    details: 支持 HTTP-only、DB-only、Full standard stack 三条路径，先选模式再接入，不必一开始就上完整栈。
    link: /zh/guide/quick-start
  - title: 统一权限模型
    details: 用一套规则同时处理接口资源和 db 资源，不必把接口权限和数据权限拆成两套系统。
    link: /zh/guide/resource-paths
  - title: 支付场景控制
    details: 用显式规则控制交易接口、账本行、退款字段与管理后台保存，并正确处理缓存失效。
    link: /zh/guide/production-deployment
  - title: 标准生产栈
    details: 使用 cache-hub 做权限缓存，使用 MonSQLizeStorageAdapter 持久化角色与绑定数据。
    link: /zh/guide/adapters
  - title: 角色继承与规则合并
    details: 支持父子角色继承，子角色自动继承父角色全部规则；多角色同时持有时自动合并，deny 始终优先于 allow。
    link: /zh/api/role-manager
  - title: 细粒度行级与字段权限
    details: 除接口级 can/assert 外，提供 canRow/assertRow 行级鉴权与 filterFields 字段过滤，支持 where 条件 DSL。
    link: /zh/guide/row-level
  - title: 管理后台菜单与接口绑定
    details: 统一建模菜单、页面、按钮和一个按钮下的多个后端接口，并提供有效授权树、manifest revision 与审计。
    link: /zh/guide/menu-permissions
  - title: 真实多租户隔离
    details: 通过 scoped storage、独立缓存 key 和精确 scope 校验，让同一个 userId 在不同 tenant 与 app 下完全隔离。
    link: /zh/guide/multi-tenant
  - title: 内置 vext Adapter
    details: 直接挂载 req.auth.can/assert，消费原生路由权限，执行 any/all 权限组并按所有权管理生命周期。
    link: /zh/guide/vext-adapter
---

# permission-core

permission-core 是一个面向 Node.js 生态的通用细粒度权限核心库。它不绑定具体框架，也不替业务自动代理数据库操作，而是通过统一的 `action + resource` 模型提供：

- 接口权限判断
- 数据集合级权限判断
- 行级范围
- 字段级读写过滤
- 角色继承与规则合并
- 权限缓存与失效控制

页面头部会标明当前构建通道与版本。稳定文档与 npm `latest` 一致；预览文档来自当前 `main`，只发布到独立的 `/next/` 路径，并不代表 npm 已发布。晋升稳定版前仍须通过 `typecheck`、完整测试集、包构建、可运行示例和既定覆盖率门禁。

## 从一条路径开始

- 只做接口权限：看 [快速开始](/zh/guide/quick-start) 中的 `HTTP-only` 路径
- 只做数据权限：看 [快速开始](/zh/guide/quick-start) 中的 `DB-only` 路径
- 同时做接口、数据与管理 API：看 [快速开始](/zh/guide/quick-start) 中的 `Full standard stack` 路径
- 做菜单、按钮和一个按钮多个接口：看 [菜单权限](/zh/guide/menu-permissions)
- 做租户隔离角色与规则：看 [多租户权限](/zh/guide/multi-tenant)
- 接入真实 vext 宿主：看 [vext 适配器](/zh/guide/vext-adapter)

不确定哪条路径合适时，先看 [常见问题](/zh/guide/faq)，不要先接入完整生产栈。

## 先跑通 First Success

在仓库根目录执行：

```bash
npm run docs:first-success
```

这个命令会打包当前仓库、安装到隔离消费项目，并通过安装后的包证明一条允许和一条拒绝结果。

跑通之后，再回看 [快速开始](/zh/guide/quick-start)、[资源路径模型](/zh/guide/resource-paths) 和 [PermissionCore API](/zh/api/permission-core)，理解会更直接。

## 站点结构

- `guide/`：接入路径、概念、生产部署与常见问题。
- `api/`：公开运行时、管理器、适配器、缓存与错误码。
- `examples/`：Express、vext、管理后台、行级、字段与 MonSQLize 场景。

需要可运行文件时，直接查看仓库根目录 `examples/`。
