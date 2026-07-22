import { printExample, startExampleCore } from "./_support/host.mjs";

// docs:basic:start
const runtime = await startExampleCore("basic");
const scope = { tenantId: "acme" };
const scoped = runtime.core.scope(scope, {
    actorId: "admin",
    requestId: "req-basic",
});

try {
    await scoped.roles.create({ id: "order-reader", label: "Order reader" });
    await scoped.roles.allow("order-reader", {
        action: "invoke",
        resource: "api:GET:/api/orders",
    });
    await scoped.roles.create({ id: "operator", label: "Operator" });

    // FIRST_SUCCESS:start
    const assigned = await scoped.userRoles.assign("u-1", "order-reader");
    const subject = runtime.core.forSubject({ userId: "u-1", scope });
    const allowed = await subject.can("invoke", "api:GET:/api/orders");
    const cannotDelete = await subject.cannot("invoke", "api:DELETE:/api/orders");
    // FIRST_SUCCESS:end

    await scoped.userRoles.assign("u-1", "operator");
    const beforeSet = await scoped.userRoles.getDirect("u-1");
    const replaced = await scoped.userRoles.set("u-1", ["order-reader"], {
        expectedRevision: beforeSet.data.revision,
    });

    const role = await scoped.roles.get("order-reader");
    const ownRules = await scoped.roles.getOwnRules("order-reader");
    const effectiveRules = await scoped.roles.getEffectiveRules("order-reader");
    const roleChain = await scoped.roles.getChain("order-reader");
    const effectiveRoles = await scoped.userRoles.getEffective("u-1");
    const permissions = await subject.getPermissions();
    const resources = await subject.getResources("invoke");
    const deleteExplanation = await subject.explain("invoke", "api:DELETE:/api/orders");

    printExample("basic", {
        role: { id: role.data.id, label: role.data.label, revision: role.data.revision },
        userRoles: {
            afterAssign: assigned.data.roleIds,
            beforeSet: beforeSet.data.roleIds,
            afterSet: replaced.data.roleIds,
            effective: effectiveRoles.data.effective.items.map((entry) => entry.role.id),
            semantics: {
                assign: "adds one direct role",
                set: "replaces the complete direct-role set at the expected revision",
            },
        },
        permissionChecks: {
            allowed,
            cannotDelete,
            cannotMeaning: "true because can(...) is false; it is not a separate deny assignment",
            deleteReason: deleteExplanation.data.reason,
        },
        reads: {
            ownRules: ownRules.data.map((rule) => `${rule.effect}:${rule.action}:${rule.resource}`),
            effectiveRules: effectiveRules.data.rules.items.map((rule) => `${rule.effect}:${rule.action}:${rule.resource}`),
            roleChain: roleChain.data.map((entry) => entry.role.id),
            permissionRuleCount: permissions.data.rules.total,
            resources: resources.data.map((entry) => entry.resource),
        },
    });
} finally {
    await runtime.close();
}
// docs:basic:end
