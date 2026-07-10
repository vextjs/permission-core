---
pageType: home

hero:
  badge: v1.1.0 unreleased preview
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
  - title: Admin Menu and API Bindings
    details: Model menus, pages, buttons, and multiple backend APIs per button, then inspect effective authorization trees and audit manifest revisions.
    link: /guide/menu-permissions
  - title: Real Tenant Isolation
    details: Bind the same user ID independently per tenant and app with scoped storage, cache keys, and exact-scope subject checks.
    link: /guide/multi-tenant
  - title: Built-in vext Adapter
    details: Attach req.auth.can/assert, consume native route permissions, enforce any/all groups, and manage lifecycle through the bundled adapter.
    link: /guide/vext-adapter
---

# permission-core

permission-core is a framework-neutral fine-grained authorization core for Node.js services. It does not replace your authentication layer or proxy database operations for you. Instead, it gives you a consistent `action + resource` model for:

- route permission checks
- collection-level data checks
- row-level scopes
- field-level filtering
- role inheritance and rule merging
- permission cache invalidation

The current repository is preparing the unreleased `1.1.0` line. Its local gate covers `typecheck`, the complete test suite, package build, runnable examples, and enforced coverage floors of 92% statements, 89.5% branches, 95% functions, and 92% lines.

## Start with one path

- Route permissions only: start with the [HTTP-only path](/guide/quick-start).
- Data permissions only: start with the [DB-only path](/guide/quick-start).
- Route + data + management APIs: start with the [full standard stack](/guide/quick-start).
- Admin menus and one-button-to-many-API rules: follow [Menu Permissions](/guide/menu-permissions).
- Tenant-isolated roles and rules: follow [Multi-tenant Permissions](/guide/multi-tenant).
- A real vext host: follow the [vext Adapter](/guide/vext-adapter).

If you are unsure which path fits, read the [FAQ](/guide/faq) before wiring a full production stack.

## Run the examples first

From the repository root:

```bash
npm run example:all
```

That command runs HTTP-only, DB-only, complete-flow, menu, multi-tenant, and real vext-host examples against the built package output. After that, continue with [Quick Start](/guide/quick-start), [Resource Paths](/guide/resource-paths), and the [PermissionCore API](/api/permission-core).

## How this site is organized

- `guide/` explains integration paths, concepts, production deployment, and common mistakes.
- `api/` documents the public runtime, managers, adapters, cache, and error codes.
- `examples/` shows how the pieces fit into Express, vext, management backends, row scopes, fields, and MonSQLize.

If you want runnable files instead of page snippets, read the repository root `examples/` directory as well.
