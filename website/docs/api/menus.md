# Menus API

## Purpose and preconditions

`scoped.menus` manages admin menu configs. Admin pages should prefer `configs/items/views/loadApis/actions/responses` to create menus, views, APIs, actions, and response fields incrementally. Config-as-code or plugin installation can still use `menus.config.*` to save a complete `MenuConfigInput`. `subject.menus` is the user runtime entrypoint; it projects visible views, action state, view state, and response-field filtering from the same config.

Before using it:

- `pc.init()` has completed.
- `pc.scope(scope, defaults?)` has created a trusted scoped management context; admin requests can bind `actorId/requestId` in `defaults`.
- Runtime projection uses `pc.forSubject({ userId, scope })`.

## What Do You Want to Do?

| Goal | First API | Notes |
|---|---|---|
| Create an empty config | `menus.configs.previewCreate(input)` / `menus.configs.create(input)` | Start a menu config first, then add menus and views incrementally. |
| Read the complete menu tree | `menus.configs.get(configId)` / `menus.config.get(configId)` | Returns `MenuConfigSnapshot`; the full tree is in `data.menus`. |
| Create menus, views, APIs, actions, and fields | `menus.items.*`, `menus.views.*`, `menus.loadApis.*`, `menus.actions.*`, `menus.responses.*` | Low-cognitive-load object methods for admin UI forms. |
| Commit several menu changes at once | `menus.management.applyChanges(configId, changes)`; call `previewChanges()` first when the UI needs to show impact | Use when one form saves multiple changes. Ordinary safe changes auto-preview and commit. |
| Preview menu config | `menus.config.preview(config, options?)` | Validate menus, views, APIs, response fields, capacity, and conflicts before saving. |
| Save menu config | `menus.config.save(config, options)` | Commit with `expected` and `previewToken` returned by preview. |
| List configs | `menus.configs.list(query?)` / `menus.config.list(query?)` | Pages through summaries for multiple configs; it does not return menu tree nodes. |
| Delete config | `menus.config.previewRemove(configId)` / `menus.config.remove(configId, options)` | Preview deletion impact first, then safely remove deleted sources. |
| Batch changes | `menus.config.previewChanges(changes)` / `menus.config.applyChanges(changes, options)` | Use when multiple configs share one endpoint and must change atomically. |
| Project user menus | `subject.menus.getViewTree()`, `getActionMap()`, `getViewState()`, `filterResponse()` | Request-time runtime APIs that return UI state or response projections. |

## Signatures

```ts
menus.management.previewChanges(configId: string, changes: NonEmptyMenuManagementChangeArray, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.management.applyChanges(configId: string, changes: NonEmptyMenuManagementChangeArray, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>

menus.configs.previewCreate(input: MenuConfigCreateInput, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.configs.create(input: MenuConfigCreateInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.configs.previewUpdate(configId: string, patch: MenuConfigUpdateInput, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.configs.update(configId: string, patch: MenuConfigUpdateInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.configs.get(configId: string): Promise<VersionedResult<MenuConfigSnapshot>>
menus.configs.list(query?: MenuConfigListQuery): Promise<PageResult<MenuConfigSummary>>
menus.configs.previewRemove(configId: string, input?: MenuManagementRemoveInput, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.configs.remove(configId: string, input?: MenuManagementRemoveInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>

menus.items.previewCreate(configId: string, input: MenuItemCreateInput, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.items.create(configId: string, input: MenuItemCreateInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.views.previewCreate(configId: string, menuId: string, input: MenuViewCreateInput, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.views.create(configId: string, menuId: string, input: MenuViewCreateInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.loadApis.previewAdd(configId: string, viewId: string, input: MenuLoadApiAddInput, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.loadApis.add(configId: string, viewId: string, input: MenuLoadApiAddInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.actions.previewCreate(configId: string, viewId: string, input: MenuActionCreateInput, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.actions.create(configId: string, viewId: string, input: MenuActionCreateInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>
menus.responses.previewSet(configId: string, input: MenuResponseSetInput, options?: MenuManagementPreviewOptions): Promise<ImpactPreview<MenuManagementPlan>>
menus.responses.set(configId: string, input: MenuResponseSetInput, options?: MenuManagementExecuteOptions): Promise<MutationResult<MenuManagementResult>>

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

Signature markers: `configId` locates one menu config; `changes: NonEmptyMenuManagementChangeArray` is an incremental change set; `config: MenuConfigInput` is a complete batch config.

`MenuManagementExecuteOptions` has two shapes:

```ts
// Normal admin save: automatic internal preview and commit; requestId derives the idempotency key.
{ actorId?: string; reason?: string; requestId?: string; idempotencyKey?: string }

// Explicit preview confirmation: cascade delete, grant-revoking delete, capacity risk, or UI impact review.
{ ...preview.expected, previewToken: preview.previewToken, actorId?: string, requestId?: string, idempotencyKey?: string }
```

Do not pass only half of the explicit-preview pair: `previewToken` without `expectedRevisions`, or `expectedRevisions` without `previewToken`, returns `INVALID_ARGUMENT`. `menus.config.save/remove/applyChanges` are the legacy full-config batch entrypoints and still require preview `expected/previewToken`.

Object methods also include matching `previewUpdate/update/previewRemove/remove` methods. Their signatures mirror `previewCreate/create` and add the target `menuId/viewId/resource/actionId`.

## Parameters

<!-- docs:params owner=MenuConfigInput locale=en -->

### Incremental management inputs

| Type | Required fields | Meaning |
|---|---|---|
| `MenuConfigCreateInput` | `configId` | Create an empty menu config; optional `title/meta`. |
| `MenuItemCreateInput` | `id/title` | Create a menu; optional `parentId/icon/navigation/enabled/meta`. Omit `parentId` for a top-level menu. |
| `MenuViewCreateInput` | `id/type/title`; pages usually also need `path/component` | Create a page, drawer, dialog, tab, iframe, or external-link view. |
| `MenuLoadApiAddInput` | `resource` | Add a page load API; format is `api:METHOD:/path`, and the system uses `invoke` automatically. |
| `MenuActionCreateInput` | `title/resource` | Add a button or operation; `resource` can be `api:*` or `ui:button:*`. |
| `MenuResponseSetInput` | `owner/response` | Configure response fields for a load or API action; `owner` points to the API source. |
| `MenuManagementExecuteOptions` | Auto mode or explicit-confirmation mode | Ordinary incremental writes should bind `actorId/requestId` with `pc.scope(scope, defaults)` and can omit per-call `options`. `idempotencyKey` is only an advanced override. Cascade delete, grant-revoking delete, or capacity risk uses preview `expectedRevisions/previewToken`. |

`MenuResponseSetInput.owner` has three forms:

```ts
{ ownerType: 'load', viewId: 'orders-list', resource: 'api:GET:/api/orders' }
{ ownerType: 'action', viewId: 'orders-list', actionId: 'export' }
{ ownerType: 'api', apiResource: 'api:GET:/api/orders' }
```

`ownerType: 'api'` matches a load or API action in the current config that declares the API. When the admin UI can locate the exact page, prefer `load` or `action`; errors are easier to diagnose.

### `MenuConfigInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `configId` | `string` | Required | Stable ID for one menu config. Grants and runtime reads use it. |
| `title` | `string` | Optional | Display name for management UI. |
| `menus` | `MenuConfigMenuInput[]` | Required, at least one | Top-level menu groups or menu entries. |
| `meta` | `Record<string, PolicyValue>` | Optional | Serializable metadata passed to admin or frontend code. |

### `MenuConfigMenuInput`

| Field | Type | Required/default | Meaning |
|---|---|---|---|
| `id` | `string` | Required | Stable unique menu ID inside this config. |
| `title` | `string` | Required | Menu title. |
| `children` | `MenuConfigMenuInput[]` | Optional | Child menus. |
| `views` | `MenuViewInput[]` | Optional | Pages, drawers, dialogs, or tabs under this menu. |
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

## Method details: config management

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
- **Parameters**: `config` must match the preview; `options` must include `expected` and `previewToken`, and may include `actorId/requestId`; `idempotencyKey` only overrides the default idempotency strategy for advanced integrations.
- **State impact**: Writes `_menu_configs`, synchronizes internal menu nodes, endpoint contracts, response-field indexes, and affected role sources.
- **Raw return**: `MutationResult<MenuConfigSaveResult>`; the config snapshot is in `data.config`, and internal write summary is in `data.manifestOperations`.

<span id="menus-config-get"></span>
### `menus.config.get(configId)`

<!-- docs:method name=menus.config.get locale=en -->

- **Purpose**: Read the latest snapshot for one config; use this when a management UI needs the complete menu tree.
- **Parameters**: `configId` is the config ID.
- **State impact**: Read-only.
- **Raw return**: `VersionedResult<MenuConfigSnapshot>`; the complete tree is in `data.menus` and includes menus, child menus, views, load APIs, actions, and response-field config. `data.revision` can be shown as management UI version information.

<span id="menus-config-list"></span>
### `menus.config.list(query?)`

<!-- docs:method name=menus.config.list locale=en -->

- **Purpose**: Page through menu config summaries in the current scope.
- **Parameters**: `query` can include `configId/first/after`.
- **State impact**: Read-only.
- **Raw return**: `PageResult<MenuConfigSummary>`; summaries include `menuCount/viewCount/actionCount/responseFieldCount`. This lists multiple configs, not menu tree nodes inside one config; read the full tree with `menus.configs.get(configId)` or `menus.config.get(configId)`.

<span id="menus-config-preview-remove"></span>
### `menus.config.previewRemove(configId, options?)`

<!-- docs:method name=menus.config.previewRemove locale=en -->

- **Purpose**: Preview which config assets would be removed when deleting a menu config.
- **Parameters**: `configId` plus optional preview context.
- **State impact**: Read-only; nothing is deleted.
- **Raw return**: `ImpactPreview<MenuConfigRemovePlan>`; inspect `removedAssets`. Deleting the config snapshot does not automatically rewrite role-menu grants; stale historical grants are handled by role-menu read and repair flows.

<span id="menus-config-remove"></span>
### `menus.config.remove(configId, options)`

<!-- docs:method name=menus.config.remove locale=en -->

- **Purpose**: Execute a previously previewed config deletion.
- **Parameters**: `configId` must match the preview; `options` carries `expected/previewToken`.
- **State impact**: Deletes the config snapshot and removes internal menu/API assets; does not automatically revoke role-menu grants.
- **Raw return**: `MutationResult<MenuConfigRemoveResult>`.

<span id="menus-config-preview-changes"></span>
### `menus.config.previewChanges(changes, options?)`

<!-- docs:method name=menus.config.previewChanges locale=en -->

- **Purpose**: Preview saving or deleting several configs at once.
- **Parameters**: `changes: NonEmptyMenuConfigChangeArray`; each item is `{ operation: 'save', config }` or `{ operation: 'remove', configId }`.
- **State impact**: Read-only.
- **Raw return**: `ImpactPreview<MenuConfigChangeSetPlan>`; use it before plugin installation, module upgrades, or batch imports.

<span id="menus-config-apply-changes"></span>
### `menus.config.applyChanges(changes, options)`

<!-- docs:method name=menus.config.applyChanges locale=en -->

- **Purpose**: Atomically commit a previously previewed batch config change.
- **Parameters**: Original `changes` plus preview `expected/previewToken`.
- **State impact**: Saves/deletes configs in a batch and synchronizes all internal menu and API assets.
- **Raw return**: `MutationResult<MenuConfigChangeSetResult>`.

## Method details: user runtime

<span id="subject-menus-get-view-tree"></span>
### `subject.menus.getViewTree(options)`

<!-- docs:method name=subject.menus.getViewTree locale=en -->

- **Purpose**: Return the current user’s visible navigation tree for a config.
- **Parameters**: `options.configId` selects the menu config.
- **State impact**: Read-only; projected from the current user’s effective roles and menu grants.
- **Raw return**: `SubjectRuntimeResult<readonly ViewTreeNode[]>`; actions are not returned as tree nodes.

<span id="subject-menus-get-action-map"></span>
### `subject.menus.getActionMap(input)`

<!-- docs:method name=subject.menus.getActionMap locale=en -->

- **Purpose**: Return whether each action under a view is visible, enabled, and why.
- **Parameters**: `input.configId` and `input.viewId`.
- **State impact**: Read-only.
- **Raw return**: `SubjectRuntimeResult<Record<string, ActionPermissionState>>`; object keys are action IDs.

<span id="subject-menus-get-view-state"></span>
### `subject.menus.getViewState(input)`

<!-- docs:method name=subject.menus.getViewState locale=en -->

- **Purpose**: Decide whether the current user may enter a view.
- **Parameters**: Pass `{ configId, viewId }` or `{ path }`.
- **State impact**: Read-only.
- **Raw return**: `SubjectRuntimeResult<ViewPermissionState>`; `allowed` is the permission result and `navigationReachable` indicates whether the navigation chain is reachable.

<span id="subject-menus-filter-response"></span>
### `subject.menus.filterResponse(apiResource, payload)`

<!-- docs:method name=subject.menus.filterResponse locale=en -->

- **Purpose**: Project an API response according to the current user’s response-field grants.
- **Parameters**: `apiResource` is `api:METHOD:/path`; `payload` is the data about to be returned.
- **State impact**: Read-only, but first checks whether the user can `invoke` the `apiResource`.
- **Raw return**: `SubjectRuntimeResult<unknown>`; the projected response is in `data`.

## Responses and side effects

Saving config returns a mutation envelope, audit ID, revisions, cache invalidation results, and internal sync summaries. Runtime methods do not write to the database. They return `SubjectRuntimeResult<T>`, where `data` is the frontend-facing value and `detailBudget` is diagnostic metadata.

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

Common failures include duplicate or missing config IDs, invalid resource formats, unsafe response-field paths, auto-commit requiring explicit preview confirmation, expired preview tokens, revision conflicts, and capacity limits. `load.resource` must be an `api:` resource; response fields can only reference fields declared by the config. Saving config does not automatically grant any role or user.

When incremental management auto mode sees cascade delete, grant-revoking delete, or another impact that cannot be auto-confirmed, it throws `MENU_MANAGEMENT_PREVIEW_CONFLICT`. Show `details.operations/conflicts/warnings` to the administrator, call the matching `preview*()` method, and then execute with `expected/previewToken`.

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
const projectedData = projected.data;
```

```json
{
  "tree": [{ "id": "orders", "enabled": true }],
  "view": { "allowed": true, "view": { "id": "orders-list" } },
  "projectedData": {
    "items": [{ "orderNo": "O-1001", "status": "paid" }],
    "total": 1
  }
}
```

## Related

See [Manage Menus](/guide/menu-management), [Configure APIs and Response Fields](/guide/api-bindings), and [Role Menu Permissions API](/api/role-menu-permissions).
