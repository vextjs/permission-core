# API Bindings

## Purpose and preconditions

`scoped.apiBindings` describes backend API contracts, their authorization requirements, and owning menus/pages/buttons. Bindings feed menu availability and role-menu grants; every endpoint must still enforce authorization in the backend.

## Signatures

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

`update` changes purpose/description only. Method/path/authorization/owners/canonical owner use impact `previewUpdate` plus `executeUpdate` because generated role sources may need explicit replacement or revocation.

## Responses and side effects

A binding normalizes method/path, validates `all`/`any` authorization, resolves owner relations, and returns a mutation envelope. Status and contract rewrites may change role-generated sources and subject menu availability after commit.

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

Important errors are `API_BINDING_NOT_FOUND`, `API_BINDING_ALREADY_EXISTS`, `DEPENDENCY_EXISTS`, `STALE_REFERENCE`, `REVISION_CONFLICT`, and `PREVIEW_STALE`. A scope supports up to `20000` bindings. Authorization must contain at least one valid permission; owner and availability-group relationships must reference valid menu assets.

## Example

This example assumes that the `orders-export` button node already exists in the same scope. Owner references are validated when the binding is created.

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

See [Bind APIs](/guide/api-bindings), [Menus](/api/menus), and [Role Menu Permissions](/api/role-menu-permissions).
