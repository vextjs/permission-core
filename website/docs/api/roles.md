# Roles

## Purpose and preconditions

`scoped.roles` manages tenant-scoped roles, hierarchy, manual rules, impact previews, and effective reads. A role has one optional parent. All IDs and rules are meaningful only inside the context's complete scope.

## Signatures

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

`update` changes label/description only. Status or parent changes use `previewAccessUpdate` plus `executeAccessUpdate`. Full rule replacement always uses preview/execute.

## Responses and side effects

Reads return `data`, revision vector, `etag`, and detail budget. Writes commit role/rule state plus audit evidence and return operation/audit IDs. `allow`/`deny` add a manual source to a canonical semantic rule; an equivalent menu source remains independently traceable.

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

Important errors are `ROLE_NOT_FOUND`, `ROLE_ALREADY_EXISTS`, `ROLE_IN_USE`, `CIRCULAR_INHERITANCE`, `REVISION_CONFLICT`, `PREVIEW_REQUIRED`, `PREVIEW_STALE`, and `LIMIT_EXCEEDED`. Limits include one parent, chain depth `32`, `2048` rules per role, and bounded effective snapshots. Replace accepts at most `2048` rules.

## Example

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

See [Role Inheritance](/guide/role-inheritance), [User Roles](/api/user-roles), and [Role Menu Permissions](/api/role-menu-permissions).
