# API Bindings
<!-- docs:inline-parity `scoped.apiBindings` `create()` `get()` `list()` `update()` `previewSetStatus()` `setStatus()` `previewUpdate()` `executeUpdate()` `getRemovalImpact()` `previewRemove()` `previewReplace()` `replace()` `update` `previewUpdate` `executeUpdate` `ApiBindingCreateInput` `id` `string` `method` `post` `POST` `path` `/api/orders/:id` `purpose` `entry \| lookup \| detail \| operation \| importExport \| background` `authorization.mode` `all \| any` `all` `any` `authorization.permissions` `{ action, resource }[]` `can/assert` `owners` `ApiOwnerRelation[]` `[]` `canonicalOwner` `{ type, id }` `status` `enabled \| disabled \| deprecated` `enabled` `description` `ApiOwnerRelation` `type` `menu/page/button` `required` `true` `false` `availabilityGroup` `availabilityMode` `required=true` `ApiBindingFilter` `method/path/status/purpose/ownerId` `first/after` `ApiBindingImpactUpdateRequest` `patch` `sourceRewrite` `ApiBindingRemoveInput` `ApiBindingReplaceInput` `bindings` `create(input, options?)` `MutationResult<ApiBinding>` `data` `get(bindingId)` `VersionedResult<ApiBinding>` `data.revision` `list(query?)` `first` `50` `200` `PageResult<ApiBinding>` `endCursor` `update(bindingId, patch, options)` `expectedRevision` `REVISION_CONFLICT` `previewSetStatus(bindingId, status, options?)` `ImpactPreview<ApiBindingStatusPlan>` `setStatus(bindingId, status, options)` `expected/previewToken` `getRemovalImpact(bindingId)` `VersionedResult<ApiBindingImpact>` `previewRemove/remove` `previewUpdate(bindingId, request, options?)` `request.patch` `ImpactPreview<ApiBindingRewritePlan>` `executeUpdate(bindingId, request, options)` `previewRemove(bindingId, input, options?)` `input.sourceRewrite` `ImpactPreview<ApiBindingRemovalPlan>` `detachedOwners/sourceImpacts/executable` `remove(bindingId, input, options)` `MutationResult<BatchMutationSummary>` `previewReplace(input, options?)` `input.bindings` `ImpactPreview<ApiBindingReplacePlan>` `operations` `unchanged` `replace(input, options)` `1000` `PREVIEW_STALE` `API_BINDING_NOT_FOUND` `API_BINDING_ALREADY_EXISTS` `DEPENDENCY_EXISTS` `STALE_REFERENCE` `20000` `orders-export` -->

`scoped.apiBindings` manages endpoint contracts and their owners. Bindings affect UI availability and backend authorization, but they do not grant roles by themselves.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want to Do?

Use this table as the shortest route from a task to the first method. Methods that can change broad state use a preview/execute pair so the admin UI can show impact before writing.

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
create(input: ApiBindingCreateInput, options?: MutationOptions): Promise<MutationResult<ApiBinding>>
get(bindingId: string): Promise<VersionedResult<ApiBinding>>
list(query?: CursorQuery & ApiBindingFilter): Promise<PageResult<ApiBinding>>
update(bindingId: string, patch: ApiBindingUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<ApiBinding>>
previewSetStatus(bindingId: string, status: EntityStatus, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingStatusPlan>>
setStatus(bindingId: string, status: EntityStatus, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ApiBinding>>
getRemovalImpact(bindingId: string): Promise<VersionedResult<ApiBindingImpact>>
previewUpdate(bindingId: string, request: ApiBindingImpactUpdateRequest, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingRewritePlan>>
executeUpdate(bindingId: string, request: ApiBindingImpactUpdateRequest, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ApiBinding>>
previewRemove(bindingId: string, input: ApiBindingRemoveInput, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingRemovalPlan>>
remove(bindingId: string, input: ApiBindingRemoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
previewReplace(input: ApiBindingReplaceInput, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingReplacePlan>>
replace(input: ApiBindingReplaceInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
```
## Parameter Objects

The table explains object fields that are easy to confuse at call sites. Required fields are validated before the method mutates persistent authorization state.

<!-- docs:params owner=ApiBindingCreateInput locale=en -->
### `ApiBindingCreateInput`
<!-- docs:params owner=ApiOwnerRelation locale=en -->
### `ApiOwnerRelation`
<!-- docs:params owner=ApiBindingMutationInputs locale=en -->
## Method Details: Create and Read Bindings

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

<span id="api-bindings-create"></span>
### `create(input, options?)`
<!-- docs:method name=apiBindings.create locale=en -->

- **Purpose**: Use `apiBindings.create` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-get"></span>
### `get(bindingId)`
<!-- docs:method name=apiBindings.get locale=en -->

- **Purpose**: Use `apiBindings.get` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-list"></span>
### `list(query?)`
<!-- docs:method name=apiBindings.list locale=en -->

- **Purpose**: Use `apiBindings.list` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `PageResult<T>` or the documented paged business result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-update"></span>
## Method Details: Directly Update Display Fields

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `update(bindingId, patch, options)`
<!-- docs:method name=apiBindings.update locale=en -->

- **Purpose**: Use `apiBindings.update` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-preview-set-status"></span>
## Method Details: Change Status

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `previewSetStatus(bindingId, status, options?)`
<!-- docs:method name=apiBindings.previewSetStatus locale=en -->

- **Purpose**: Use `apiBindings.previewSetStatus` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-set-status"></span>
### `setStatus(bindingId, status, options)`
<!-- docs:method name=apiBindings.setStatus locale=en -->

- **Purpose**: Use `apiBindings.setStatus` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-get-removal-impact"></span>
## Method Details: Change Structure and Remove Safely

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `getRemovalImpact(bindingId)`
<!-- docs:method name=apiBindings.getRemovalImpact locale=en -->

- **Purpose**: Use `apiBindings.getRemovalImpact` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-preview-update"></span>
### `previewUpdate(bindingId, request, options?)`
<!-- docs:method name=apiBindings.previewUpdate locale=en -->

- **Purpose**: Use `apiBindings.previewUpdate` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-execute-update"></span>
### `executeUpdate(bindingId, request, options)`
<!-- docs:method name=apiBindings.executeUpdate locale=en -->

- **Purpose**: Use `apiBindings.executeUpdate` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-preview-remove"></span>
### `previewRemove(bindingId, input, options?)`
<!-- docs:method name=apiBindings.previewRemove locale=en -->

- **Purpose**: Use `apiBindings.previewRemove` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-remove"></span>
### `remove(bindingId, input, options)`
<!-- docs:method name=apiBindings.remove locale=en -->

- **Purpose**: Use `apiBindings.remove` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-preview-replace"></span>
## Method Details: Full Replacement

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `previewReplace(input, options?)`
<!-- docs:method name=apiBindings.previewReplace locale=en -->

- **Purpose**: Use `apiBindings.previewReplace` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="api-bindings-replace"></span>
### `replace(input, options)`
<!-- docs:method name=apiBindings.replace locale=en -->

- **Purpose**: Use `apiBindings.replace` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "data": {
    "id": "orders-export-api",
    "method": "POST",
    "path": "/api/orders/export",
    "purpose": "importExport",
    "authorization": {
      "mode": "all",
      "permissions": [{ "action": "invoke", "resource": "api:POST:/api/orders/export" }]
    },
    "owners": [{ "type": "button", "id": "orders-export", "required": true }],
    "status": "enabled",
    "revision": 1
  }
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
const binding = await scoped.apiBindings.create({
  id: 'orders-export-api', method: 'POST', path: '/api/orders/export',
  purpose: 'importExport',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:POST:/api/orders/export' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
});
```
```json
{ "bindingId": "orders-export-api", "changed": true }
```
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Role Menu Permissions](/api/role-menu-permissions).
