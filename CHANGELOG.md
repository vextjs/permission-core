# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 📂 **Detailed changelogs**: See the [`changelogs/`](./changelogs/) directory for full release notes per version.
> This file serves as a version overview index for quick browsing of release history.

---

## [2.0.0] - 2026-07-20

### Added

- Added a MonSQLize 3.1-backed tenant-scoped RBAC runtime, menu/API authorization, guarded data collections, revisioned previews, audit evidence, and optional semantic caching.
- Added the optional `permission-core/plugins/vext` integration and retained `permission-core/match` as the standalone built-in matcher.
- Added five runnable scenarios and a task-first documentation site with 34 English/Chinese page pairs. See [`changelogs/v2.0.0.md`](./changelogs/v2.0.0.md) for the complete change set.

### Changed

- Made MonSQLize 3.1 the only persistence contract and reduced the public package surface to `.`, `./match`, and `./plugins/vext`.
- Replaced the previous adapter-oriented API with scoped management and subject contexts; this major release line does not carry a migration guide.

---

## Version History

| Version | Date | Type | Key Theme |
|---------|------|------|-----------|
| [2.0.0] | 2026-07-20 | Major | MonSQLize 3.1-backed tenant RBAC, complete admin menu/API permissions, data guards, Vext integration, and task-first docs [查看](./changelogs/v2.0.0.md) |
| [1.0.10] | 2026-06-11 | Patch | Shared cache invalidation safety, release gate hardening, bilingual docs, and verified MonSQLize/cache-hub line [查看](./changelogs/v1.0.10.md) |
| [1.0.9] | 2026-06-09 | Patch | Refreshed package lock with npm 11 so Node 24 publish workflow can install optional native packages [查看](./changelogs/v1.0.9.md) |
| [1.0.8] | 2026-06-09 | Patch | Updated npm publish workflow to Node 24 actions while keeping build-before-publish guard [查看](./changelogs/v1.0.8.md) |
| [1.0.7] | 2026-06-09 | Patch | Fixed publish workflow to build package output before npm publish [查看](./changelogs/v1.0.7.md) |
| [1.0.6] | 2026-06-09 | Patch | Pinned direct runtime and development dependencies to exact package-lock resolved versions [查看](./changelogs/v1.0.6.md) |
| [1.0.5] | 2026-06-04 | Patch | License metadata and package distribution updated to Apache-2.0 [查看](./changelogs/v1.0.5.md) |
| [1.0.0] | 2026-05-14 | Major | 正式发布：26项 HTTP 集成验证 100% 通过、角色 inspect API、覆盖率 100%、GitHub Pages 自动部署 [查看](./changelogs/v1.0.0.md) |
| [0.2.0] | 2026-05-13 | Minor | 首次可发布运行时基线：统一 `action + resource`、三类存储适配器、行级权限与独立文档站 [查看](./changelogs/v0.2.0.md) |

---

## Links

- [GitHub Repository](https://github.com/vextjs/permission-core)
- [Detailed Changelogs](./changelogs/)

[1.0.10]: https://github.com/vextjs/permission-core/compare/v1.0.9...v1.0.10
[2.0.0]: https://github.com/vextjs/permission-core/compare/v1.0.10...v2.0.0
[1.0.6]: https://github.com/vextjs/permission-core/compare/v1.0.5...v1.0.6
[1.0.7]: https://github.com/vextjs/permission-core/compare/v1.0.6...v1.0.7
[1.0.8]: https://github.com/vextjs/permission-core/compare/v1.0.7...v1.0.8
[1.0.9]: https://github.com/vextjs/permission-core/compare/v1.0.8...v1.0.9
[1.0.5]: https://github.com/vextjs/permission-core/compare/v1.0.4...v1.0.5
[1.0.0]: https://github.com/vextjs/permission-core/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/vextjs/permission-core/releases/tag/v0.2.0
