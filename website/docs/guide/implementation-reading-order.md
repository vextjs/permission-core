# Implementation Reading Order

If you are wiring permission-core into a real service, read in this order.

First choose the smallest integration path that proves your user flow. Do not start with a custom adapter, management UI, or framework plugin before one role, one user binding, one allow decision, and one denial are observable.

## First pass

1. [Quick Start](/guide/quick-start)
2. [Resource Paths](/guide/resource-paths)
3. [Permission Checks](/guide/check-permission)
4. [Roles and Rules](/guide/roles-and-rules)
5. [FAQ](/guide/faq)

## Data permission pass

1. [Row-level Permissions](/guide/row-level)
2. [Field Filtering](/guide/field-filter)
3. [Storage Adapters](/guide/adapters)
4. [Production Deployment](/guide/production-deployment)

Exit this pass only after collection authorization, row predicates, and field filtering are separate in code. For large datasets, the database query consumes `getRowScope()` before `filterRows()` performs a final check.

## Management pass

1. [Menu Permissions](/guide/menu-permissions)
2. [Menu Module API](/api/menu)
3. [Management Console](/guide/site-preview-release)
4. [Error Response Mapping](/guide/error-response-mapping)
5. [Management Backend Example](/examples/management-backend)
6. [RoleManager API](/api/role-manager)
7. [UserRoleManager API](/api/user-roles)

The management backend owns validation, diffing, optimistic revision checks, and audit context. Browser forms should not call low-level storage writes or issue a long sequence of uncoordinated rule mutations.

## Tenant pass

1. [Multi-tenant Permissions](/guide/multi-tenant)
2. [Scoped Permissions API](/api/scoped-permissions)
3. Run `npm run example:multi-tenant` and verify that a subject allowed in tenant A is denied in tenant B.
4. Confirm that core and menu storage, cache keys, revisions, and audits use the same exact scope.

## Vext pass

1. [vext Adapter](/guide/vext-adapter)
2. [vext Adapter API](/api/vext-adapter)
3. [vext Example](/examples/vext)
4. Run `npm run example:vext` and verify `200` plus `403 AUTH_FORBIDDEN` in a real TestApp.
5. Keep authentication before permission middleware and leave `guardRoutePermissions` enabled unless another proven guard consumes the same metadata.

## Final production pass

1. [Integration Checklist](/guide/integration-checklist)
2. [Storage Adapters](/guide/adapters)
3. [Production Deployment](/guide/production-deployment)
4. Run `npm run test:docs`, `npm run example:all`, and the project release gate.

The final evidence should include an allowed and denied request, a cross-tenant denial when scoped APIs are enabled, restart persistence for both core and menu stores, graceful shutdown, and a package consumer smoke rather than only a source-tree test result.
