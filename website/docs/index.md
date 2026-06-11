---
pageType: home

hero:
  badge: v1.0.10 payment authorization release
  name: permission-core
  text: Authorization Core
  tagline: Payment-grade route, data, row, and field permissions for Node.js services.
  image:
    src: /permission-authorization-visual.svg
    alt: Payment authorization flow diagram
  actions:
    - theme: brand
      text: Quick Start
      link: /guide/quick-start
    - theme: alt
      text: API Reference
      link: /api/permission-core
    - theme: alt
      text: Examples
      link: /examples/basic

features:
  - title: Three Integration Paths
    details: Start with HTTP-only, DB-only, or the full standard stack instead of forcing every service into one architecture.
    link: /guide/quick-start
  - title: Unified Permission Model
    details: Use the same action and resource rules for routes, collections, rows, and fields.
    link: /guide/resource-paths
  - title: Payment-ready Controls
    details: Model transaction APIs, ledger rows, refund fields, and management-console saves with explicit rules and cache invalidation.
    link: /guide/production-deployment
  - title: Standard Production Stack
    details: Use cache-hub for permission cache and MonSQLizeStorageAdapter for persistent role and binding data.
    link: /guide/adapters
  - title: Role Inheritance
    details: Inspect own rules, effective inherited rules, and role chains without rebuilding that logic in your app.
    link: /api/role-manager
  - title: Row and Field Permissions
    details: Combine getRowScope, canRow, filterRows, and filterFields for service-layer data authorization.
    link: /guide/row-level
---

# permission-core

permission-core is a framework-neutral fine-grained authorization core for Node.js services. It does not replace your authentication layer or proxy database operations for you. Instead, it gives you a consistent `action + resource` model for:

- route permission checks
- collection-level data checks
- row-level scopes
- field-level filtering
- role inheritance and rule merging
- permission cache invalidation

The current repository has implemented the core runtime and passes `typecheck`, 60 tests, package build, runnable examples, and 100% statement / branch / function / line coverage.

## Start with one path

- Route permissions only: start with the [HTTP-only path](/guide/quick-start).
- Data permissions only: start with the [DB-only path](/guide/quick-start).
- Route + data + management APIs: start with the [full standard stack](/guide/quick-start).

If you are unsure which path fits, read the [FAQ](/guide/faq) before wiring a full production stack.

## Run the examples first

From the repository root:

```bash
npm run example:all
```

That command runs the HTTP-only, DB-only, and complete-flow examples against the built package output. After that, continue with [Quick Start](/guide/quick-start), [Resource Paths](/guide/resource-paths), and the [PermissionCore API](/api/permission-core).

## How this site is organized

- `guide/` explains integration paths, concepts, production deployment, and common mistakes.
- `api/` documents the public runtime, managers, adapters, cache, and error codes.
- `examples/` shows how the pieces fit into Express, vext, management backends, row scopes, fields, and MonSQLize.

If you want runnable files instead of page snippets, read the repository root `examples/` directory as well.
