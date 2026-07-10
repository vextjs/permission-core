# Introduction

permission-core is a fine-grained authorization kernel for Node.js. It is designed for applications that need route permissions, data permissions, role inheritance, row scopes, field filtering, and management-console friendly rule storage.

## What it does

- Checks whether a user can perform an `action` on a `resource`.
- Stores roles, rules, and user-role bindings through a `StorageAdapter`.
- Resolves inherited roles and merges multiple role rules.
- Applies deny-first permission checks.
- Exposes row-scope and field-filter helpers for service-layer data authorization.
- Keeps permission cache invalidation explicit.
- Isolates roles, rules, bindings, and cache entries by tenant/application scope.
- Adds optional menu/page/button/API-binding workflows through `permission-core/menu`.
- Adds a built-in Vext plugin, middleware, route guard, and manifest adapter through `permission-core/adapters/vext`.

## What it does not do

permission-core is not an authentication system. It does not issue tokens, manage sessions, hash passwords, own your database schema, or replace audit logging. Your application still owns identity, request context, secrets, compliance controls, and database queries.

## Main resource shapes

| Resource | Shape | Typical action |
|----------|-------|----------------|
| Route | `<METHOD>:<path>` | `invoke` |
| Collection | `db:<collection>` | `read`, `create`, `update`, `delete`, `write` |
| Field | `db:<collection>:<field>` | `read`, `create`, `update`, `delete`, `write` |
| Menu/page/button | `ui:<asset-kind>:<code>` | `read`, `invoke` |
| Bound backend API | `api:<METHOD>:<path>` | `invoke` |

Menu visibility is not the final backend security boundary. A page or button may be visible for navigation purposes, while the bound API must still be authorized on the server.

## Recommended next step

Start with [Quick Start](/guide/quick-start), then choose the task that matches your application:

- Admin menus, pages, buttons, and multiple APIs per operation: [Menu Permissions](/guide/menu-permissions)
- Tenant/application isolation: [Multi-tenant Permissions](/guide/multi-tenant)
- A Vext host with native route guards: [vext Adapter](/guide/vext-adapter)
- Role editing screens and operational APIs: [Management Console](/guide/site-preview-release)

Before production, finish the [Integration Checklist](/guide/integration-checklist) and [Production Deployment](/guide/production-deployment) paths.
