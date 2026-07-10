import { describe, expect, it } from "vitest";

import { PermissionCore } from "../../src";
import {
    createMenuPermission,
    MemoryMenuStorageAdapter,
    normalizeApiManifest,
    validateMenuConfiguration,
    type ApiBinding,
    type MenuNode,
} from "../../src/menu";

const TENANT = { tenantId: "tenant-a", appId: "admin" };
const SUBJECT = { ...TENANT, userId: "user-1" };

async function createCore() {
    const core = new PermissionCore();
    await core.init();
    const scoped = core.scope(TENANT);
    await scoped.roles.create("admin", { label: "Admin" });
    await scoped.users.assign("user-1", "admin");
    return { core, scoped };
}

const USER_MENU_NODES: MenuNode[] = [
    {
        id: "system",
        type: "directory",
        title: "System",
        order: 1,
    },
    {
        id: "system.user",
        parentId: "system",
        type: "menu",
        title: "Users",
        path: "/system/users",
        order: 1,
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
];

const USER_API_BINDINGS: ApiBinding[] = [
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
];

describe("permission-core/menu", () => {
    it("keeps menu tree and button snapshot cache keys injective for delimiter-heavy identifiers", async () => {
        const core = new PermissionCore();
        await core.init();
        const menu = createMenuPermission({ core });

        const tree = await menu.getVisibleMenuSnapshot({
            tenantId: "default",
            userId: "a|buttons:p:false",
        });
        const buttons = await menu.getButtonPermissionSnapshot({
            tenantId: "default",
            userId: "a",
        }, "p:false|tree");

        expect(tree.data).toEqual([]);
        expect(buttons.data).toEqual({});
        expect(Array.isArray(buttons.data)).toBe(false);
        await menu.close();
        await core.close();
    });

    it("builds visible menu trees and button maps from scoped permissions", async () => {
        const { core, scoped } = await createCore();
        await scoped.roles.allow("admin", "read", "ui:menu:system.user");
        await scoped.roles.allow("admin", "read", "ui:page:system.user.list");
        await scoped.roles.allow("admin", "invoke", "ui:button:system.user.create");
        await scoped.roles.allow("admin", "invoke", "api:POST:/api/users");

        const menu = createMenuPermission({ core, strictApiBindings: true });
        await menu.importFrontendManifest(TENANT, {
            nodes: USER_MENU_NODES,
            apiBindings: USER_API_BINDINGS,
        });

        await expect(menu.getVisibleMenuTree(SUBJECT)).resolves.toEqual([
            expect.objectContaining({
                id: "system",
                children: [
                    expect.objectContaining({
                        id: "system.user",
                    }),
                ],
            }),
        ]);

        await expect(menu.getRoutePermission(SUBJECT, "/system/users")).resolves.toMatchObject({
            allowed: true,
            resource: "ui:page:system.user.list",
        });

        await expect(menu.getVisibleButtons(SUBJECT, "system.user.list")).resolves.toMatchObject({
            create: {
                visible: true,
                enabled: true,
                resource: "ui:button:system.user.create",
                apiBindings: ["api:POST:/api/users"],
            },
            delete: {
                visible: false,
                enabled: false,
                reason: "permission-denied",
            },
        });
    });

    it("can disable a visible button when required API permission is missing", async () => {
        const { core, scoped } = await createCore();
        await scoped.roles.allow("admin", "invoke", "ui:button:system.user.create");

        const menu = createMenuPermission({ core, strictApiBindings: true });
        await menu.importFrontendManifest(TENANT, {
            nodes: USER_MENU_NODES,
            apiBindings: USER_API_BINDINGS,
        });

        await expect(menu.getVisibleButtons(SUBJECT, "system.user.list")).resolves.toMatchObject({
            create: {
                visible: true,
                enabled: false,
                reason: "required-api-denied",
            },
        });
    });

    it("does not let a menu permission bypass the page permission for a shared route", async () => {
        const { core, scoped } = await createCore();
        await scoped.roles.allow("admin", "read", "ui:menu:system.user");
        const menu = createMenuPermission({ core });
        await menu.importFrontendManifest(TENANT, USER_MENU_NODES);

        await expect(menu.getRoutePermission(SUBJECT, "/system/users")).resolves.toMatchObject({
            allowed: false,
            reason: "permission-denied",
            resource: "ui:page:system.user.list",
        });
    });

    it("fails closed when a route has multiple page authorization owners", async () => {
        const { core } = await createCore();
        const storage = new MemoryMenuStorageAdapter();
        await storage.init();
        await storage.upsertMenuNodes(TENANT, [
            { id: "page-a", type: "page", title: "A", path: "/conflict" },
            { id: "page-b", type: "page", title: "B", path: "/conflict" },
        ]);
        const menu = createMenuPermission({ core, storage });

        await expect(menu.getRoutePermission(SUBJECT, "/conflict")).resolves.toEqual({
            allowed: false,
            reason: "route-conflict",
        });
    });

    it("normalizes API manifests", () => {
        expect(normalizeApiManifest({
            routes: [
                {
                    operationId: "listUsers",
                    method: "get",
                    path: "/api/users",
                    ownerId: "system.user.list",
                    ownerType: "page",
                    purpose: "entry",
                    required: true,
                },
            ],
        })).toEqual({
            bindings: [
                {
                    id: "listUsers",
                    ownerType: "page",
                    ownerId: "system.user.list",
                    method: "GET",
                    path: "/api/users",
                    resource: "api:GET:/api/users",
                    action: "invoke",
                    purpose: "entry",
                    required: true,
                    description: undefined,
                },
            ],
        });
    });

    it("validates menu configuration and stale role rules", () => {
        const diagnostics = validateMenuConfiguration(
            [
                { id: "root", type: "directory", title: "Root" },
                { id: "child", parentId: "missing", type: "menu", title: "Child" },
                { id: "button-a", pageId: "page-a", type: "button", code: "delete", title: "Delete" },
                { id: "button-b", pageId: "page-a", type: "button", code: "delete", title: "Delete again" },
            ],
            [
                {
                    id: "bad-api",
                    ownerType: "page",
                    ownerId: "page-a",
                    method: "GET",
                    path: "/api/users/:id",
                    resource: "api:POST:/api/users/:id",
                    purpose: "entry",
                },
            ],
            [
                { type: "allow", action: "read", resource: "ui:menu:missing" },
            ],
        );

        expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
            expect.arrayContaining(["V-03", "V-05", "V-07", "V-10"]),
        );
    });

    it("allows a menu and page to share a route but rejects duplicate page owners", () => {
        const sharedRouteDiagnostics = validateMenuConfiguration([
            { id: "menu", type: "menu", title: "Menu", path: "/users" },
            { id: "page", type: "page", title: "Page", path: "/users" },
        ], []);
        expect(sharedRouteDiagnostics.some((diagnostic) => diagnostic.code === "V-04")).toBe(false);

        const duplicatePageDiagnostics = validateMenuConfiguration([
            { id: "page-a", type: "page", title: "A", path: "/users" },
            { id: "page-b", type: "page", title: "B", path: "/users" },
        ], []);
        expect(duplicatePageDiagnostics).toContainEqual(expect.objectContaining({
            code: "V-04",
            severity: "error",
        }));
    });
});
