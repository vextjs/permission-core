# Roles
<!-- docs:inline-parity `scoped.roles` `create()` `get()` `list()` `update()` `previewAccessUpdate()` `executeAccessUpdate()` `getRemovalImpact()` `remove()` `allow()` `deny()` `revoke()` `previewReplaceRules()` `replaceRules()` `getOwnRules()` `getEffectiveRules()` `getChain()` `MutationOptions` `RoleCreateInput` `id` `string` `__proto__` `prototype` `constructor` `label` `description` `status` `enabled \| disabled \| deprecated` `enabled` `parentId` `string \| null` `null` `PermissionRuleInput.action` `read/invoke/...` `*` `PermissionRuleInput.resource` `api:GET:/api/orders` `db:orders` `PermissionRuleInput.where` `RoleUpdateInput.label` `RoleUpdateInput.description` `RoleAccessUpdateInput.status` `RoleAccessUpdateInput.parentId` `ManualRuleSelector` `effect + action + resource + where?` `semanticKey` `ManualRuleInput.effect` `allow` `deny` `PermissionRuleInput` `first` `number` `50` `1..200` `after` `pageInfo.endCursor` `EntityStatus` `search` `effect` `allow \| deny` `listOwnRules()` `sourceKind` `manual \| menu` `create(input, options?)` `input: RoleCreateInput` `options` `MutationResult<Role>` `data.id/status/parentId/revision` `operationId/auditId` `ROLE_ALREADY_EXISTS` `ROLE_NOT_FOUND` `CIRCULAR_INHERITANCE` `LIMIT_EXCEEDED` `get(roleId)` `roleId` `VersionedResult<Role>` `update/remove` `data.revision` `expectedRevision` `getOwnRules/getEffectiveRules` `get().data` `list(query?)` `query` `first/after/status/search/parentId` `PageResult<Role>` `items` `hasNext=true` `endCursor` `update(roleId, patch, options)` `label/description` `patch: RoleUpdateInput` `options.expectedRevision` `REVISION_CONFLICT` `previewAccessUpdate(roleId, patch, options?)` `patch: RoleAccessUpdateInput` `ImpactPreview<RoleAccessUpdatePlan>` `executable=true` `previewToken/expected` `conflicts` `executeAccessUpdate` `executeAccessUpdate(roleId, patch, options)` `patch` `expectedRevisions + previewToken` `PREVIEW_REQUIRED` `PREVIEW_STALE` `getRemovalImpact(roleId)` `VersionedResult<RoleRemovalImpact>` `data.removable` `data.blockers` `remove` `remove(roleId, options)` `get/getRemovalImpact` `MutationResult<{ removedRoleId: string }>` `ROLE_IN_USE` `allow(roleId, rule, options?)` `rule: PermissionRuleInput` `where` `MutationResult<PermissionRuleView>` `data.semanticKey` `data.sources` `deny(roleId, rule, options?)` `MutationResult<PermissionRule>` `data.effect` `revoke(roleId, selector, options?)` `selector` `effect/action/resource/where?` `MutationResult<{ removed; remainingCount; remainingDigest }>` `removed=0` `previewRuleChange(roleId, change, options?)` `change` `{ operation: 'allow'|'deny', rule }` `{ operation: 'revoke', selector }` `ImpactPreview<ManualRuleChangePlan>` `plan.sourceOperation` `executeRuleChange` `executeRuleChange(roleId, change, options)` `roleId/change` `MutationResult<ManualRuleChangeResult>` `rule` `previewReplaceRules(roleId, rules, options?)` `rules: ManualRuleInput[]` `ImpactPreview<RoleRuleReplacePlan>` `replaceRules(roleId, rules, options)` `rules` `MutationResult<BatchMutationSummary>` `getOwnRules(roleId)` `VersionedResult<PermissionRuleView[]>` `listOwnRules` `getEffectiveRules` `listOwnRules(roleId, query?)` `first/after/effect/sourceKind` `PageResult<PermissionRuleView>` `getEffectiveRules(roleId)` `VersionedResult<EffectiveRoleRules>` `data.role` `data.chain` `data.rules/conflicts` `subject.getPermissions()` `getChain(roleId)` `VersionedResult<RoleChainEntry[]>` `role/depth/included/excludedReason` `update` `previewAccessUpdate` `data` `etag` `32` `2048` -->

`scoped.roles` manages roles, hierarchy, manual rules, high-impact previews, replacement flows, and effective rule reads inside one complete scope.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want to Do?

Use this table as the shortest route from a task to the first method. Methods that can change broad state use a preview/execute pair so the admin UI can show impact before writing.

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
create(input: RoleCreateInput, options?: MutationOptions): Promise<MutationResult<Role>>
get(roleId: string): Promise<VersionedResult<Role>>
list(query?: CursorQuery & { status?: EntityStatus; search?: string; parentId?: string | null }): Promise<PageResult<Role>>
update(roleId: string, patch: RoleUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<Role>>
previewAccessUpdate(roleId: string, patch: RoleAccessUpdateInput, options?: PreviewOptions): Promise<ImpactPreview<RoleAccessUpdatePlan>>
executeAccessUpdate(roleId: string, patch: RoleAccessUpdateInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<Role>>
getRemovalImpact(roleId: string): Promise<VersionedResult<RoleRemovalImpact>>
remove(roleId: string, options: RequiredRevisionOptions): Promise<MutationResult<{ removedRoleId: string }>>
allow(roleId: string, rule: PermissionRuleInput, options?: MutationOptions): Promise<MutationResult<PermissionRuleView>>
deny(roleId: string, rule: PermissionRuleInput, options?: MutationOptions): Promise<MutationResult<PermissionRuleView>>
revoke(roleId: string, selector: ManualRuleSelector, options?: MutationOptions): Promise<MutationResult<{ removed: number; remainingCount: number; remainingDigest: string }>>
previewRuleChange(roleId: string, change: ManualRuleChange, options?: PreviewOptions): Promise<ImpactPreview<ManualRuleChangePlan>>
executeRuleChange(roleId: string, change: ManualRuleChange, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ManualRuleChangeResult>>
previewReplaceRules(roleId: string, rules: readonly ManualRuleInput[], options?: PreviewOptions): Promise<ImpactPreview<RoleRuleReplacePlan>>
replaceRules(roleId: string, rules: readonly ManualRuleInput[], options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>
getOwnRules(roleId: string): Promise<VersionedResult<PermissionRuleView[]>>
listOwnRules(roleId: string, query?: CursorQuery & { effect?: 'allow' | 'deny'; sourceKind?: 'manual' | 'menu' }): Promise<PageResult<PermissionRuleView>>
getEffectiveRules(roleId: string): Promise<VersionedResult<EffectiveRoleRules>>
getChain(roleId: string): Promise<VersionedResult<RoleChainEntry[]>>
```
## Input Parameters

The table explains domain inputs. Shared `MutationOptions`, revision options, preview tokens, pagination, and envelope shapes are documented in the common response contracts.

<!-- docs:params owner=RoleCreateInput locale=en -->
### `RoleCreateInput`
### Rule and Change Inputs
<!-- docs:params owner=RoleRuleInputs locale=en -->
### Pagination Queries
## Method Details: Create and Read

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

<span id="roles-create"></span>
### `create(input, options?)`
<!-- docs:method name=roles.create locale=en -->

- **Purpose**: Create a role record with its display metadata, parent relationship, and initial lifecycle state.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-get"></span>
### `get(roleId)`
<!-- docs:method name=roles.get locale=en -->

- **Purpose**: Read one role with its revision metadata so a management UI can display or update it safely.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-list"></span>
### `list(query?)`
<!-- docs:method name=roles.list locale=en -->

- **Purpose**: Page through roles for management screens, filtering, search, or role pickers.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `PageResult<T>` or the documented paged business result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-update"></span>
### `update(roleId, patch, options)`
<!-- docs:method name=roles.update locale=en -->

- **Purpose**: Update role metadata or hierarchy using an expected revision to prevent overwriting concurrent changes.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-preview-access-update"></span>
## Method Details: High-Impact Role Changes

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `previewAccessUpdate(roleId, patch, options?)`
<!-- docs:method name=roles.previewAccessUpdate locale=en -->

- **Purpose**: Preview how a role access update would affect descendants, users, and effective permission state before writing.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-execute-access-update"></span>
### `executeAccessUpdate(roleId, patch, options)`
<!-- docs:method name=roles.executeAccessUpdate locale=en -->

- **Purpose**: Commit a previously previewed role access update with the expected revisions and preview token.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-get-removal-impact"></span>
### `getRemovalImpact(roleId)`
<!-- docs:method name=roles.getRemovalImpact locale=en -->

- **Purpose**: Inspect which children, users, rules, and menu grants would be affected before deleting a role.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-remove"></span>
### `remove(roleId, options)`
<!-- docs:method name=roles.remove locale=en -->

- **Purpose**: Delete or detach a role according to the chosen removal options and expected revision vector.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-allow"></span>
## Method Details: Incremental Manual Rule Changes

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `allow(roleId, rule, options?)`
<!-- docs:method name=roles.allow locale=en -->

- **Purpose**: Add one manual allow rule to a role for an action/resource pattern.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-deny"></span>
### `deny(roleId, rule, options?)`
<!-- docs:method name=roles.deny locale=en -->

- **Purpose**: Add one manual deny rule to a role so deny-first evaluation can block a capability explicitly.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-revoke"></span>
### `revoke(roleId, selector, options?)`
<!-- docs:method name=roles.revoke locale=en -->

- **Purpose**: Remove selected manual rule IDs from a role after checking the role revision.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-preview-rule-change"></span>
## Method Details: Preview and Commit Rule Impact

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `previewRuleChange(roleId, change, options?)`
<!-- docs:method name=roles.previewRuleChange locale=en -->

- **Purpose**: Preview adding, denying, or revoking manual role rules and inspect conflicts before writing.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-execute-rule-change"></span>
### `executeRuleChange(roleId, change, options)`
<!-- docs:method name=roles.executeRuleChange locale=en -->

- **Purpose**: Commit a previously previewed manual rule change with the expected revisions and preview token.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-preview-replace-rules"></span>
### `previewReplaceRules(roleId, rules, options?)`
<!-- docs:method name=roles.previewReplaceRules locale=en -->

- **Purpose**: Preview replacing all manual rules on a role and see which rules would be inserted, kept, or removed.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-replace-rules"></span>
### `replaceRules(roleId, rules, options)`
<!-- docs:method name=roles.replaceRules locale=en -->

- **Purpose**: Replace a role's manual rule set with the provided rules after a matching preview.
- **Parameters**: Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-get-own-rules"></span>
## Method Details: Read Direct and Effective Rules

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `getOwnRules(roleId)`
<!-- docs:method name=roles.getOwnRules locale=en -->

- **Purpose**: Read the direct rules saved on a role without inherited rules.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-list-own-rules"></span>
### `listOwnRules(roleId, query?)`
<!-- docs:method name=roles.listOwnRules locale=en -->

- **Purpose**: Page through a role's direct rules, optionally filtered by effect or source kind.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `PageResult<T>` or the documented paged business result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-get-effective-rules"></span>
### `getEffectiveRules(roleId)`
<!-- docs:method name=roles.getEffectiveRules locale=en -->

- **Purpose**: Read the final rule set after parent-role inheritance and deny-first conflict resolution metadata.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="roles-get-chain"></span>
### `getChain(roleId)`
<!-- docs:method name=roles.getChain locale=en -->

- **Purpose**: Inspect the parent-role chain that contributes inherited rules to the role.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "committed": true,
  "changed": true,
  "data": { "id": "order-reader", "status": "enabled", "parentId": null, "revision": 1 },
  "revision": 1,
  "operationId": "operation_...",
  "auditId": "audit_...",
  "replayed": false,
  "cache": { "status": "completed" }
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
const created = await scoped.roles.create({ id: 'operator', label: 'Operator' });
await scoped.roles.allow('operator', { action: 'read', resource: 'db:orders' });
const own = await scoped.roles.getOwnRules('operator');
```
```json
{
  "createdRevision": 1,
  "ownRules": [{ "effect": "allow", "action": "read", "resource": "db:orders" }]
}
```
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [User Roles](/api/user-roles).
