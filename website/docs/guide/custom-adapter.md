# 自定义适配器

当内置的 `MemoryAdapter`、`FileAdapter`、`MonSQLizeStorageAdapter` 都不适合你的系统时，可以实现一个自定义适配器。

## 什么时候需要自定义

- 你已经有自己的权限表结构
- 你想把规则放在其他持久化系统里
- 你需要与现有管理后台或配置中心复用数据

## 最重要的要求

自定义适配器只负责：

- 角色读写
- 规则读写
- 用户绑定读写
- 初始化与关闭流程

它不应该：

- 改写 `can()` 的判断逻辑
- 改写 `deny` / `allow` 优先级
- 改写 `write` 的语义

## 实践建议

1. 先用 `MemoryAdapter` 把最简单的流程跑通
2. 再实现自定义适配器
3. 最后用同一组 `can/assert/filterFields` 示例再完整验一遍

后续正式 API 约束见 [PermissionCore](/api/permission-core) 和 [RoleManager](/api/role-manager)。