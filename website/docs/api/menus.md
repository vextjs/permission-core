# Menus
<!-- docs:inline-parity `scoped.menus` `create()` `get()` `list()` `getTree()` `update()` `previewUpdate()` `previewMove()` `previewReorder()` `previewSetStatus()` `setStatus()` `getRemovalImpact()` `previewRemove()` `findStaleReferences()` `getVisibleTree()` `getButtonMap()` `getRouteState()` `manifest.preview/import/export` `update` `previewUpdate` `MenuNodeCreateInput` `id` `string` `parentId` `string \| null` `null` `type` `directory \| menu \| page \| button \| external \| iframe` `title` `i18nKey` `path` `menu/page/iframe` `name` `component` `page` `code` `button` `url` `external/iframe` `permission` `{ action, resource }` `directory` `dataPermissions` `MenuDataPermissionTemplate[]` `[]` `action/resource` `where/label` `status` `enabled \| disabled \| deprecated` `enabled` `previewSetStatus/setStatus` `hidden` `boolean` `false` `icon/i18nKey/meta` `meta` `menu` `external` `iframe` `MenuNodeFilter` `parentId/type/status/hidden/search` `first/after` `MenuMoveInput` `nodeId/parentId` `beforeId/afterId` `beforeId` `afterId` `MenuReorderInput` `parentId/orderedNodeIds` `MenuNodeImpactUpdateRequest` `patch` `sourceRewrite` `sourceRewrite.mode='reject'` `MenuRemoveInput` `cascade/sourceRewrite?` `cascade=false` `true` `StaleRepairInput` `referenceIds/resolutions` `remove` `rebind + replacementId` `MenuManifestInput` `schemaVersion: 2` `mode` `nodes` `apiBindings` `merge` `replace` `preview*` `expected` `previewToken` `create(input, options?)` `input` `options` `MutationResult<MenuNode>` `data` `operationId/auditId` `get(nodeId)` `nodeId` `VersionedResult<MenuNode>` `data.revision` `list(query?)` `query` `first` `50` `200` `PageResult<MenuNode>` `items` `hasNext` `endCursor` `after` `getTree(options?)` `rootId` `includeHidden` `VersionedResult<MenuTreeNode[]>` `children` `update(nodeId, patch, options)` `title/component/icon/hidden/i18nKey/meta` `options.expectedRevision` `previewUpdate(nodeId, request, options?)` `request.patch` `ImpactPreview<MenuNodeUpdatePlan>` `plan.before/after` `sourceImpacts` `executable` `executeUpdate(nodeId, request, options)` `nodeId/request` `PREVIEW_STALE` `previewMove(input, options?)` `ImpactPreview<MenuMovePlan>` `move(input, options)` `expected/previewToken` `previewReorder(input, options?)` `orderedNodeIds` `ImpactPreview<MenuReorderPlan>` `before/after` `reorder(input, options)` `MutationResult<BatchMutationSummary>` `previewSetStatus(nodeId, status, options?)` `enabled/disabled/deprecated` `ImpactPreview<MenuStatusPlan>` `affectedSources/affectedRoles/affectedUsers` `setStatus(nodeId, status, options)` `getRemovalImpact(nodeId)` `VersionedResult<MenuRemovalImpact>` `previewRemove` `previewRemove(nodeId, input, options?)` `input.cascade` `ImpactPreview<MenuRemovalPlan>` `nodes/detachedApiBindings/sourceImpacts` `remove(nodeId, input, options)` `findStaleReferences(query?)` `PageResult<StaleReference>` `previewRepairStaleReferences(input, options?)` `referenceIds` `resolutions` `replacementId` `ImpactPreview<StaleRepairPlan>` `repairStaleReferences(input, options)` `subject.menus.getVisibleTree(options?)` `SubjectRuntimeResult<VisibleMenuTreeNode[]>` `visible=true` `enabled/reason/apiRisks/children` `scoped.menus.getTree()` `subject.menus.getButtonMap(ownerNodeId)` `SubjectRuntimeResult<Record<string, ButtonPermissionState>>` `visible/enabled/reason/action/resource/apiRisks` `subject.menus.getRouteState(path)` `/orders` `SubjectRuntimeResult<RoutePermissionState>` `data.allowed` `data.navigationReachable/navigationReason` `manifest.preview(input, options?)` `mode='merge'` `'replace'` `ImpactPreview<MenuManifestPlan>` `manifest.import(input, options)` `manifest.export()` `VersionedResult<FrontendMenuManifest>` `nodes/apiBindings` `manifest.exportPage(query?)` `kind='node' | 'api-binding'` `PageResult<MenuManifestExportRecord>` `kind/value` `MENU_NOT_FOUND` `MENU_ALREADY_EXISTS` `MENU_HIERARCHY_INVALID` `DEPENDENCY_EXISTS` `STALE_REFERENCE` `REVISION_CONFLICT` `10000` `64` `5000` -->

`scoped.menus` manages backend menu inventory, structural changes, stale-reference repair, subject menu projection, and frontend manifest import/export.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want to Do?

Use this table as the shortest route from a task to the first method. Methods that can change broad state use a preview/execute pair so the admin UI can show impact before writing.

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
create(input: MenuNodeCreateInput, options?: MutationOptions): Promise<MutationResult<MenuNode>>
get(nodeId: string): Promise<VersionedResult<MenuNode>>
list(query?: CursorQuery & MenuNodeFilter): Promise<PageResult<MenuNode>>
getTree(options?: { rootId?: string; includeHidden?: boolean }): Promise<VersionedResult<MenuTreeNode[]>>
update(nodeId: string, patch: MenuNodeUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<MenuNode>>
previewUpdate(nodeId: string, request: MenuNodeImpactUpdateRequest, options?: PreviewOptions): Promise<ImpactPreview<MenuNodeUpdatePlan>>
executeUpdate(nodeId: string, request: MenuNodeImpactUpdateRequest, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>
previewMove(input: MenuMoveInput, options?: PreviewOptions): Promise<ImpactPreview<MenuMovePlan>>
move(input: MenuMoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>
previewReorder(input: MenuReorderInput, options?: PreviewOptions): Promise<ImpactPreview<MenuReorderPlan>>
reorder(input: MenuReorderInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
previewSetStatus(nodeId: string, status: EntityStatus, options?: PreviewOptions): Promise<ImpactPreview<MenuStatusPlan>>
setStatus(nodeId: string, status: EntityStatus, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>
getRemovalImpact(nodeId: string): Promise<VersionedResult<MenuRemovalImpact>>
previewRemove(nodeId: string, input: MenuRemoveInput, options?: PreviewOptions): Promise<ImpactPreview<MenuRemovalPlan>>
remove(nodeId: string, input: MenuRemoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
findStaleReferences(query?: CursorQuery): Promise<PageResult<StaleReference>>
previewRepairStaleReferences(input: StaleRepairInput, options?: PreviewOptions): Promise<ImpactPreview<StaleRepairPlan>>
repairStaleReferences(input: StaleRepairInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>

subject.menus.getVisibleTree(options?: { rootId?: string }): Promise<SubjectRuntimeResult<VisibleMenuTreeNode[]>>
subject.menus.getButtonMap(ownerNodeId: string): Promise<SubjectRuntimeResult<Readonly<Record<string, ButtonPermissionState>>>>
subject.menus.getRouteState(path: string): Promise<SubjectRuntimeResult<RoutePermissionState>>

scoped.menus.manifest.preview(input: MenuManifestInput, options?: PreviewOptions): Promise<ImpactPreview<MenuManifestPlan>>
scoped.menus.manifest.import(input: MenuManifestInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
scoped.menus.manifest.export(): Promise<VersionedResult<FrontendMenuManifest>>
scoped.menus.manifest.exportPage(query?: CursorQuery & { kind?: MenuManifestExportRecord['kind'] }): Promise<PageResult<MenuManifestExportRecord>>
```
## Parameter Objects

The table explains object fields that are easy to confuse at call sites. Required fields are validated before the method mutates persistent authorization state.

<!-- docs:params owner=MenuNodeCreateInput locale=en -->
### `MenuNodeCreateInput`
<!-- docs:params owner=MenuMutationInputs locale=en -->
## Method Details: Create and Read Nodes

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

<span id="menus-create"></span>
### `create(input, options?)`
<!-- docs:method name=menus.create locale=en -->

- **Purpose**: Use `menus.create` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-get"></span>
### `get(nodeId)`
<!-- docs:method name=menus.get locale=en -->

- **Purpose**: Use `menus.get` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-list"></span>
### `list(query?)`
<!-- docs:method name=menus.list locale=en -->

- **Purpose**: Use `menus.list` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `PageResult<T>` or the documented paged business result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-get-tree"></span>
### `getTree(options?)`
<!-- docs:method name=menus.getTree locale=en -->

- **Purpose**: Use `menus.getTree` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-update"></span>
## Method Details: Change Fields and Structure

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `update(nodeId, patch, options)`
<!-- docs:method name=menus.update locale=en -->

- **Purpose**: Use `menus.update` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-preview-update"></span>
### `previewUpdate(nodeId, request, options?)`
<!-- docs:method name=menus.previewUpdate locale=en -->

- **Purpose**: Use `menus.previewUpdate` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-execute-update"></span>
### `executeUpdate(nodeId, request, options)`
<!-- docs:method name=menus.executeUpdate locale=en -->

- **Purpose**: Use `menus.executeUpdate` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-preview-move"></span>
### `previewMove(input, options?)`
<!-- docs:method name=menus.previewMove locale=en -->

- **Purpose**: Use `menus.previewMove` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-move"></span>
### `move(input, options)`
<!-- docs:method name=menus.move locale=en -->

- **Purpose**: Use `menus.move` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-preview-reorder"></span>
### `previewReorder(input, options?)`
<!-- docs:method name=menus.previewReorder locale=en -->

- **Purpose**: Use `menus.previewReorder` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-reorder"></span>
### `reorder(input, options)`
<!-- docs:method name=menus.reorder locale=en -->

- **Purpose**: Use `menus.reorder` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-preview-set-status"></span>
## Method Details: Change Status and Remove Safely

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `previewSetStatus(nodeId, status, options?)`
<!-- docs:method name=menus.previewSetStatus locale=en -->

- **Purpose**: Use `menus.previewSetStatus` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-set-status"></span>
### `setStatus(nodeId, status, options)`
<!-- docs:method name=menus.setStatus locale=en -->

- **Purpose**: Use `menus.setStatus` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-get-removal-impact"></span>
### `getRemovalImpact(nodeId)`
<!-- docs:method name=menus.getRemovalImpact locale=en -->

- **Purpose**: Use `menus.getRemovalImpact` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-preview-remove"></span>
### `previewRemove(nodeId, input, options?)`
<!-- docs:method name=menus.previewRemove locale=en -->

- **Purpose**: Use `menus.previewRemove` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-remove"></span>
### `remove(nodeId, input, options)`
<!-- docs:method name=menus.remove locale=en -->

- **Purpose**: Use `menus.remove` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-find-stale-references"></span>
## Method Details: Repair Stale References

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `findStaleReferences(query?)`
<!-- docs:method name=menus.findStaleReferences locale=en -->

- **Purpose**: Use `menus.findStaleReferences` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-preview-repair-stale-references"></span>
### `previewRepairStaleReferences(input, options?)`
<!-- docs:method name=menus.previewRepairStaleReferences locale=en -->

- **Purpose**: Use `menus.previewRepairStaleReferences` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-repair-stale-references"></span>
### `repairStaleReferences(input, options)`
<!-- docs:method name=menus.repairStaleReferences locale=en -->

- **Purpose**: Use `menus.repairStaleReferences` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="subject-menus-get-visible-tree"></span>
## Method Details: Project User Menus

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `subject.menus.getVisibleTree(options?)`
<!-- docs:method name=subject.menus.getVisibleTree locale=en -->

- **Purpose**: Use `subject.menus.getVisibleTree` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="subject-menus-get-button-map"></span>
### `subject.menus.getButtonMap(ownerNodeId)`
<!-- docs:method name=subject.menus.getButtonMap locale=en -->

- **Purpose**: Use `subject.menus.getButtonMap` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="subject-menus-get-route-state"></span>
### `subject.menus.getRouteState(path)`
<!-- docs:method name=subject.menus.getRouteState locale=en -->

- **Purpose**: Use `subject.menus.getRouteState` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-manifest-preview"></span>
## Method Details: Import and Export a Manifest

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `manifest.preview(input, options?)`
<!-- docs:method name=menus.manifest.preview locale=en -->

- **Purpose**: Use `menus.manifest.preview` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-manifest-import"></span>
### `manifest.import(input, options)`
<!-- docs:method name=menus.manifest.import locale=en -->

- **Purpose**: Use `menus.manifest.import` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-manifest-export"></span>
### `manifest.export()`
<!-- docs:method name=menus.manifest.export locale=en -->

- **Purpose**: Use `menus.manifest.export` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="menus-manifest-export-page"></span>
### `manifest.exportPage(query?)`
<!-- docs:method name=menus.manifest.exportPage locale=en -->

- **Purpose**: Use `menus.manifest.exportPage` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "data": {
    "id": "orders",
    "parentId": null,
    "type": "page",
    "title": "Orders",
    "path": "/orders",
    "name": "orders",
    "component": "OrdersPage",
    "permission": { "action": "read", "resource": "ui:page:orders" },
    "status": "enabled",
    "hidden": false,
    "revision": 1
  },
  "operationId": "operation_...",
  "auditId": "audit_..."
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
const created = await scoped.menus.create({
  id: 'orders', type: 'page', title: 'Orders', path: '/orders',
  name: 'orders', component: 'OrdersPage',
  permission: { action: 'read', resource: 'ui:page:orders' },
});
const tree = await scoped.menus.getTree();
```
```json
{ "created": "orders", "treeRoots": ["orders"] }
```
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [API Bindings](/api/api-bindings).
