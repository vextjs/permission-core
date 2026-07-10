import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PermissionCore } from "../../src";
import {
    createVextPermissionMiddleware,
    createVextPermissionPlugin,
    loadVextRouteManifest,
    normalizeVextRoutes,
    resolveVextRouteResource,
    resolveVextPermissionSubject,
    type VextPermissionMiddleware,
    type VextPermissionApp,
    type VextPermissionRequest,
} from "../../src/adapters/vext";

const tempDirs: string[] = [];

async function createTempFilePath() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "permission-core-vext-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, "routes.json");
}

afterEach(async () => {
    if (process.env.PERMISSION_CORE_RETAIN_TEST_ARTIFACTS === "1") {
        tempDirs.length = 0;
        return;
    }
    await Promise.all(tempDirs.splice(0).map((dirPath) => fs.rm(dirPath, { recursive: true, force: true })));
});

async function createCore() {
    const core = new PermissionCore();
    await core.init();
    const scoped = core.scope({ tenantId: "tenant-a" });
    await scoped.roles.create("api-reader", { label: "API Reader" });
    await scoped.roles.allow("api-reader", "invoke", "api:GET:/api/users");
    await scoped.users.assign("user-1", "api-reader");
    return core;
}

describe("vext adapter", () => {
    it("requires an explicit tenant and rejects conflicting scope sources", async () => {
        const core = new PermissionCore();
        const requestWithoutTenant: VextPermissionRequest = {
            auth: { userId: "user-1" },
        };

        await expect(resolveVextPermissionSubject({ core, tenantRequired: true }, requestWithoutTenant))
            .rejects.toThrow("requires an explicit tenantId");

        const conflictingRequest: VextPermissionRequest = {
            headers: { "X-Tenant-Id": "tenant-b" },
            auth: {
                userId: "user-1",
                claims: { tenantId: "tenant-a" },
            },
        };
        await expect(resolveVextPermissionSubject({ core }, conflictingRequest))
            .rejects.toThrow("Conflicting vext permission tenantId sources");

        await expect(resolveVextPermissionSubject({ core }, {
            headers: { "x-tenant-id": ["tenant-a", "tenant-b"] },
            auth: { userId: "user-1" },
        })).rejects.toThrow("Conflicting vext permission header 'x-tenant-id' values");
    });

    it("rejects conflicting identity claims instead of choosing a precedence", async () => {
        const core = new PermissionCore();
        await expect(resolveVextPermissionSubject({ core }, {
            auth: {
                userId: "user-1",
                subject: "user-2",
                claims: { tenantId: "tenant-a" },
            },
        })).rejects.toThrow("Conflicting vext permission userId sources");
    });

    it("injects req.auth can/assert backed by permission-core", async () => {
        const core = await createCore();
        const middleware = createVextPermissionMiddleware({ core });
        const req: VextPermissionRequest = {
            method: "GET",
            path: "/api/users",
            auth: {
                userId: "user-1",
                claims: {
                    tenantId: "tenant-a",
                },
            },
        };

        await middleware(req, {}, async () => undefined);

        await expect(req.auth!.can?.("invoke")).resolves.toBe(true);
        await expect(req.auth!.assert?.("invoke")).resolves.toBeUndefined();

        const otherTenantReq: VextPermissionRequest = {
            method: "GET",
            path: "/api/users",
            auth: {
                userId: "user-1",
                claims: {
                    tenantId: "tenant-b",
                },
            },
        };
        await middleware(otherTenantReq, {}, async () => undefined);

        await expect(otherTenantReq.auth!.can?.("invoke")).resolves.toBe(false);
    });

    it("resolves native route auth metadata before docs and generated resources", async () => {
        const core = new PermissionCore();
        const req: VextPermissionRequest = {
            method: "GET",
            route: "/api/users/:id",
            _routeOptions: {
                auth: {
                    permissions: [{ action: "read", resource: "urn:user:detail" }],
                },
                docs: { extensions: { "x-permission-resource": "api:GET:/legacy" } },
            },
        };

        await expect(resolveVextRouteResource({ core }, req, "read")).resolves.toBe("urn:user:detail");
        await expect(resolveVextRouteResource({ core, routeResource: () => "urn:user:custom" }, req, "read"))
            .resolves.toBe("urn:user:custom");
        await expect(resolveVextRouteResource({ core }, {
            ...req,
            _routeOptions: {
                auth: {
                    permissions: [
                        { action: "read", resource: "urn:user:first" },
                        { action: "read", resource: "urn:user:second" },
                    ],
                },
            },
        }, "read")).rejects.toThrow("multiple resources");
        await expect(resolveVextRouteResource({ core }, {
            method: "POST",
            url: "/jobs?dryRun=true",
            _routeOptions: { auth: { permissions: ["invoke"] } },
        }, "invoke")).resolves.toBe("api:POST:/jobs");
        await expect(resolveVextRouteResource({ core }, { method: "GET", url: "?health=true" }, "invoke"))
            .resolves.toBe("api:GET:/");
        await expect(resolveVextRouteResource({ core }, {}, "invoke")).resolves.toBeUndefined();
    });

    it("creates a plugin-like object that extends app and registers middleware/close hooks", async () => {
        const core = new PermissionCore();
        const middlewares: VextPermissionMiddleware[] = [];
        const closeHandlers: Array<() => Promise<void> | void> = [];
        const extensions = new Map<string, unknown>();
        const app = {
            extend(key: string, value: unknown) {
                extensions.set(key, value);
            },
            use(middleware: VextPermissionMiddleware) {
                middlewares.push(middleware);
            },
            onClose(handler: () => Promise<void> | void) {
                closeHandlers.push(handler);
            },
        };

        const plugin = createVextPermissionPlugin({ core, ownsCore: true });
        await plugin.setup(app as VextPermissionApp);

        expect(plugin.name).toBe("permission-core");
        expect(extensions.get("permissionCore")).toBe(core);
        expect(middlewares).toHaveLength(1);
        expect(closeHandlers).toHaveLength(1);

        await closeHandlers[0]();
    });

    it("initializes and closes an owned menu once without closing an external core", async () => {
        const core = await createCore();
        const menu = {
            initCount: 0,
            closeCount: 0,
            async init() { this.initCount += 1; },
            async close() { this.closeCount += 1; },
            async getVisibleMenuTree() { return []; },
            async getVisibleButtons() { return {}; },
            async getVisibleMenuSnapshot() { return { data: [], version: "1", etag: '"1"' }; },
            async getButtonPermissionSnapshot() { return { data: {}, version: "1", etag: '"1"' }; },
        };
        const closeHandlers: Array<() => Promise<void> | void> = [];
        const app = {
            extend() {},
            use() {},
            onClose(handler: () => Promise<void> | void) { closeHandlers.push(handler); },
        };

        await createVextPermissionPlugin({ core, menu, init: false, ownsMenu: true })
            .setup(app as unknown as VextPermissionApp);
        expect(menu.initCount).toBe(1);
        expect(closeHandlers).toHaveLength(1);
        await closeHandlers[0]();
        await closeHandlers[0]();
        expect(menu.closeCount).toBe(1);
        await expect(core.canSubject({ tenantId: "tenant-a", userId: "user-1" }, "invoke", "api:GET:/api/users"))
            .resolves.toBe(true);
        await core.close();
    });

    it("loads and normalizes vext route manifests", async () => {
        const filePath = await createTempFilePath();
        await fs.writeFile(filePath, JSON.stringify({
            routes: [
                {
                    method: "get",
                    path: "/api/users",
                    operationId: "listUsers",
                    docsSummary: "List users",
                    tags: ["users"],
                    hidden: false,
                },
                {
                    method: "post",
                    path: "/internal/jobs",
                    operationId: "runJob",
                    hidden: true,
                },
            ],
        }), "utf-8");

        const payload = await loadVextRouteManifest(filePath);

        expect(normalizeVextRoutes(payload)).toEqual({
            bindings: [
                {
                    id: "listUsers",
                    ownerType: "apiGroup",
                    ownerId: "users",
                    method: "GET",
                    path: "/api/users",
                    resource: "api:GET:/api/users",
                    action: "invoke",
                    purpose: "operation",
                    required: true,
                    description: "List users",
                },
            ],
        });

        expect(normalizeVextRoutes({
            routes: [{
                method: "post",
                path: "/api/users",
                operationId: "createUser",
                auth: {
                    mode: "all",
                    permissions: [
                        { action: "invoke", resource: "api:POST:/api/users" },
                        { action: "manage", resource: "urn:user:collection" },
                    ],
                },
            }],
        }).bindings).toEqual([
            expect.objectContaining({
                id: "createUser#1:invoke",
                action: "invoke",
                resource: "api:POST:/api/users",
                permissionGroup: "createUser",
                permissionMode: "all",
            }),
            expect.objectContaining({
                id: "createUser#2:manage",
                action: "manage",
                resource: "urn:user:collection",
                permissionGroup: "createUser",
                permissionMode: "all",
            }),
        ]);
    });
});
