# permission-core

[Documentation](https://vextjs.github.io/permission-core) | [GitHub](https://github.com/vextjs/permission-core) | [Changelog](./CHANGELOG.md)

permission-core is a fine-grained authorization core for Node.js. It uses one `action + resource` model to cover route permissions, data permissions, row scopes, field filtering, role rules, and permission cache invalidation.

## Status

- The full user documentation is published at [https://vextjs.github.io/permission-core](https://vextjs.github.io/permission-core).
- The runtime has implemented the core engine, three storage adapters, RBAC managers, role inheritance, row-level checks, field filtering, scoped multi-tenant APIs, the optional `permission-core/menu` module, and the built-in `permission-core/adapters/vext` adapter.
- Role management can inspect a role's own rules, effective inherited rules, and role chain.
- The current `1.1.0` worktree is unreleased. Its local gate covers type checking, the complete test suite, package build, example smoke tests, and enforced coverage floors of 92% statements, 89.5% branches, 95% functions, and 92% lines.
- The root `examples/` directory includes runnable HTTP-only, DB-only, complete integration, menu permissions, multi-tenant, and vext adapter flows.
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
- The current verified dependency line is `cache-hub@2.2.4 + monsqlize@2.0.3`.
- Route resources and `db:` resources can be enabled together.
- This path is a good fit for payment, finance, SaaS, and admin-console authorization flows where permissions must be auditable and centrally managed.

## Unified Permission Model

- Route resource: `<METHOD>:<path>`
- API guard resource: `api:<METHOD>:<path>`
- UI resource: `ui:menu:<id>`, `ui:page:<id>`, or `ui:button:<id>`
- Data resource: `db:<collection>[:<field>]`
- Route action: `invoke`
- Data and management actions: `read`, `create`, `update`, `delete`, `write`, `manage`, `*`
- Rule-side `write` grants `create + update`; request-side `write` requires both `create && update`.

## Menu Permissions and Multi-tenancy

Use `permission-core/menu` when an admin console needs menu trees, page routes, buttons, API bindings, authorization trees, manifest import, validation, and audit records.

```ts
import { PermissionCore } from "permission-core";
import { createMenuPermission } from "permission-core/menu";

const pc = new PermissionCore();
await pc.init();

const scope = { tenantId: "tenant-a", appId: "admin" };
const menu = createMenuPermission({ core: pc, strictApiBindings: true });

await pc.scope(scope).roles.create("admin", { label: "Admin" });
await pc.scope(scope).roles.allow("admin", "read", "ui:menu:system.user");
await pc.scope(scope).roles.allow("admin", "invoke", "api:GET:/api/users");
await pc.scope(scope).users.assign("u-1", "admin");
await pc.assertSubject(
  { ...scope, userId: "u-1" },
  "invoke",
  "api:GET:/api/users",
);

await menu.close();
await pc.close();
```

Menu and button visibility is an experience layer, not the final security boundary. Backend routes should still call `assertSubject()` or the vext adapter guard for `api:` resources.

## vext Adapter

Use `permission-core/adapters/vext` inside a vext app to attach permission-core to `req.auth.can/assert`, import route manifests, and expose `permissionCore` through a plugin-like object. The main package does not runtime import `vextjs`; `vextjs` is an optional peer for vext applications.

## Recommended Stack

- Cache backend: `cache-hub`
- Production storage: `MonSQLizeStorageAdapter`
- Verified dependency line: `cache-hub@2.2.4 + monsqlize@2.0.3`
- Lightweight fallback storage: `FileAdapter` and `MemoryAdapter`
- Design principle: keep `StorageAdapter` abstract. permission-core is not tied to MongoDB even though the official production adapter uses monsqlize.

## Role Inspection APIs

For role detail pages, debugging panels, or integration diagnostics, use:

- `roles.getRoleChain(roleId)` to read the current role and its parent chain.
- `roles.getEffectiveRules(roleId)` to read inherited effective rules.
- `roles.inspect(roleId)` to return `role`, `ownRules`, `effectiveRules`, and `roleChain` in one call.

## Documentation Entry Points

- Documentation site: <https://vextjs.github.io/permission-core>
- Quick start: `website/docs/guide/quick-start.md`
- Production deployment: `website/docs/guide/production-deployment.md`
- Compatibility matrix: `website/docs/guide/compatibility-matrix.md`
- Resource paths: `website/docs/guide/resource-paths.md`
- Menu permissions: `website/docs/guide/menu-permissions.md`
- Multi-tenant permissions: `website/docs/guide/multi-tenant.md`
- vext adapter: `website/docs/guide/vext-adapter.md`
- API reference: `website/docs/api/permission-core.md`
- Menu API: `website/docs/api/menu.md`
- Scoped permissions API: `website/docs/api/scoped-permissions.md`
- vext adapter API: `website/docs/api/vext-adapter.md`
- Examples: `website/docs/examples/basic.md`
- Runnable examples: `examples/README.md`
- Chinese documentation: `website/docs/zh/**`

Recommended reading order:

1. `website/docs/guide/quick-start.md`
2. `website/docs/guide/faq.md`
3. `website/docs/guide/resource-paths.md`
4. `website/docs/guide/roles-and-rules.md`
5. `website/docs/guide/check-permission.md`
6. Choose `menu-permissions.md`, `multi-tenant.md`, or `vext-adapter.md` when that capability is part of your application.
7. `website/docs/guide/integration-checklist.md`

If you are ready to write integration code, continue with `website/docs/guide/implementation-reading-order.md`.

## Security and Compatibility

- Security policy: `SECURITY.md`
- Runtime and dependency support: `website/docs/guide/compatibility-matrix.md`
- Production deployment guidance: `website/docs/guide/production-deployment.md`

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
npm run example:menu
npm run example:multi-tenant
npm run example:vext
```

## Current Boundary

- Public docs cover integration paths, resource modeling, runtime APIs, management APIs, cache semantics, and common integration patterns.
- Optional subpaths expose `permission-core/menu` and `permission-core/adapters/vext`; both are built and tested as public package exports.
- Security, production deployment, and compatibility docs explain how to use the authorization core safely, but they do not replace your own authentication, secrets, logging, compliance, or audit controls.
- For the most detailed API surface, continue with `website/docs/api/**` and `website/docs/examples/**`.
