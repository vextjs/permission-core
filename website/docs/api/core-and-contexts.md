# Core and Contexts
<!-- docs:inline-parity `PermissionCore` `init()` `new PermissionCore()` `health()` `scope()` `forSubject()` `can()` `cannot()` `assert()` `getPermissions()` `getResources()` `explain()` `close()` `PermissionCoreOptions` `monsqlize` `MonSQLizeInstance` `collectionPrefix` `string` `permission_core` `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` `cache` `PermissionSemanticCacheOptions` `{ enabled: false }` `monsqlize.getCache()` `closeDrainTimeoutMs` `number` `30000` `1000..300000` `tokenSecret` `string \| Uint8Array` `resourceSchemes` `ResourceSchemeDefinition[]` `[]` `ttlMs` `100..86400000` `enabled: false` `consistency` `PermissionScope` `tenantId` `appId` `moduleId` `namespace` `{ tenantId: 'acme' }` `{ tenantId: 'acme', appId: 'ops' }` `PermissionSubject` `PolicyContext` `subject.userId` `subject.scope` `subject.claims` `Record<string, PolicyValue>` `valueFrom: 'claims.xxx'` `context` `MutationResult<Role>` `Role` `data` `MutationOptions` `actorId` `reason` `requestId` `idempotencyKey` `replayed` `true` `expectedRevision` `data.revision` `REVISION_CONFLICT` `expectedRevisions` `previewToken` `acknowledgeCapacityRisk` `VersionedResult<T>` `revision` `revisions` `etag` `detailBudget` `SubjectRuntimeResult<T>` `PageResult<T>` `items` `pageInfo.hasNext` `pageInfo.endCursor` `hasNext=true` `endCursor` `after` `BoundedDetails<T>` `total` `truncated` `digest` `truncated=true` `total/digest` `MutationResult<T>.data` `committed` `changed` `changed=false` `operationId` `auditId` `cache.status` `degraded` `ImpactPreview.executable` `expected` `conflicts` `warnings` `capacity` `new PermissionCore(options)` `options` `new` `INVALID_CONFIGURATION` `new -> initializing -> ready` `PermissionCoreHealth` `status` `database.status` `schema` `tokens` `status='degraded'` `audit` `down` `scope(scope)` `scope: PermissionScope` `ScopedPermissionContext` `roles` `userRoles` `menus` `menus.config` `forSubject(subject, context?)` `subject` `SubjectPermissionContext` `can/cannot/assert/explain/getPermissions/getResources/menus/data` `can(subject, action, resource, context?)` `subject.can(action, resource)` `if` `action` `read/invoke/...` `resource` `false` `boolean` `cannot(subject, action, resource, context?)` `subject.cannot(action, resource)` `can` `!can(...)` `blocked/forbidden` `cannot` `assert(subject, action, resource, context?)` `subject.assert(action, resource)` `Promise<void>` `PERMISSION_DENIED` `getPermissions(subject, context?)` `subject.getPermissions()` `can/assert` `SubjectRuntimeResult<EffectivePermissionSnapshot>` `data.directRoleIds` `data.roles` `data.rules` `data.conflicts` `getResources(subject, action?, context?)` `subject.getResources(action?)` `SubjectRuntimeResult<EffectiveResourcePattern[]>` `explain(subject, action, resource, context?)` `subject.explain(action, resource)` `SubjectRuntimeResult<PermissionExplanation>` `data.allowed` `data.reason` `data.evaluations` `explain` `ready -> closing -> closed` `CORE_CLOSE_TIMEOUT` `void` `EffectivePermissionSnapshot` `NOT_INITIALIZED` `CORE_CLOSED` -->

`PermissionCore` owns initialization, health, scope facades, subject facades, runtime decisions, diagnostics, and shutdown. The host still owns authentication and the MonSQLize connection. Menu config API details such as `load/actions/response` live under `scoped.menus.config`, while subject contexts only evaluate the resulting authorization state.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want to Do?

Use this table as the shortest route from a task to the first method. Methods that can change broad state use a preview/execute pair so the admin UI can show impact before writing.

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
new PermissionCore(options: PermissionCoreOptions)
init(): Promise<PermissionCoreHealth>
health(): Promise<PermissionCoreHealth>
scope(scope: PermissionScope, defaults?: ScopedMutationDefaults): ScopedPermissionContext
forSubject(subject: PermissionSubject, context?: PolicyContext): SubjectPermissionContext
can(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<boolean>
cannot(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<boolean>
assert(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<void>
getPermissions(subject: PermissionSubject, context?: PolicyContext): Promise<SubjectRuntimeResult<EffectivePermissionSnapshot>>
getResources(subject: PermissionSubject, action?: PermissionAction, context?: PolicyContext): Promise<SubjectRuntimeResult<EffectiveResourcePattern[]>>
explain(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<SubjectRuntimeResult<PermissionExplanation>>
close(): Promise<void>
```
## Constructor Options and Shared Inputs

These inputs are shared by multiple APIs. They decide the namespace, scope, subject, policy context, revision controls, preview controls, and bounded response shape used throughout the package.

<!-- docs:params owner=PermissionCoreOptions locale=en -->
<span id="permission-core-options"></span>
### `PermissionCoreOptions`
```ts
cache: {
  enabled: true,
  consistency: 'ordered-bounded-stale',
  ttlMs: 30_000,
}
```
### `PermissionScope`
<!-- docs:params owner=PermissionScope locale=en -->
### `PermissionSubject` and `PolicyContext`
<!-- docs:params owner=PermissionSubject locale=en -->
## Common Response Contracts

Management writes return mutation envelopes. Reads return versioned or paged envelopes. Subject runtime calls return booleans, void, or bounded diagnostic results depending on the method.

### `MutationOptions` and Revision Options
<!-- docs:params owner=MutationOptions locale=en -->
### Read and Page Responses
<!-- docs:response owner=read-envelopes kind=raw locale=en -->
### Write and Preview Responses
<!-- docs:response owner=mutation-preview kind=raw locale=en -->
## Method Details: Initialization and Health

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

<span id="core-constructor"></span>
### `new PermissionCore(options)`
<!-- docs:method name=PermissionCore locale=en -->

- **Purpose**: Use `PermissionCore` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-init"></span>
### `init()`
<!-- docs:method name=init locale=en -->

- **Purpose**: Use `init` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-health"></span>
### `health()`
<!-- docs:method name=health locale=en -->

- **Purpose**: Use `health` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-scope"></span>
## Method Details: Create Management and Subject Contexts

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `scope(scope, defaults?)`
<!-- docs:method name=scope locale=en -->

- **Purpose**: Create a management facade for one trusted permission scope.
- **Parameters**: `scope` is the trusted permission namespace. `defaults` can bind this admin request's `actorId/reason/requestId`; scoped mutation and preview methods merge those audit defaults before validating per-call options.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `ScopedPermissionContext`, including `withDefaults()`, `roles`, `userRoles`, and `menus`.

<span id="core-for-subject"></span>
### `forSubject(subject, context?)`
<!-- docs:method name=forSubject locale=en -->

- **Purpose**: Use `forSubject` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass trusted host state only: normalized scope, authenticated user ID, claims/context, and collection options that map every active scope field.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-can"></span>
## Method Details: Execute Permission Decisions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `can(subject, action, resource, context?)` / `subject.can(action, resource)`
<!-- docs:method name=can locale=en -->

- **Purpose**: Use `can` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `boolean` or the documented matcher result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-cannot"></span>
### `cannot(subject, action, resource, context?)` / `subject.cannot(action, resource)`
<!-- docs:method name=cannot locale=en -->

- **Purpose**: Use `cannot` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `boolean` or the documented matcher result. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-assert"></span>
### `assert(subject, action, resource, context?)` / `subject.assert(action, resource)`
<!-- docs:method name=assert locale=en -->

- **Purpose**: Use `assert` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `Promise<void>` on success, or a structured `PermissionCoreError`. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-get-permissions"></span>
## Method Details: Read and Explain

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `getPermissions(subject, context?)` / `subject.getPermissions()`
<!-- docs:method name=getPermissions locale=en -->

- **Purpose**: Use `getPermissions` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-get-resources"></span>
### `getResources(subject, action?, context?)` / `subject.getResources(action?)`
<!-- docs:method name=getResources locale=en -->

- **Purpose**: Use `getResources` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-explain"></span>
### `explain(subject, action, resource, context?)` / `subject.explain(action, resource)`
<!-- docs:method name=explain locale=en -->

- **Purpose**: Use `explain` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="core-close"></span>
## Method Details: Close

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

### `close()`
<!-- docs:method name=close locale=en -->

- **Purpose**: Use `close` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: `Promise<void>` on success, or a structured `PermissionCoreError`. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "data": {
    "allowed": false,
    "action": "read",
    "resource": "db:orders",
    "reason": "no-allow",
    "evaluations": [{
      "action": "read",
      "allowed": false,
      "reason": "no-allow",
      "evaluatedAllows": { "total": 0, "items": [], "truncated": false, "digest": "..." },
      "evaluatedDenies": { "total": 0, "items": [], "truncated": false, "digest": "..." }
    }]
  },
  "detailBudget": { "limit": 100, "returned": 0, "truncated": false, "digest": "..." }
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
const pc = new PermissionCore({ monsqlize: msq });
await pc.init();
const scoped = pc.scope(
  { tenantId: 'acme' },
  { actorId: 'admin', requestId: 'req-42' },
);
const subject = pc.forSubject({ userId: 'u-1', scope: { tenantId: 'acme' } });
const allowed = await subject.can('read', 'db:orders');
await pc.close();
```
```json
{ "allowed": false }
```
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Roles](/api/roles).
