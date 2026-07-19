# Unreleased

## Added

- Added the MonSQLize 3.1-backed `PermissionCore` runtime with tenant-scoped roles, inheritance, user bindings, rules, revisioned mutations, previews, audit evidence, and fail-closed subject decisions.
- Added menu nodes, API bindings, role-menu authorization, manifest import/export, visible-tree/button/route projections, source integrity, impact analysis, and explicit stale-source repair.
- Added `AuthorizedCollection` for tenant, row, field, Mongo-style filter, write, pagination, and host-transaction enforcement.
- Added the optional `permission-core/plugins/vext` entry with native route metadata, lazy trusted subjects, manifest validation, HTTP error mapping, restart-required reload handling, and Vext-owned core shutdown.
- Added opt-in semantic authorization caching through the host MonSQLize cache, with revision-bound values, targeted invalidation, incident health, and durable cache-outcome reconciliation.
- Added built-in HTTP/API/data/UI resource grammars, deterministic custom resource schemes, and the standalone `permission-core/match` entry.

## Fixed

- Made MonSQLize 3.1 the only database contract and reduced the package surface to `.`, `./match`, and `./plugins/vext`; permission-core never owns or closes the host database.
- Canonicalized row conditions and permission sources so equivalent manual/menu rules deduplicate without losing provenance, while deny-first evaluation remains deterministic.
- Hardened stable reads, revision vectors, idempotent replay, preview tokens, capacity limits, persisted-state validation, and old-fill-after-invalidation cache races.
- Hardened Vext request ownership, route-manifest commit ordering, `any`/`all` contract digests, startup rollback, cross-entry error identity, and real TCP status mapping.
- Rebuilt the documentation as 34 English/Chinese page pairs with a task-first manifest, exact source owners, complete response examples, five runnable scenarios, rendered-route checks, and stable/preview channel assembly.
