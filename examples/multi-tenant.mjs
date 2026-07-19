import { printExample, startExampleCore } from "./_support/host.mjs";

// docs:multi-tenant:start
const runtime = await startExampleCore("multi-tenant");
const scopeA = { tenantId: "tenant-a", appId: "admin" };
const scopeB = { tenantId: "tenant-b", appId: "admin" };
const tenantA = runtime.core.scope(scopeA);
const tenantB = runtime.core.scope(scopeB);

try {
    await tenantA.roles.create({ id: "manager", label: "Tenant A manager" });
    await tenantA.roles.allow("manager", { action: "read", resource: "ui:page:tenant-a-dashboard" });
    await tenantA.userRoles.assign("same-user", "manager");

    await tenantB.roles.create({ id: "manager", label: "Tenant B manager" });
    await tenantB.roles.allow("manager", { action: "read", resource: "ui:page:tenant-b-dashboard" });
    await tenantB.userRoles.assign("same-user", "manager");

    const subjectA = runtime.core.forSubject({ userId: "same-user", scope: scopeA });
    const subjectB = runtime.core.forSubject({ userId: "same-user", scope: scopeB });
    const rolesA = await tenantA.userRoles.getDirect("same-user");
    const rolesB = await tenantB.userRoles.getDirect("same-user");

    printExample("multi-tenant", {
        identity: "the same userId and roleId are scoped independently",
        tenantA: {
            directRoles: rolesA.data.roleIds,
            ownResource: await subjectA.can("read", "ui:page:tenant-a-dashboard"),
            crossTenantResource: await subjectA.can("read", "ui:page:tenant-b-dashboard"),
        },
        tenantB: {
            directRoles: rolesB.data.roleIds,
            ownResource: await subjectB.can("read", "ui:page:tenant-b-dashboard"),
            crossTenantResource: await subjectB.can("read", "ui:page:tenant-a-dashboard"),
        },
    });
} finally {
    await runtime.close();
}
// docs:multi-tenant:end
