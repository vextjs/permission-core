# Introduction

permission-core is a fine-grained authorization kernel for Node.js. It is designed for applications that need route permissions, data permissions, role inheritance, row scopes, field filtering, and management-console friendly rule storage.

## What it does

- Checks whether a user can perform an `action` on a `resource`.
- Stores roles, rules, and user-role bindings through a `StorageAdapter`.
- Resolves inherited roles and merges multiple role rules.
- Applies deny-first permission checks.
- Exposes row-scope and field-filter helpers for service-layer data authorization.
- Keeps permission cache invalidation explicit.

## What it does not do

permission-core is not an authentication system. It does not issue tokens, manage sessions, hash passwords, own your database schema, or replace audit logging. Your application still owns identity, request context, secrets, compliance controls, and database queries.

## Main resource shapes

| Resource | Shape | Typical action |
|----------|-------|----------------|
| Route | `<METHOD>:<path>` | `invoke` |
| Collection | `db:<collection>` | `read`, `create`, `update`, `delete`, `write` |
| Field | `db:<collection>:<field>` | `read`, `create`, `update`, `delete`, `write` |

## Recommended next step

Start with [Quick Start](/guide/quick-start). If you already know you are building a management console, continue with [Management Console](/guide/site-preview-release) after the quick start.
