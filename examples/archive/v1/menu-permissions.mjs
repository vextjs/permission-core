import { PermissionCore } from "permission-core";
import { createMenuPermission } from "permission-core/menu";

const scope = { tenantId: "tenant-a", appId: "admin" };
const subject = { ...scope, userId: "user-1" };

const pc = new PermissionCore();
await pc.init();

const tenant = pc.scope(scope);
await tenant.roles.create("user-operator", { label: "User Operator" });
await tenant.roles.allow("user-operator", "read", "ui:menu:system.user");
await tenant.roles.allow("user-operator", "read", "ui:page:system.user.list");
await tenant.roles.allow("user-operator", "invoke", "ui:button:system.user.create");
await tenant.roles.allow("user-operator", "invoke", "api:POST:/api/users");
await tenant.users.assign("user-1", "user-operator");

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
    {
      id: "system.user.delete",
      pageId: "system.user.list",
      type: "button",
      code: "delete",
      title: "Delete User",
      resource: { action: "invoke", resource: "ui:button:system.user.delete" },
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
    {
      id: "delete-user",
      ownerType: "button",
      ownerId: "system.user.delete",
      method: "DELETE",
      path: "/api/users/:id",
      resource: "api:DELETE:/api/users/:id",
      purpose: "operation",
      required: true,
    },
  ],
});

const tree = await menu.getVisibleMenuTree(subject);
const buttons = await menu.getVisibleButtons(subject, "system.user.list");

await pc.assertSubject(subject, "invoke", "api:POST:/api/users");

console.log(JSON.stringify({
  visibleRoot: tree[0]?.id,
  visibleMenu: tree[0]?.children?.[0]?.id,
  createButton: buttons.create,
  deleteButton: buttons.delete,
}, null, 2));

await menu.close();
await pc.close();
