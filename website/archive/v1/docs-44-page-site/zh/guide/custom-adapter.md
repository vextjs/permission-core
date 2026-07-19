# 自定义适配器

当内置存储无法覆盖你的数据库时，实现 `StorageAdapter` 保存权限数据。

## 需要实现什么

- 角色
- 角色规则
- 角色继承
- 用户与角色绑定

适配器还应提供可预测的初始化与关闭行为。

如果权限数据还依赖菜单节点或 API 绑定，请为菜单模块单独实现 `MenuPermissionStorageAdapter`；核心 `StorageAdapter` 不负责菜单数据。

## 保持权限语义不变

自定义适配器只负责持久化，不应重新解释权限规则。`deny` 优先级、角色合并、行级条件计算与字段过滤语义仍由运行时负责。

## 下一步

编写适配器前先阅读 [StorageAdapter API](/zh/api/storage-adapter)。
