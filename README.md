# permission-core

[Documentation](https://vextjs.github.io/permission-core) | [GitHub](https://github.com/vextjs/permission-core) | [Changelog](./CHANGELOG.md)

permission-core is a fine-grained authorization core for Node.js. It uses one `action + resource` model to cover route permissions, data permissions, row scopes, field filtering, role rules, and permission cache invalidation.

## Status

- The full user documentation is published at [https://vextjs.github.io/permission-core](https://vextjs.github.io/permission-core).
- The runtime has implemented the core engine, three storage adapters, RBAC managers, role inheritance, row-level checks, and field filtering.
- Role management can inspect a role's own rules, effective inherited rules, and role chain.
- The current implementation passes `typecheck`, 60 tests, package build, example smoke tests, and 100% statement / branch / function / line coverage.
- The root `examples/` directory includes runnable `HTTP-only`, `DB-only`, and complete integration flows.
- This README keeps the entry path short. Use the documentation site for the complete guide, API reference, and examples.

## Three Official Integration Paths

### HTTP-only

Use this path when you only need route, menu, button, or API guard permissions.

- Resource format: `<METHOD>:<path>`, where `path` should be the normalized matched route path.
- Common APIs: `assert`, `can`, and `getResources`.
- No `db:` resource is required.

### DB-only

Use this path when authorization belongs in your Service / DAO layer and you need collection, row, or field permissions.

- Resource format: `db:<collection>[:<field>]`.
- Common APIs: `can`, `assert`, `getRowScope`, `filterRows`, and `filterFields`.
- No HTTP middleware is required.

### Full standard stack

Use this path when you need route permissions, data permissions, row scopes, field filtering, and management APIs together.

- The recommended production stack is `cache-hub + monsqlize`.
- Route resources and `db:` resources can be enabled together.
- This path is a good fit for payment, finance, SaaS, and admin-console authorization flows where permissions must be auditable and centrally managed.

## Unified Permission Model

- Route resource: `<METHOD>:<path>`
- Data resource: `db:<collection>[:<field>]`
- Route action: `invoke`
- Data actions: `read`, `create`, `update`, `delete`, `write`, `*`
- Rule-side `write` grants `create + update`; request-side `write` requires both `create && update`.

## Recommended Stack

- Cache backend: `cache-hub`
- Production storage: `MonSQLizeStorageAdapter`
- Lightweight fallback storage: `FileAdapter` and `MemoryAdapter`
- Design principle: keep `StorageAdapter` abstract. permission-core is not tied to MongoDB even though the official production adapter uses monsqlize.

## Role Inspection APIs

For role detail pages, debugging panels, or integration diagnostics, use:

- `roles.getRoleChain(roleId)` to read the current role and its parent chain.
- `roles.getEffectiveRules(roleId)` to read inherited effective rules.
- `roles.inspect(roleId)` to return `role`, `ownRules`, `effectiveRules`, and `roleChain` in one call.

## Documentation Entry Points

- Documentation site: <https://vextjs.github.io/permission-core>
- Quick start: `website/docs/en/guide/quick-start.md`
- Production deployment: `website/docs/en/guide/production-deployment.md`
- Compatibility matrix: `website/docs/en/guide/compatibility-matrix.md`
- Resource paths: `website/docs/en/guide/resource-paths.md`
- API reference: `website/docs/en/api/permission-core.md`
- Examples: `website/docs/en/examples/basic.md`
- Runnable examples: `examples/README.md`
- Chinese documentation: `website/docs/zh/**`

Recommended reading order:

1. `website/docs/en/guide/quick-start.md`
2. `website/docs/en/guide/faq.md`
3. `website/docs/en/guide/resource-paths.md`
4. `website/docs/en/guide/roles-and-rules.md`
5. `website/docs/en/guide/check-permission.md`
6. `website/docs/en/guide/integration-checklist.md`

If you are ready to write integration code, continue with `website/docs/en/guide/implementation-reading-order.md`.

## Security and Compatibility

- Security policy: `SECURITY.md`
- Runtime and dependency support: `website/docs/en/guide/compatibility-matrix.md`
- Production deployment guidance: `website/docs/en/guide/production-deployment.md`

permission-core does not replace your authentication system, token verification, key management, audit platform, or database security model. Treat it as an authorization kernel and keep those responsibilities explicit in your application.

## Local Documentation

Run the documentation site locally:

```bash
cd website
npm install
npm run dev
```

Build the static site:

```bash
cd website
npm run build
```

Run all repository examples:

```bash
npm run example:all
```

Or run them one by one:

```bash
npm run example:http
npm run example:db
npm run example:complete
```

## Current Boundary

- Public docs cover integration paths, resource modeling, runtime APIs, management APIs, cache semantics, and common integration patterns.
- Security, production deployment, and compatibility docs explain how to use the authorization core safely, but they do not replace your own authentication, secrets, logging, compliance, or audit controls.
- For the most detailed API surface, continue with `website/docs/en/api/**` and `website/docs/en/examples/**`.
