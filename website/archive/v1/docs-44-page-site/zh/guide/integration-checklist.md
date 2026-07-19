# 接入检查清单

First Success 跑通后、宣布应用接入可用前，使用这份消费者检查清单。

## 运行时生命周期

- [ ] 服务启动时 `pc.init()` 成功完成。
- [ ] 优雅停机时执行 `pc.close()`。
- [ ] 认证层先拒绝匿名请求，再把 subject 交给 permission-core。
- [ ] 适配器和连接所有权已经明确。

## 资源与规则

- [ ] 接口资源使用命中的模板，例如 `DELETE:/api/orders/:id`。
- [ ] 数据资源使用 `db:<collection>[:<field>]`。
- [ ] 管理界面能显示 deny 和继承后的有效规则。
- [ ] 保存规则时按完整规则身份去重。
- [ ] 规则与用户绑定变化会失效正确 scope 的权限缓存。

## 租户隔离

- [ ] 每个 tenant 请求在鉴权前都产生非空 `tenantId`。
- [ ] subject 与 bound scope 字段完全一致。
- [ ] core storage、menu storage、缓存 key、revision 和审计查询使用同一 scope。
- [ ] 反例证明同一 `userId` 不能在 tenant B 复用 tenant A 权限。

## 菜单与后端 API

- [ ] 测试菜单显隐前，角色、规则和用户绑定已经存在。
- [ ] 完整 manifest 导入成功，`validate()` 无错误。
- [ ] 敏感操作具有 API binding，并启用 `strictApiBindings`。
- [ ] 多 API 操作明确选择 `permissionMode: "any" | "all"`。
- [ ] 每个后端接口仍调用 `assertSubject()` 或等价 guard。
- [ ] 共享生产菜单数据使用 `MonSQLizeMenuStorageAdapter`。

## Vext

- [ ] 认证先写入 `req.auth`，权限中间件后运行。
- [ ] tenant 路由启用 `tenantRequired`。
- [ ] 原生 route `auth.permissions` 已被消费。
- [ ] 除非另一条已测试 guard 明确接管，否则保持 `guardRoutePermissions` 开启。
- [ ] `ownsCore`、`ownsMenu` 和连接所有权符合应用生命周期。

## 行为证据与恢复

- [ ] 证据包含一条允许和一条拒绝请求。
- [ ] scoped 接入包含跨租户拒绝。
- [ ] 持久化适配器重启后能恢复 core 与 menu 状态。
- [ ] 过期 revision 或非法 manifest 被拒绝，且不会部分保存。
- [ ] 停机时只释放当前集成拥有的资源。
- [ ] 回滚能恢复已知 manifest revision，并失效受影响缓存。

继续看 [生产部署与监控](/zh/guide/production-deployment)，补齐观测、备份和发布策略。
