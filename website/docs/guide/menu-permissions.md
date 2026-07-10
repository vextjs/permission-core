# Menu Permissions

`permission-core/menu` adds admin-console permissions on top of the core RBAC engine. It models menus, pages, buttons, API bindings, authorization trees, manifest import, validation, and audit records.

Use it when the product needs navigation visibility and role authorization screens. Do not use menu visibility as the backend security boundary.

```ts
import { PermissionCore } from "permission-core";
import { createMenuPermission } from "permission-core/menu";

const pc = new PermissionCore();
await pc.init();

const scope = { tenantId: "tenant-a", appId: "admin" };
const subject = { ...scope, userId: "u-1" };
const tenant = pc.scope(scope);
await tenant.roles.create("operator", { label: "Operator" });
await tenant.roles.allow("operator", "read", "ui:menu:system.user");
await tenant.roles.allow("operator", "read", "ui:page:system.user.list");
await tenant.roles.allow("operator", "invoke", "ui:button:system.user.create");
await tenant.roles.allow("operator", "invoke", "api:POST:/api/users");
await tenant.users.assign(subject.userId, "operator");

const menu = createMenuPermission({ core: pc, strictApiBindings: true });

await menu.importFrontendManifest(scope, {
  nodes: [
    { id: "system", type: "directory", title: "System" },
    {
      id: "system.user",
      parentId: "system",
      type: "menu",
      title: "Users",
      path: "/system/users",
      resource: { action: "read", resource: "ui:menu:system.user" },
    },
    {
      id: "system.user.list",
      parentId: "system.user",
      type: "page",
      title: "User List",
      path: "/system/users",
      hidden: true,
      resource: { action: "read", resource: "ui:page:system.user.list" },
    },
    {
      id: "system.user.create",
      pageId: "system.user.list",
      type: "button",
      code: "create",
      title: "Create User",
      resource: { action: "invoke", resource: "ui:button:system.user.create" },
    },
  ],
  apiBindings: [
    {
      id: "create-user",
      ownerType: "button",
      ownerId: "system.user.create",
      method: "POST",
      path: "/api/users",
      resource: "api:POST:/api/users",
      purpose: "operation",
      required: true,
    },
  ],
});

const tree = await menu.getVisibleMenuTree(subject);
const buttons = await menu.getVisibleButtons(subject, "system.user.list");
console.log(tree[0]?.children?.[0]?.id); // system.user
console.log(buttons.create.visible, buttons.create.enabled); // true true

await menu.close();
await pc.close();
```

Run the maintained version from the repository root:

```bash
npm run example:menu
```

Recommended resource layers:

| Layer | Resource | Meaning |
|---|---|---|
| Menu | `ui:menu:system.user` | Navigation entry visibility |
| Page | `ui:page:system.user.list` | Direct route access |
| Button | `ui:button:system.user.create` | Operation visibility or enabled state |
| API | `api:POST:/api/users` | Backend guard and final authorization |

The backend route should still call `assertSubject(subject, "invoke", "api:POST:/api/users")`.

## Production storage

The core role store and the menu asset store are separate contracts. Production deployments must persist both.

```ts
import { PermissionCore, MonSQLizeStorageAdapter } from "permission-core";
import { MonSQLizeMenuStorageAdapter, createMenuPermission } from "permission-core/menu";

const core = new PermissionCore({ storage: new MonSQLizeStorageAdapter({ msq }) });
await core.init();
const menu = createMenuPermission({
  core,
  storage: new MonSQLizeMenuStorageAdapter({ msq }),
  strictApiBindings: true,
});
await menu.init();
```

Use `FileMenuStorageAdapter({ path })` for a single-process deployment. Its file writes are atomic inside one process, but it is not a distributed multi-writer store. `MemoryMenuStorageAdapter` is for tests and short examples only.

Close the menu manager before the core. Set `ownsConnection: true` on exactly one adapter only when that adapter owns the MonSQLize lifecycle.

## Manifest and authorization workflow

- `importFrontendManifest()` and `importApiManifest()` default to `mode: "replace"`; stale assets are deleted and the returned summary includes inserted, updated, unchanged, deleted, revision, and stable ID lists.
- Use `mode: "merge"` only for intentionally partial imports.
- Run `validate(scope)` before exposing an admin save action. Errors block imports; warnings identify stale rules or role/button/API inconsistencies.
- `getAuthorizationTree(scope, roleId)` returns `sourceRoleIds`, so the UI can explain inherited and conflicting rules.
- `saveRoleAuthorization()` validates every asset, computes an audited diff, and restores the previous rules if the rule write or audit append fails.

## Failure recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `ROLE_NOT_FOUND` | The tutorial skipped role creation | Create the role before calling `allow()` or assigning users |
| `Menu manifest validation failed: V-03` | A button references a missing page, or a parent is absent | Import the complete parent/menu/page/button graph |
| Button is visible but disabled | A `required` API binding is denied in strict mode | Grant one `any` group member or every `all` group member |
| Import reports previous state restored | Storage or audit persistence failed | Fix storage health and retry the complete import; do not apply manual partial writes |

Continue with the [Menu Module API](/api/menu) for exact signatures and storage contracts.
