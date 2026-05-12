# 迁移指南

这页用于版本升级时快速确认兼容边界。如果你当前还没有跨版本迁移需求，可以先跳过，等需要升级时再回来对照。

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