---
pageType: home

hero:
  badge: v2.0.0 preview
  name: permission-core
  text: Authorization that reaches the data layer
  tagline: One tenant-aware RBAC model for routes, menus, APIs, rows, and fields in Node.js services.
  image:
    src: /permission-authorization-visual.svg
    alt: Authorization flow from identity through roles to application resources
  actions:
    - theme: brand
      text: Start in 10 minutes
      link: /guide/quick-start
    - theme: alt
      text: Explore examples
      link: /examples/basic

features:
  - title: MonSQLize 3.1 persistence
    details: Use the application's connected MonSQLize instance for durable roles, rules, revisions, audit records, and transactions.
    link: /guide/permission-lifecycle
  - title: Complete admin permissions
    details: Manage menus, pages, buttons, API bindings, and role grants, then project a safe tree for each user.
    link: /guide/menu-management
  - title: Rows and fields together
    details: Compose a Mongo-style business filter with tenant scope, policy conditions, and field-level read or write rules.
    link: /guide/data-permissions
  - title: Real tenant isolation
    details: The same user and role identifiers remain independent because every read, write, cache key, and audit entry is scoped.
    link: /guide/multi-tenant
  - title: Native Vext plugin
    details: Consume route permissions, trusted authentication context, lifecycle hooks, and restart-required route reloads.
    link: /guide/vext-plugin
  - title: Observable and fail-closed
    details: Use revision checks, previews, audit IDs, health state, bounded outputs, and explicit recovery paths in production.
    link: /guide/production-operations
---

# permission-core

permission-core is the authorization layer between a trusted identity and application resources. It answers who may invoke a route, see a menu, call an API, or read and change specific database rows and fields.

It deliberately does **not** perform login, verify credentials, own the application's database connection, or replace backend route checks. The host authenticates the request and owns a connected MonSQLize 3.1 instance; permission-core owns authorization state and decisions.

## Recommended path

1. Complete [Quick Start](/guide/quick-start) for the first allowed and blocked decisions.
2. Add [data permissions](/guide/data-permissions) or [menu administration](/guide/menu-management) as the application needs them.
3. Read the [permission lifecycle](/guide/permission-lifecycle) before production rollout.

The five [runnable examples](/examples/basic) use the same public package surface documented here.
