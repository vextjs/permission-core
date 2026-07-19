# Menu Module API

The optional menu module models directories, menus, pages, buttons, backend API bindings, authorization trees, revisions, and audit events.

## Purpose and import

```typescript
import { createMenuPermission } from 'permission-core/menu';
```

Use menu state for navigation and authorization editors. Backend routes still perform final authorization through the core or a framework guard.

## Construction and types

`createMenuPermission(options: MenuPermissionOptions): MenuPermissionManager` requires `core`. Optional fields are `storage`, `strictApiBindings`, `cache`, and `extensions`.

Defaults are `MemoryMenuStorageAdapter`, `strictApiBindings:false`, enabled snapshot cache, and `maxEntries:500`. Built-in persistent choices are `FileMenuStorageAdapter` and `MonSQLizeMenuStorageAdapter`.

## Signature index

| Group | Methods |
|---|---|
| Lifecycle | `init`; `close`; `invalidateMenu` |
| Visibility | `getVisibleMenuTree`; `getVisibleMenuSnapshot`; `getVisibleButtons`; `getButtonPermissionSnapshot`; `getRoutePermission` |
| Import | `importFrontendManifest`; `importApiManifest`; loader-based variants |
| Validation | `validate(scope)` |
| Authorization | `getAuthorizationTree`; `saveRoleAuthorization` |
| Audit | `listAuditEntries` |

Storage adapters expose list/upsert/replace methods for nodes and API bindings plus revision and audit methods.

## Behavior and defaults

Manifests are scope-aware, revisioned configuration. `replace` is an authoritative snapshot; `merge` is for explicit partial ownership. Related API bindings can share `permissionGroup` and select `permissionMode: "any" | "all"`.

`saveRoleAuthorization()` validates assets, writes core rules, appends audit, and attempts compensation on partial failure. Snapshots include `version` and `etag`.

Authorization-tree nodes expose `sourceRoleIds` so inherited and conflicting states remain explainable. Custom resource schemes must be registered through `core.resourceSchemes.register()` before menu validation.

## Errors and limits

Invalid trees, bindings, schemes, or authorization input fail with `INVALID_ARGUMENT`. Missing roles use `ROLE_NOT_FOUND`; persistence and compensation failures use `STORAGE_ERROR`. A closed manager is not reusable.

Menu visibility never authorizes the backend by itself. Core and menu storage are separate. File storage is single-process; a shared MonSQLize connection must have exactly one owner.

## Minimal example

```typescript
const menu = createMenuPermission({
  core: pc,
  strictApiBindings: true,
});

await menu.init();
const tree = await menu.getVisibleMenuTree(subject);
await menu.close();
```

## Related

See [Menu Permissions](/guide/menu-permissions), [Management Console](/guide/site-preview-release), and [Management Backend Example](/examples/management-backend).
