# Unreleased

- Added the Vext request-scoped protected MonSQLize-like data facade with `subject.resolve(req)`, `data.scopeFields`, `req.auth.permission.data`, optional `req.monsqlize`, and request-owner guards for authorized CRUD access.
- Added automatic preview-and-commit execution for high-level incremental menu management APIs, including `MENU_MANAGEMENT_PREVIEW_CONFLICT` for operations that still require explicit administrator preview confirmation.
