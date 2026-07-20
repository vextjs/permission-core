# Menus API

## Purpose and preconditions

`scoped.menus.config` manages an admin menu config. The public entry is `MenuConfigInput`, which stores menus, views, load APIs, action APIs, and response fields as a grantable config snapshot. `subject.menus` is the user runtime entry; it projects visible views, action state, view state, and response fields from the same config.

Before using it:

- `pc.init()` has completed.
- `pc.scope(scope)` has created a trusted scoped management context.
- Runtime projection uses `pc.forSubject({ userId, scope })`.

## What Do You Want to Do?

| Goal | First API | Notes |
|---|---|---|
| Preview menu config | `menus.config.preview(config, options?)` | Validate menus, views, APIs, response fields, capacity, and conflicts before writing. |
| Save menu config | `menus.config.save(config, options)` | Commit the previewed config with `expected` and `previewToken`. |
| Read config | `menus.config.get(configId)` / `menus.config.list(query?)` | Use these for management UI detail and list pages. |
| Delete config | `menus.config.previewRemove(configId)` / `menus.config.remove(configId, options)` | Preview first so deleted views, actions, loads, and response fields can revoke sources safely. |
| Batch changes | `menus.config.previewChanges(changes)` / `menus.config.applyChanges(changes, options)` | Use when multiple configs share one endpoint and must change atomically. |
| Project user menus | `subject.menus.getViewTree()`, `getActionMap()`, `getViewState()`, `filterResponse()` | Runtime APIs read effective user permissions and return UI or response projections. |

## Signatures

```ts
menus.config.preview(config: MenuConfigInput, options?: MenuConfigPreviewOptions): Promise<ImpactPreview<MenuConfigPlan>>
menus.config.save(config: MenuConfigInput, options: MenuConfigSaveOptions): Promise<MutationResult<MenuConfigSaveResult>>
menus.config.get(configId: string): Promise<VersionedResult<MenuConfigSnapshot>>
menus.config.list(query?: MenuConfigListQuery): Promise<PageResult<MenuConfigSummary>>
menus.config.previewRemove(configId: string, options?: MenuConfigPreviewOptions): Promise<ImpactPreview<MenuConfigRemovePlan>>
menus.config.remove(configId: string, options: MenuConfigRemoveOptions): Promise<MutationResult<MenuConfigRemoveResult>>
menus.config.previewChanges(changes: NonEmptyMenuConfigChangeArray, options?: MenuConfigPreviewOptions): Promise<ImpactPreview<MenuConfigChangeSetPlan>>
menus.config.applyChanges(changes: NonEmptyMenuConfigChangeArray, options: MenuConfigChangeSetOptions): Promise<MutationResult<MenuConfigChangeSetResult>>

subject.menus.getViewTree(options: { configId: string }): Promise<SubjectRuntimeResult<readonly ViewTreeNode[]>>
subject.menus.getActionMap(input: { configId: string; viewId: string }): Promise<SubjectRuntimeResult<Readonly<Record<string, ActionPermissionState>>>>
subject.menus.getViewState(input: { configId: string; viewId: string } | { path: string }): Promise<SubjectRuntimeResult<ViewPermissionState>>
subject.menus.filterResponse(apiResource: ApiResource, payload: unknown): Promise<SubjectRuntimeResult<unknown>>
```

Signature markers: `config: MenuConfigInput`, `options: MenuConfigSaveOptions`, `changes: NonEmptyMenuConfigChangeArray`.

## Parameters

<!-- docs:params owner=MenuConfigInput locale=en -->

### `MenuConfigInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `configId` | `string` | Required | Stable ID for one menu config. Role grants and runtime reads use it. |
| `title` | `string` | Optional | Display name for management UI. |
| `menus` | `MenuConfigMenuInput[]` | Required, at least one | Top-level menu groups or menu entries. |
| `meta` | `Record<string, PolicyValue>` | Optional | Serializable metadata for admin or frontend use. |

### `MenuConfigMenuInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `id` | `string` | Required | Stable unique menu ID inside this config. |
| `title` | `string` | Required | Menu title. |
| `children` | `MenuConfigMenuInput[]` | Optional | Child menus. |
| `views` | `MenuViewInput[]` | Optional | Pages, drawers, dialogs, or tabs under the menu. |
| `navigation` | `boolean` | Default `true` | Whether it appears in navigation. |
| `enabled` | `boolean` | Default `true` | Whether it is active. |
| `icon/i18nKey/meta` | Display metadata | Optional | Consumed by the frontend; not part of authorization logic. |

### `MenuViewInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `id` | `string` | Required | Stable unique view ID inside this config. |
| `type` | `page/dialog/drawer/tab/...` | Required | View type. |
| `title` | `string` | Required | View title. |
| `path` | `string` | Common for pages | Frontend route path; can also be used with `getViewState({ path })`. |
| `component/url` | `string` | Depends on type | Frontend component or external URL. |
| `load` | `MenuLoadInput[]` | Default `[]` | APIs called when entering the view. |
| `actions` | `MenuActionInput[]` | Default `[]` | Page buttons or operations. |
| `navigation/enabled/i18nKey/meta` | View metadata | Optional | Controls navigation and extra frontend metadata. |

`load.resource: ApiResource` must look like `api:GET:/api/orders`. `actions[].resource: ApiResource | UiResource` can point to a backend API or frontend UI capability. `response?: ResponseProjectionConfigInput` can be declared on loads or actions; see [Configure APIs and Response Fields API](/api/api-bindings).

## Configuration methods

<span id="menus-config-preview"></span>
### `menus.config.preview(config, options?)`

<!-- docs:method name=menus.config.preview locale=en -->

- **Purpose**: Validate a menu config before saving and preview its impact on internal menus, APIs, response fields, and existing role grants.
- **Parameters**: `config` is the complete `MenuConfigInput`; `options` can include `actorId/reason/detailBudget`.
- **State impact**: Read-only; no config is written.
- **Raw return**: `ImpactPreview<MenuConfigPlan>`; inspect `executable`, `conflicts`, `plan.after`, `expected`, and `previewToken`.

<span id="menus-config-save"></span>
### `menus.config.save(config, options)`

<!-- docs:method name=menus.config.save locale=en -->

- **Purpose**: Commit a previously previewed menu config.
- **Parameters**: `config` must match the preview; `options` must include `expected` and `previewToken`, and may include `actorId/idempotencyKey`.
- **State impact**: Writes `_menu_configs`, synchronizes internal menu nodes, endpoint contracts, response-field indexes, and affected role sources.
- **Raw return**: `MutationResult<MenuConfigSaveResult>`; the config snapshot is in `data.config`, and internal write summary is in `data.manifestOperations`.

<span id="menus-config-get"></span>
### `menus.config.get(configId)`

<!-- docs:method name=menus.config.get locale=en -->

- **Purpose**: Read the latest snapshot for one config.
- **Parameters**: `configId` is the config ID.
- **State impact**: Read-only.
- **Raw return**: `VersionedResult<MenuConfigSnapshot>`; `data.revision` can be shown as the management version.

<span id="menus-config-list"></span>
### `menus.config.list(query?)`

<!-- docs:method name=menus.config.list locale=en -->

- **Purpose**: Page through menu config summaries in the current scope.
- **Parameters**: `query` can include `configId/first/after`.
- **State impact**: Read-only.
- **Raw return**: `PageResult<MenuConfigSummary>` with `menuCount/viewCount/actionCount/responseFieldCount`.

<span id="menus-config-preview-remove"></span>
### `menus.config.previewRemove(configId, options?)`

<!-- docs:method name=menus.config.previewRemove locale=en -->

- **Purpose**: Preview which assets and role grants would be removed with a config.
- **Parameters**: `configId` and optional preview context.
- **State impact**: Read-only; nothing is deleted.
- **Raw return**: `ImpactPreview<MenuConfigRemovePlan>`; inspect `removedAssets`, `revokedGrants`, `affectedRoles`, and `affectedUsers`.

<span id="menus-config-remove"></span>
### `menus.config.remove(configId, options)`

<!-- docs:method name=menus.config.remove locale=en -->

- **Purpose**: Execute a previewed config removal.
- **Parameters**: `configId` must match the preview; `options` carries `expected/previewToken`.
- **State impact**: Deletes the config snapshot, removes internal assets, and revokes grants that depend on the config.
- **Raw return**: `MutationResult<MenuConfigRemoveResult>`.

<span id="menus-config-preview-changes"></span>
### `menus.config.previewChanges(changes, options?)`

<!-- docs:method name=menus.config.previewChanges locale=en -->

- **Purpose**: Preview saving or removing multiple configs in one batch.
- **Parameters**: `changes: NonEmptyMenuConfigChangeArray`, each item being `{ operation: 'save', config }` or `{ operation: 'remove', configId }`.
- **State impact**: Read-only.
- **Raw return**: `ImpactPreview<MenuConfigChangeSetPlan>`; use it for plugin installation, module upgrades, or bulk imports.

<span id="menus-config-apply-changes"></span>
### `menus.config.applyChanges(changes, options)`

<!-- docs:method name=menus.config.applyChanges locale=en -->

- **Purpose**: Atomically commit previewed config changes.
- **Parameters**: Original `changes` plus preview `expected/previewToken`.
- **State impact**: Saves/removes configs and synchronizes all internal menu and API assets.
- **Raw return**: `MutationResult<MenuConfigChangeSetResult>`.

## Runtime methods

<span id="subject-menus-get-view-tree"></span>
### `subject.menus.getViewTree(options)`

<!-- docs:method name=subject.menus.getViewTree locale=en -->

- **Purpose**: Return the current user's visible navigation tree for a config.
- **Parameters**: `options.configId` selects the menu config.
- **State impact**: Read-only; projected from the user's effective roles and menu grants.
- **Raw return**: `SubjectRuntimeResult<readonly ViewTreeNode[]>`; actions are not returned as tree nodes.

<span id="subject-menus-get-action-map"></span>
### `subject.menus.getActionMap(input)`

<!-- docs:method name=subject.menus.getActionMap locale=en -->

- **Purpose**: Return visibility, enabled state, and reason for each action in a view.
- **Parameters**: `input.configId` and `input.viewId`.
- **State impact**: Read-only.
- **Raw return**: `SubjectRuntimeResult<Record<string, ActionPermissionState>>`; keys are action IDs.

<span id="subject-menus-get-view-state"></span>
### `subject.menus.getViewState(input)`

<!-- docs:method name=subject.menus.getViewState locale=en -->

- **Purpose**: Check whether the current user may enter a view.
- **Parameters**: Pass `{ configId, viewId }` or `{ path }`.
- **State impact**: Read-only.
- **Raw return**: `SubjectRuntimeResult<ViewPermissionState>`; `allowed` is permission state and `navigationReachable` is navigation reachability.

<span id="subject-menus-filter-response"></span>
### `subject.menus.filterResponse(apiResource, payload)`

<!-- docs:method name=subject.menus.filterResponse locale=en -->

- **Purpose**: Project an API payload according to the current user's response-field grants.
- **Parameters**: `apiResource` is `api:METHOD:/path`; `payload` is the data about to be returned.
- **State impact**: Read-only, but it first checks whether the user can `invoke` the `apiResource`.
- **Raw return**: `SubjectRuntimeResult<unknown>` with the projected response in `data`.

## Responses and side effects

Saving a config returns a mutation envelope, audit ID, revision, cache invalidation result, and internal synchronization summary. Runtime methods do not write to the database; they return `SubjectRuntimeResult<T>`, where `data` is what the frontend uses and `detailBudget` is diagnostic information.

```json
{
  "changed": true,
  "data": {
    "config": { "configId": "admin", "revision": 1 },
    "manifestOperations": { "total": 3 },
    "retainedGrantCount": 0,
    "revokedGrantCount": 0
  },
  "auditId": "audit_..."
}
```

## Failures and limits

Common failures include missing or duplicate config IDs, invalid resource format, invalid response-field paths, stale preview token, revision conflict, and capacity limits. `load.resource` must be an `api:` resource. Response-field grants can only select fields declared by the config. Saving a config does not grant any role or user access.

## Example

```ts
const menuConfig = {
  configId: 'admin',
  menus: [{
    id: 'orders',
    title: 'Orders',
    views: [{
      id: 'orders-list',
      type: 'page',
      title: 'Orders',
      path: '/orders',
      component: 'OrdersPage',
      load: [{
        resource: 'api:GET:/api/orders',
        response: {
          target: 'items',
          preserve: ['total'],
          fields: [{ field: 'orderNo', title: '订单号' }],
        },
      }],
    }],
  }],
};

const preview = await scoped.menus.config.preview(menuConfig, { actorId: 'admin' });
if (!preview.executable) throw new Error('resolve menu config conflicts first');

const saved = await scoped.menus.config.save(menuConfig, {
  ...preview.expected,
  previewToken: preview.previewToken,
  actorId: 'admin',
});

const menus = pc.forSubject({ userId: 'u-menu', scope }).menus;
const tree = await menus.getViewTree({ configId: 'admin' });
const view = await menus.getViewState({ configId: 'admin', viewId: 'orders-list' });
const projected = await menus.filterResponse('api:GET:/api/orders', payload);
```

```json
{
  "tree": [{ "id": "orders", "enabled": true }],
  "view": { "allowed": true, "view": { "id": "orders-list" } },
  "projected": {
    "items": [{ "orderNo": "O-1001", "status": "paid" }],
    "total": 1
  }
}
```

## Related

See [Manage Menus](/guide/menu-management), [Configure APIs and Response Fields](/guide/api-bindings), and [Role Menu Permissions API](/api/role-menu-permissions).
