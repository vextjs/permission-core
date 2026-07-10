# 迁移指南

这页同时覆盖两种迁移：把散落在业务里的权限判断迁入 permission-core，以及升级已经接入的 permission-core 版本。

## 从散落权限判断迁入

1. 分开盘点接口权限、集合权限、行级条件和字段权限。
2. 把接口守卫统一成 `<METHOD>:<path>`，使用命中路由模板而不是实际 ID URL。
3. 把数据权限统一成 `db:<collection>[:<field>]`，行级条件放在结构化 `where` 中。
4. 先跑通一个角色、一个用户绑定、一个允许和一个拒绝，再扩大范围。
5. 管理后台、菜单、多租户和框架 adapter 按真实需求逐步启用，不在第一步同时铺开。
6. 每条规则或用户绑定变更都通过公开 manager，或在绕过时显式处理缓存失效。

迁移期间不要把认证职责塞入 permission-core，不要把记录 ID 写进路由资源，也不要把 `getResources()` 当成后端最终鉴权。

## 升级时优先确认什么

- `action + resource` 核心模型是否保持一致
- `write` 的双向语义是否仍然清晰
- `permission-core/match` 子路径导出是否保持稳定
- 三条官方接入路径是否仍然按相同口径组织

## 升级时建议先看哪些页面

如果后续版本发生变化，建议按以下顺序先看文档：

1. `guide/quick-start`
2. `guide/resource-paths`
3. `api/permission-core`
4. `examples/*`

这样可以确保接入者先看到最新入口，再去看细节。

升级前还应执行 `npm run test:docs`、`npm run example:all` 和 package install smoke。启用菜单或多租户时，同时备份/迁移核心 roles/rules/bindings 与菜单 nodes/API bindings/revision/audit，并验证跨租户拒绝反例。

继续看 [兼容性矩阵](/zh/guide/compatibility-matrix) 和 [生产部署](/zh/guide/production-deployment)。
