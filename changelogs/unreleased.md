# Unreleased

## Added

- Added scoped multi-tenant permission APIs with isolated roles, user bindings, rules, caches, and storage adapters.
- Added the optional `permission-core/menu` entry for menu trees, pages, buttons, API bindings, authorization explanations, manifest synchronization, revisioned snapshots, audits, and Memory/File/MonSQLize persistence.
- Added the built-in optional `permission-core/adapters/vext` integration with native route permission metadata, tenant resolution, middleware/provider helpers, plugin lifecycle support, and real-host tests.

## Fixed

- Aligned README and website examples with the current RoleManager API, fixed local English docs paths, and refreshed the verified regression suite to 113 tests.
- Kept the released support baseline at `1.0.10` while preparing the unreleased `1.1.0` line.
- Canonicalized row-condition matching so semantically equal `where` rules dedupe and revoke consistently regardless of object key order, logical child order, and `in` / `nin` value order.
- Kept documentation sidebars fixed on desktop while restoring normal page-level scrolling without a narrow inner document scrollbar.
- Documented the role-rule batch API boundary, clarified automatic cache invalidation in manager APIs, fixed stale English `grant()` examples, and aligned the Chinese docs.
- Added CSS-driven motion to the documentation home authorization visual, including route/row/field data flow, policy node pulses, shield breathing, audit panel activity, and reduced-motion-safe timing.
- Tightened the documentation home hero alignment and vertical rhythm so the visual panel and feature cards sit closer to the payment authorization theme.
- Replaced the default one-line home footer with a vext-style multi-column documentation footer.
- Synchronized the documentation nav with an explicit `v1.1.0 Unreleased` label.
- Hardened permission snapshots, custom default-scope invalidation, resource-scheme snapshots, scoped-adapter detection, menu snapshot cache keys, and scoped MemoryAdapter role ID roundtrips.
- Changed FileAdapter persistence to write a complete same-directory temporary snapshot and atomically replace the target file, preserving the last successful file when replacement fails.
