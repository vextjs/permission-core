import { describe, expect, it } from "vitest";

import { PermissionCore } from "../../src";
import {
    createMenuPermission,
    type AuthorizationTreeNode,
    type ApiBinding,
    type MenuNode,
} from "../../src/menu";

const TENANT = { tenantId: "tenant-a", appId: "admin" };

const NODES: MenuNode[] = [
    { id: "system", type: "directory", title: "System" },
    {
        id: "system.user",
        parentId: "system",
        type: "menu",
        title: "Users",
        resource: { action: "read", resource: "ui:menu:system.user" },
    },
    {
        id: "system.user.list",
        parentId: "system.user",
        type: "page",
        title: "User List",
        resource: { action: "read", resource: "ui:page:system.user.list" },
    },
    {
        id: "system.user.create",
        pageId: "system.user.list",
        type: "button",
        code: "create",
        title: "Create",
        resource: { action: "invoke", resource: "ui:button:system.user.create" },
    },
];

const API_BINDINGS: ApiBinding[] = [
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
];

function findNode(nodes: AuthorizationTreeNode[], id: string): AuthorizationTreeNode | undefined {
    for (const node of nodes) {
        if (node.id === id) {
            return node;
        }

        const child = findNode(node.children ?? [], id);
        if (child) {
            return child;
        }
    }

    return undefined;
}

describe("menu authorization tree and audit", () => {
    it("generates role authorization states and records audited saves", async () => {
        const core = new PermissionCore();
        await core.init();
        const scoped = core.scope(TENANT);
        await scoped.roles.create("viewer", { label: "Viewer" });
        await scoped.roles.allow("viewer", "read", "ui:menu:system.user");
        await scoped.roles.create("admin", { label: "Admin", parent: "viewer" });

        const menu = createMenuPermission({ core });
        await menu.importFrontendManifest(TENANT, {
            nodes: NODES,
            apiBindings: API_BINDINGS,
        });

        const audit = await menu.saveRoleAuthorization(TENANT, "admin", {
            actorId: "operator-1",
            reason: "grant create button but block API",
            allow: [
                { action: "invoke", resource: "ui:button:system.user.create" },
            ],
            deny: [
                { action: "invoke", resource: "api:POST:/api/users" },
            ],
        });

        expect(audit).toMatchObject({
            actorId: "operator-1",
            roleId: "admin",
            action: "role-authorization.save",
        });

        await expect(menu.listAuditEntries(TENANT)).resolves.toEqual([
            expect.objectContaining({ action: "manifest.import" }),
            expect.objectContaining({ action: "role-authorization.save", roleId: "admin" }),
        ]);

        const tree = await menu.getAuthorizationTree(TENANT, "admin");
        expect(findNode(tree, "system.user")).toMatchObject({
            state: "inherit-allow",
            resource: "ui:menu:system.user",
            sourceRoleIds: ["viewer"],
        });
        expect(findNode(tree, "system.user.create")).toMatchObject({
            state: "allow",
            resource: "ui:button:system.user.create",
            sourceRoleIds: ["admin"],
        });
        expect(findNode(tree, "api:create-user")).toMatchObject({
            state: "deny",
            resource: "api:POST:/api/users",
            sourceRoleIds: ["admin"],
        });
    });

    it("reports every inherited role that contributes to a conflict", async () => {
        const core = new PermissionCore();
        await core.init();
        const scoped = core.scope(TENANT);
        await scoped.roles.create("base", { label: "Base" });
        await scoped.roles.allow("base", "read", "ui:menu:system.user");
        await scoped.roles.create("restricted", { label: "Restricted", parent: "base" });
        await scoped.roles.deny("restricted", "read", "ui:menu:system.user");
        await scoped.roles.create("operator", { label: "Operator", parent: "restricted" });
        const menu = createMenuPermission({ core });
        await menu.importFrontendManifest(TENANT, NODES);

        const tree = await menu.getAuthorizationTree(TENANT, "operator");
        expect(findNode(tree, "system.user")).toMatchObject({
            state: "conflict",
            sourceRoleIds: ["restricted", "base"],
        });

        await menu.close();
        await core.close();
    });
});
