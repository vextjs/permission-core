# Changelog

All notable changes to permission-core are documented in this file.

## v0.2.0 - 2026-05-13

- 首次完成可发布的 permission-core 核心运行时收口，并形成正式版本基线。
- 新增统一 action + resource 鉴权核心、RBAC 管理器、行级权限与字段过滤能力。
- 新增 `MemoryAdapter`、`FileAdapter`、`MonSQLizeStorageAdapter` 三类存储适配器，以及 `cache-hub` 缓存集成。
- 新增覆盖 24 项用例的单测与三条官方接入路径 smoke。
- 新增独立文档站、README 阅读入口和实现阅读顺序文档。
- 详细变更见 [changelogs/v0.2.0.md](./changelogs/v0.2.0.md)。