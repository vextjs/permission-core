import { PermissionCore } from "permission-core";

const pc = new PermissionCore();
await pc.init();

const tenantA = pc.scope({ tenantId: "tenant-a", appId: "admin" });
const tenantB = pc.scope({ tenantId: "tenant-b", appId: "admin" });

await tenantA.roles.create("manager", { label: "Tenant A Manager" });
await tenantA.roles.allow("manager", "read", "ui:menu:tenant-a.dashboard");
await tenantA.users.assign("same-user", "manager");

await tenantB.roles.create("manager", { label: "Tenant B Manager" });
await tenantB.roles.allow("manager", "read", "ui:menu:tenant-b.dashboard");
await tenantB.users.assign("same-user", "manager");

const result = {
  tenantAOwnMenu: await pc.canSubject(
    { tenantId: "tenant-a", appId: "admin", userId: "same-user" },
    "read",
    "ui:menu:tenant-a.dashboard",
  ),
  tenantACrossMenu: await pc.canSubject(
    { tenantId: "tenant-a", appId: "admin", userId: "same-user" },
    "read",
    "ui:menu:tenant-b.dashboard",
  ),
  tenantBOwnMenu: await pc.canSubject(
    { tenantId: "tenant-b", appId: "admin", userId: "same-user" },
    "read",
    "ui:menu:tenant-b.dashboard",
  ),
};

console.log(JSON.stringify(result, null, 2));

await pc.close();
