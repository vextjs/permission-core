# Introduction

permission-core is a framework-neutral authorization kernel for Node.js. It starts after authentication has identified a string `userId` and answers whether that subject may perform an action on a resource.

## What it owns

- Role definitions, allow/deny rules, inheritance, and user-role bindings.
- Route, collection, row-scope, and top-level field authorization.
- Explicit permission-cache invalidation.
- Tenant/application scoped roles, bindings, rules, and cache keys.
- Optional menu/page/button/API-binding workflows through `permission-core/menu`.
- A built-in Vext adapter through `permission-core/adapters/vext`.

## What your application still owns

permission-core does not authenticate users, issue tokens, manage sessions, execute database queries, own business transactions, or replace audit and compliance systems. Your application supplies identity and request context, calls the authorization API at the correct boundary, and handles business data.

## Resource model

| Resource | Shape | Typical action |
|----------|-------|----------------|
| Route | `<METHOD>:<path>` | `invoke` |
| Collection | `db:<collection>` | `read`, `create`, `update`, `delete` |
| Field | `db:<collection>:<field>` | `read`, `create`, `update` |
| Menu/page/button | `ui:<asset-kind>:<code>` | `read`, `invoke` |
| Bound backend API | `api:<METHOD>:<path>` | `invoke` |

UI visibility improves the experience but never replaces backend authorization.

## Next task

Continue with [Quick Start](/guide/quick-start) and do not add framework, database, or management-console complexity until its allowed and denied decisions both run.
