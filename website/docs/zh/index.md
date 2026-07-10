---
pageType: home

hero:
  badge: v1.1.0 未发布预览
  name: permission-core
  text: 细粒度权限控制内核
  tagline: 用统一规则控制接口权限、数据权限和字段过滤的 Node.js 权限库
  image:
    src: /permission-authorization-visual.svg
    alt: 支付权限控制流程图
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/quick-start
    - theme: alt
      text: 常见问题
      link: /zh/guide/faq
    - theme: alt
      text: 基础示例
      link: /zh/examples/basic

features:
  - title: 三条官方接入路径
    details: 支持 HTTP-only、DB-only、Full standard stack 三条路径，先选模式再接入，不必一开始就上完整栈。
  - title: 统一权限模型
    details: 用一套规则同时处理接口资源和 db 资源，不必把接口权限和数据权限拆成两套系统。
  - title: 官方标准栈
    details: 默认生产方案为 cache-hub + monsqlize，同时保留 FileAdapter 与 MemoryAdapter 作为轻量备用方案。
  - title: 可运行示例与管理 API
    details: 仓库根目录提供可直接执行的 example，站点同时覆盖 roles、users、错误响应、缓存失效和管理后台接入路径。
  - title: 角色继承与规则合并
    details: 支持父子角色继承，子角色自动继承父角色全部规则；多角色同时持有时自动合并，deny 始终优先于 allow。
  - title: 细粒度行级与字段权限
    details: 除接口级 can/assert 外，提供 canRow/assertRow 行级鉴权与 filterFields 字段过滤，支持 where 条件 DSL。
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
- 字段级读写过滤
- 角色继承与规则合并
- 权限缓存与失效控制

当前仓库正在准备尚未发布的 `1.1.0` 版本。本地门禁覆盖 `typecheck`、完整测试集、构建和可运行示例，并强制语句 92%、分支 89.5%、函数 95%、行 92% 的最低覆盖率。

如果你是第一次接触这个项目，建议先从以下路径选择一种开始：

- 只做接口权限：看 [快速开始](/zh/guide/quick-start) 中的 `HTTP-only` 路径
- 只做数据权限：看 [快速开始](/zh/guide/quick-start) 中的 `DB-only` 路径
- 同时做接口和数据权限：看 `Full standard stack` 路径
- 做菜单、按钮和一个按钮多个接口：看 [菜单权限](/zh/guide/menu-permissions)
- 做租户隔离角色与规则：看 [多租户权限](/zh/guide/multi-tenant)
- 接入真实 vext 宿主：看 [vext 适配器](/zh/guide/vext-adapter)

如果你已经看过几页，但还是反复在“我到底该选哪条路径”“为什么这里要先这样写”之间来回切换，建议先看 [常见问题](/zh/guide/faq)。

## 先跑起来，再回来看文档

如果你不想先在多页文档之间切换，可以先在仓库根目录直接跑官方 example：

```bash
npm run example:all
```

这个命令会依次跑通六条可执行路径：

- `HTTP-only`：最小接口权限闭环
- `DB-only`：集合权限、行级范围和字段过滤
- `complete-flow`：接口权限 + 数据权限 + 角色继承 + 缓存失效
- `menu-permissions`：菜单、按钮、多个 API binding 与后端最终鉴权
- `multi-tenant`：同一 userId 的跨租户隔离
- `vext-adapter`：真实 Vext TestApp 上的 200/403 路由 guard

跑通之后，再回看 [快速开始](/zh/guide/quick-start)、[资源路径模型](/zh/guide/resource-paths) 和 [PermissionCore API](/zh/api/permission-core)，理解会更直接。

## 这套站点文档解决什么问题

这套站点文档面向的是 permission-core 的使用者，而不是模块维护流程本身。它主要解决三类问题：

- `guide/`：先帮你选接入路径、理解概念和排查常见误区
- `api/`：直接说明公开接口、管理入口和错误边界
- `examples/`：给出 Express、vext、字段权限和 MonSQLize 等典型落地方式

如果你希望先看“真正能执行的仓库示例”，而不是站点页内片段，可以配合仓库根目录的 `examples/` 一起读。

如果你第一次接入，建议先看 [快速开始](/zh/guide/quick-start) 和 [常见问题](/zh/guide/faq)。如果你已经准备把角色、规则和用户绑定做成后台页面，可以继续看 [管理后台接入](/zh/guide/site-preview-release)。
