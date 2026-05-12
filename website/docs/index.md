---
pageType: home

hero:
  name: permission-core
  text: 细粒度权限控制内核
  tagline: 用统一规则控制接口权限、数据权限和字段过滤的 Node.js 权限库
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 了解接入模式
      link: /guide/introduction

features:
  - title: 三条官方接入路径
    details: 支持 HTTP-only、DB-only、Full standard stack 三条路径，先选模式再接入，不必一开始就上完整栈。
  - title: 统一权限模型
    details: 用一套规则同时处理接口资源和 db 资源，不必把接口权限和数据权限拆成两套系统。
  - title: 官方标准栈
    details: 默认生产方案为 cache-hub + monsqlize，同时保留 FileAdapter 与 MemoryAdapter 作为轻量备用方案。
  - title: 管理 API 与缓存失效
    details: roles、users、错误响应、缓存失效和管理后台接入路径都有独立说明，便于直接落地后台能力。
---

# permission-core

permission-core 是一个面向 Node.js 生态的通用细粒度权限核心库。它不绑定具体框架，也不替业务自动代理数据库操作，而是通过统一的 `action + resource` 模型提供：

- 接口权限判断
- 数据集合级权限判断
- 字段级读写过滤
- 角色继承与规则合并
- 权限缓存与失效控制

当前仓库已经落地上述核心运行时，并已通过 `typecheck`、24 项单测、构建产物生成，以及 `HTTP-only` / `DB-only` / `Full standard stack` 三条接入路径 smoke。如果你接入时希望顺手对照源码，而不是只看 API 名称，继续看 [接入阅读顺序](/guide/implementation-reading-order)。

如果你是第一次接触这个项目，建议先从以下路径选择一种开始：

- 只做接口权限：看 [快速开始](/guide/quick-start) 中的 `HTTP-only` 路径
- 只做数据权限：看 [快速开始](/guide/quick-start) 中的 `DB-only` 路径
- 同时做接口和数据权限：看 `Full standard stack` 路径

如果你已经看过几页，但还是反复在“我到底该选哪条路径”“为什么这里要先这样写”之间来回切换，建议先看 [常见问题](/guide/faq)。

## 这套站点文档解决什么问题

这套站点文档面向的是 permission-core 的使用者，而不是模块维护流程本身。它主要解决三类问题：

- `guide/`：先帮你选接入路径、理解概念和排查常见误区
- `api/`：直接说明公开接口、管理入口和错误边界
- `examples/`：给出 Express、vext、字段权限和 MonSQLize 等典型落地方式

如果你第一次接入，建议先看 [快速开始](/guide/quick-start) 和 [常见问题](/guide/faq)。如果你已经准备把角色、规则和用户绑定做成后台页面，可以继续看 [管理后台接入](/guide/site-preview-release)。