# Core and Contexts

## Purpose and preconditions

`PermissionCore` owns initialization, health, scoped management contexts, subject runtime contexts, convenience authorization calls, and shutdown. Construct it with a host-owned MonSQLize 3.1 instance, call `init()` once, and close the core before the host closes MonSQLize.

## Signatures

```ts
new PermissionCore(options: PermissionCoreOptions)
init(): Promise<PermissionCoreHealth>
health(): Promise<PermissionCoreHealth>
scope(scope: PermissionScope): ScopedPermissionContext
forSubject(subject: PermissionSubject, context?: PolicyContext): SubjectPermissionContext
can(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<boolean>
cannot(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<boolean>
assert(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<void>
getPermissions(subject: PermissionSubject, context?: PolicyContext): Promise<SubjectRuntimeResult<EffectivePermissionSnapshot>>
getResources(subject: PermissionSubject, action?: PermissionAction, context?: PolicyContext): Promise<SubjectRuntimeResult<EffectiveResourcePattern[]>>
explain(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext): Promise<SubjectRuntimeResult<PermissionExplanation>>
close(): Promise<void>
```

`scope()` exposes `roles`, `userRoles`, `menus`, and `apiBindings`. `forSubject()` exposes authorization reads, `menus`, and `data`. Both require a ready core and normalize their input immediately.

## Responses and side effects

`init()` creates/probes indexes, schema, transactions, resource schemes, and optional cache, then returns health. `health()` refreshes observable database/repository state. Context factories are synchronous and do not query authorization state until a method runs. `assert()` and `close()` resolve `void` on success.

For example, `explain()` returns this envelope; `getPermissions()` uses the same envelope but its `data` is an `EffectivePermissionSnapshot` containing the subject, direct roles, effective roles, rules, and conflicts.

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

Management reads and writes use the versioned/mutation envelopes documented on their domain pages.

## Failures and limits

Calls before ready fail with `NOT_INITIALIZED`; calls after close starts fail with `CORE_CLOSED`. Invalid scope/subject/context fails validation. Database/schema/transaction failures never become an allow. `closeDrainTimeoutMs` is `1000..300000` (default `30000`); a timeout is `CORE_CLOSE_TIMEOUT` and includes active lease counts.

## Example

```ts
const pc = new PermissionCore({ monsqlize: msq });
await pc.init();
const scoped = pc.scope({ tenantId: 'acme' });
const subject = pc.forSubject({ userId: 'u-1', scope: { tenantId: 'acme' } });
const allowed = await subject.can('read', 'db:orders');
await pc.close();
```

```json
{ "allowed": false }
```

With no matching allow rule, `can()` returns `false`; this is default deny, not an error.

## Related

See [Roles](/api/roles), [Authorized Collection](/api/authorized-collection), and [Audit and Health](/api/audit-and-health).
