# Menu Module API

Import from `permission-core/menu`.

```ts
import {
  createMenuPermission,
  MemoryMenuStorageAdapter,
} from "permission-core/menu";
```

Main APIs:

| API | Purpose |
|---|---|
| `createMenuPermission({ core, storage, strictApiBindings })` | Create the menu permission manager |
| `getVisibleMenuTree(subject)` | Return the menu tree visible to a subject |
| `getVisibleButtons(subject, pageId)` | Return page button states |
| `getRoutePermission(subject, path)` | Check direct page route access |
| `getAuthorizationTree(scope, roleId)` | Build a role authorization tree |
| `saveRoleAuthorization(scope, roleId, input)` | Save allow/deny/revoke changes through `RoleManager` |
| `importFrontendManifest(scope, manifest)` | Import menu/page/button assets |
| `importApiManifest(scope, manifest)` | Import API bindings |
| `validate(scope)` | Return configuration diagnostics |
| `listAuditEntries(scope)` | Read audit records |

## Construction and lifecycle

```ts
createMenuPermission(options: MenuPermissionOptions): MenuPermissionManager
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `core` | `PermissionCore` | required | Initialized authorization runtime |
| `storage` | `MenuPermissionStorageAdapter` | `MemoryMenuStorageAdapter` | Menu/API/audit/revision persistence |
| `strictApiBindings` | `boolean` | `false` | Disable a visible button when a required API permission is missing |
| `cache` | `false \| { maxEntries?: number }` | enabled, 500 entries | Tree/button snapshot cache |
| `extensions` | `MenuPermissionExtensionRegistry` | empty registry | Manifest loaders, normalizers, validators |

Call `await manager.init()` when the application initializes resources explicitly. All public methods also initialize the storage lazily. `close()` is idempotent, closes the menu storage, clears snapshots, and makes later calls fail with `NOT_INITIALIZED`.

## Read APIs

```ts
getVisibleMenuTree(subject, options?): Promise<VisibleMenuNode[]>
getVisibleMenuSnapshot(subject, options?): Promise<MenuPermissionSnapshot<VisibleMenuNode[]>>
getVisibleButtons(subject, pageId, options?): Promise<ButtonPermissionMap>
getButtonPermissionSnapshot(subject, pageId, options?): Promise<MenuPermissionSnapshot<ButtonPermissionMap>>
getRoutePermission(subject, path): Promise<RoutePermissionState>
```

Snapshots contain `{ data, version, etag }`. The version combines storage revision and the effective permission hash. Route checks select `page > menu > external/iframe`; two same-priority targets fail with `reason: "route-conflict"`.

`ButtonPermissionState.reason` is one of `permission-denied`, `required-api-denied`, `disabled`, or `not-found`. Required API bindings use `permissionGroup` plus `permissionMode: "any" | "all"`; ungrouped bindings preserve historical all-required behavior.

## Manifest APIs

```ts
importFrontendManifest(scope, manifest, options?): Promise<{
  nodes: ImportSummary;
  apiBindings?: ImportSummary;
}>
importApiManifest(scope, manifest, options?): Promise<ImportSummary>
loadFrontendManifest(scope, loaderName, source, options?): Promise<...>
loadApiManifest(scope, loaderName, source, options?): Promise<ImportSummary>
```

`ManifestImportOptions` supports `mode`, `actorId`, and `reason`. `mode` defaults to `replace`; `merge` only upserts incoming IDs. `ImportSummary` contains counts, monotonic `revision`, and `changes.insertedIds/updatedIds/deletedIds`.

The complete candidate configuration is validated before mutation. A write or audit failure restores both node and API binding sets. A failed compensation throws `STORAGE_ERROR` with the original and compensation causes.

## Role authorization and audit

```ts
getAuthorizationTree(scope, roleId): Promise<AuthorizationTreeNode[]>
saveRoleAuthorization(scope, roleId, input): Promise<PermissionAuditEntry>
listAuditEntries(scope): Promise<PermissionAuditEntry[]>
validate(scope): Promise<MenuValidationDiagnostic[]>
invalidateMenu(scope?): Promise<void>
```

Tree states are `allow`, `deny`, `inherit-allow`, `inherit-deny`, `conflict`, or `none`. `sourceRoleIds` identifies the rules that produced the state.

`saveRoleAuthorization()` accepts `allow`, `deny`, `revoke`, `actorId`, and `reason`. It rejects unknown assets and same-request allow/deny conflicts, writes a stable added/removed diff, appends `role-authorization.save`, and restores the previous rules if apply or audit persistence fails.

## Storage adapters

| Adapter | Intended use | Persistence and ownership |
|---|---|---|
| `MemoryMenuStorageAdapter` | tests and short examples | process memory only |
| `FileMenuStorageAdapter({ path })` | single-process deployment | schema-versioned atomic file replacement; one process/writer |
| `MonSQLizeMenuStorageAdapter({ msq, namespace?, ownsConnection? })` | shared production database | scoped collections, indexes, revisions, audits, serialized instance mutations |

`MenuPermissionStorageAdapter` must implement node and API list/upsert/replace, `getRevision`, audit list/append, and optional `init/close`. Scope is mandatory on every method. The manager compensation protocol protects cross-store operations; database-level multi-process transactions remain the responsibility of the supplied storage platform.

## Extension registry

`MenuPermissionExtensionRegistry` exposes `registerFrontendLoader`, `registerApiLoader`, `registerNodeNormalizer`, `registerApiBindingNormalizer`, and `registerValidator`. Loaders are selected by unique name. Normalizers run in registration and asset order. Built-in validation always runs before custom validators and cannot be removed.

Custom resource schemes are registered through `core.resourceSchemes.register({ scheme, validate, match })`; the same registry is used by role writes, checks, menu validation, and authorization trees.

## Errors

| Code | Typical cause |
|---|---|
| `NOT_INITIALIZED` | Core was not initialized or menu manager was closed |
| `INVALID_ARGUMENT` | Invalid manifest, unknown asset/loader, duplicate IDs, conflicting authorization, unsupported extension contract |
| `INVALID_RESOURCE_PATH` / `INVALID_ACTION` | Invalid permission metadata |
| `ROLE_NOT_FOUND` | Authorization targets a missing role |
| `STORAGE_ERROR` | Persistence failed; message states whether compensation restored the previous state |

For a complete task flow, start with [Menu Permissions](/guide/menu-permissions).
