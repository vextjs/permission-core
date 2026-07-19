# 介绍

permission-core 是面向 Node.js 的框架无关授权内核。认证层先得到字符串 `userId`，permission-core 再回答这个主体能否对某个资源执行指定动作。

## 它负责什么

- 角色、allow/deny 规则、继承和用户角色绑定。
- 接口、集合、行级范围和顶层字段授权。
- 显式的权限缓存失效。
- tenant/app 维度的角色、绑定、规则和缓存隔离。
- 通过 `permission-core/menu` 提供可选的菜单、页面、按钮和 API binding。
- 通过 `permission-core/adapters/vext` 提供内置 Vext 适配器。

## 应用仍然负责什么

permission-core 不负责登录、Token、Session、数据库查询、业务事务，也不替代审计和合规系统。应用负责提供身份与请求上下文，在正确的边界调用鉴权 API，并处理业务数据。

## 资源模型

| 资源 | 形式 | 常用动作 |
|------|------|----------|
| 接口 | `<METHOD>:<path>` | `invoke` |
| 集合 | `db:<collection>` | `read`、`create`、`update`、`delete` |
| 字段 | `db:<collection>:<field>` | `read`、`create`、`update` |
| 菜单/页面/按钮 | `ui:<asset-kind>:<code>` | `read`、`invoke` |
| 绑定的后端 API | `api:<METHOD>:<path>` | `invoke` |

前端显隐只改善体验，不能替代后端最终鉴权。

## 下一步

继续看 [快速开始](/zh/guide/quick-start)。在允许和拒绝两种结果都跑通前，先不要增加框架、数据库或管理后台复杂度。
