---
pageType: home

hero:
  badge: v2.0.0 preview
  name: permission-core
  text: Authorization that reaches the data layer
  tagline: Use one tenant-aware RBAC model to control Node.js APIs, menus, data rows, and fields.
  image:
    src: /permission-authorization-visual.svg
    alt: Authorization flow from identity through roles to application resources
  actions:
    - theme: brand
      text: 10-minute Quick Start
      link: /guide/quick-start
    - theme: alt
      text: View Runnable Examples
      link: /examples/basic

features:
  - title: MonSQLize 3.1 persistence
    details: Reuse the application's connected MonSQLize runtime to persist roles, rules, revisions, audit evidence, and real transactions.
    link: /guide/permission-lifecycle
  - title: Complete admin permissions
    details: Manage menus, pages, buttons, API bindings, and role grants, then project a safe visible tree for each user.
    link: /guide/menu-management
  - title: Row and field coordination
    details: Automatically compose Mongo-style business filters with tenant scope, rule conditions, and read/write field permissions.
    link: /guide/data-permissions
  - title: Real tenant isolation
    details: Every read, write, cache key, and audit record carries scope so reused user and role IDs remain isolated by tenant.
    link: /guide/multi-tenant
  - title: Native Vext plugin
    details: Consume route permissions and trusted auth context, join lifecycle hooks, and require restart after route manifest changes.
    link: /guide/vext-plugin
  - title: Observable and default-deny
    details: Support production operations through revisions, previews, audit IDs, health state, bounded responses, and explicit recovery paths.
    link: /guide/production-operations
---

# permission-core
<!-- docs:inline-parity `can()` `PermissionCore` `new PermissionCore(options)` `await init()` `scoped` `pc.scope({ tenantId, ... })` `subject` `pc.forSubject({ userId, scope, claims? })` `AuthorizedCollection` `subject.data.collection(name, options)` -->

permission-core sits between trusted identity and application resources. It answers who can call an API, see a menu, reach a backend endpoint, and read or mutate specific rows and fields.

It explicitly does **not** handle login, credential verification, ownership of the application database connection, or backend authorization by hiding frontend menus. The host authenticates the user and owns a connected MonSQLize 3.1 instance; permission-core owns authorization state and decisions.

## Use Only the Layer You Need

1. **Core RBAC is the starting point.** Create roles and rules, bind users, and call `can()` on the backend.
2. **Menus and API bindings are optional.** Add them when an admin system needs menu, page, button, and endpoint coordination.
3. **Row and field data permissions are optional.** Add them when the business needs to restrict records or fields inside a collection.
4. **Vext and production operations are integration layers.** Use them when the application runs Vext or is preparing for deployment.

First-time users only need the first layer. Later capabilities reuse the same tenant, user, role, and rule model.

## Know the Four Entry Points

| Entry | Created by | Owns | Does not own |
|---|---|---|---|
| `PermissionCore` | `new PermissionCore(options)` + `await init()` | Lifecycle, health, scope and subject facades | Connecting or closing the host database |
| `scoped` | `pc.scope({ tenantId, ... })` | Role, assignment, menu, and API management inside one scope | A specific request user |
| `subject` | `pc.forSubject({ userId, scope, claims? })` | User decisions, menu projection, and data access | Login authentication |
| `AuthorizedCollection` | `subject.data.collection(name, options)` | Combining business `filter`, scope, row/field permissions, and MonSQLize calls | Returning an optional filter for callers to remember |

Exact parameters and raw responses start in [Core and Contexts API](/api/core-and-contexts).

## Recommended Path

1. Finish [Quick Start](/guide/quick-start) and see the first allowed and denied result.
2. Build the basic admin flow with [Manage Roles and User Assignments](/guide/manage-roles-and-users).
3. Add [Data Permissions](/guide/data-permissions) or [Manage Menus](/guide/menu-management) when the business needs them.
4. Read [Permission Lifecycle](/guide/permission-lifecycle) and [Production Operations](/guide/production-operations) before production rollout.

The five [runnable examples](/examples/basic) use only the public package interfaces documented here.

## Project Entry Points

- [GitHub repository](https://github.com/vextjs/permission-core): source, issues, and current development state.
- [CHANGELOG](https://github.com/vextjs/permission-core/blob/main/CHANGELOG.md): recorded version changes.
- [CONTRIBUTING](https://github.com/vextjs/permission-core/blob/main/CONTRIBUTING.md): contribution and repository verification flow.
- [SECURITY](https://github.com/vextjs/permission-core/blob/main/SECURITY.md): security boundary and private reporting path.
- [Apache-2.0 LICENSE](https://github.com/vextjs/permission-core/blob/main/LICENSE): license text.
