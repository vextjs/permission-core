# Multi-tenant Permissions

New subject APIs accept a real tenant scope. The legacy `userId` APIs still work and map to the default scope `{ tenantId: "default" }`.

```ts
import { PermissionCore } from "permission-core";

const pc = new PermissionCore();
await pc.init();

const scope = { tenantId: "tenant-a", appId: "admin" };
const subject = { ...scope, userId: "u-1" };
const tenant = pc.scope(scope);

await tenant.roles.create("admin", { label: "Admin" });
await tenant.roles.allow("admin", "read", "ui:menu:system.user");
await tenant.users.assign(subject.userId, "admin");

console.log(await pc.canSubject(subject, "read", "ui:menu:system.user")); // true
console.log(await pc.canSubject(
  { ...subject, tenantId: "tenant-b" },
  "read",
  "ui:menu:system.user",
)); // false

await pc.close();
```

Run the two-tenant proof from the repository root:

```bash
npm run example:multi-tenant
```

`PermissionScope` fields:

| Field | Purpose |
|---|---|
| `tenantId` | Real tenant boundary |
| `appId` | Optional application boundary inside a tenant |
| `moduleId` | Optional module boundary |
| `namespace` | Optional permission domain boundary |

The storage adapters and rule cache include `scopeKey`, so the same `userId` and `roleId` can safely exist in different tenants with different permissions.

`MonSQLizeStorageAdapterOptions.namespace` is still only a physical collection prefix. It is not the same as `PermissionScope.namespace`, and it is not a tenant boundary.

## Boundary rules

- Every subject API requires a non-empty `tenantId`; raw JavaScript calls without it fail instead of falling back to the default tenant.
- `pc.scope(scope).forSubject(subject)` requires the subject scope to exactly match the bound scope.
- The same `userId` and `roleId` may exist in multiple tenants, but roles, rules, user bindings, cache entries, menu assets, revisions, and audits remain partitioned by `scopeKey`.
- Legacy `can(userId, ...)`, `roles`, and `users` use only the configured `defaultScope`. Do not mix them with subject APIs inside a tenant-aware request.

## Production storage

`MemoryAdapter` proves isolation but loses data on restart. Use `FileAdapter` for a single process or `MonSQLizeStorageAdapter` for shared production persistence. If the application also uses the menu module, configure a matching `FileMenuStorageAdapter` or `MonSQLizeMenuStorageAdapter`; core storage does not persist menu assets automatically.

## Failure recovery

| Error | Meaning | Recovery |
|---|---|---|
| `INVALID_ARGUMENT`: `tenantId must be a non-empty string` | The subject did not carry an explicit tenant | Restore tenant identity before authorization; do not substitute a global default |
| `INVALID_ARGUMENT`: `subject scope does not match` | A subject crossed a bound scope | Recreate the scoped context from the authenticated subject |
| Correct user gets no permissions | Role/user binding was created in another scope | Inspect roles and bindings through `pc.scope(theSameScope)` |

For framework header/claim conflict handling, continue with the [vext adapter guide](/guide/vext-adapter).
