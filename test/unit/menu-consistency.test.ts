import { describe, expect, it } from "vitest";

import { MemoryAdapter, PermissionCore } from "../../src";
import {
    MemoryMenuStorageAdapter,
    createMenuPermission,
    validateMenuConfiguration,
    type ApiBinding,
    type MenuNode,
    type PermissionAuditEntry,
} from "../../src/menu";
import type { PermissionRule, PermissionScope } from "../../src/types";

const SCOPE = { tenantId: "tenant-a", appId: "admin" };
const SUBJECT = { ...SCOPE, userId: "user-1" };

const NODES: MenuNode[] = [
    { id: "users", type: "menu", title: "Users", resource: { action: "read", resource: "ui:menu:users" } },
    { id: "users.page", parentId: "users", type: "page", title: "Users Page", resource: { action: "read", resource: "ui:page:users" } },
    { id: "users.create", pageId: "users.page", type: "button", title: "Create", resource: { action: "invoke", resource: "ui:button:users.create" } },
];

const API_BINDING: ApiBinding = {
    id: "create-user",
    ownerType: "button",
    ownerId: "users.create",
    method: "POST",
    path: "/api/users",
    resource: "api:POST:/api/users",
    action: "invoke",
    purpose: "operation",
    required: true,
};

class FailingAuditStorage extends MemoryMenuStorageAdapter {
    failNextAudit = false;

    override async appendAuditEntries(scope: PermissionScope, entries: PermissionAuditEntry[]): Promise<void> {
        if (this.failNextAudit) {
            this.failNextAudit = false;
            throw new Error("audit unavailable");
        }
        return super.appendAuditEntries(scope, entries);
    }
}

class FailingManifestStorage extends MemoryMenuStorageAdapter {
    failNextApiReplace = false;

    override async replaceApiBindings(scope: PermissionScope, bindings: ApiBinding[]) {
        if (this.failNextApiReplace) {
            this.failNextApiReplace = false;
            throw new Error("API binding write failed");
        }
        return super.replaceApiBindings(scope, bindings);
    }
}

class FailingRuleStorage extends MemoryAdapter {
    failOnScopedRulesWrite = 0;
    scopedRulesWriteCount = 0;

    override async setScopedRules(scope: PermissionScope, roleId: string, rules: PermissionRule[]): Promise<void> {
        this.scopedRulesWriteCount += 1;
        if (this.failOnScopedRulesWrite === this.scopedRulesWriteCount) {
            throw new Error("rule write failed");
        }
        return super.setScopedRules(scope, roleId, rules);
    }
}

async function createRoleCore(storage: MemoryAdapter = new MemoryAdapter()) {
    const core = new PermissionCore({ storage });
    await core.init();
    const scoped = core.scope(SCOPE);
    await scoped.roles.create("admin", { label: "Admin" });
    await scoped.users.assign("user-1", "admin");
    return { core, scoped };
}

describe("menu import, authorization consistency and cache", () => {
    it("replaces stale manifest assets, returns a stable diff and records import audits", async () => {
        const { core, scoped } = await createRoleCore();
        const storage = new MemoryMenuStorageAdapter();
        const menu = createMenuPermission({ core, storage });
        await menu.importFrontendManifest(SCOPE, { nodes: NODES, apiBindings: [API_BINDING] });
        await scoped.roles.allow("admin", "read", "ui:menu:users");
        await scoped.roles.allow("admin", "invoke", "ui:button:users.create");

        const summary = await menu.importFrontendManifest(SCOPE, {
            nodes: [
                { ...NODES[0], title: "User Management" },
                NODES[1],
            ],
            apiBindings: [],
        }, { actorId: "deployer", reason: "route manifest refresh" });

        expect(summary.nodes).toMatchObject({
            inserted: 0,
            updated: 1,
            deleted: 1,
            changes: { updatedIds: ["users"], deletedIds: ["users.create"] },
        });
        expect(summary.apiBindings).toMatchObject({ deleted: 1, changes: { deletedIds: ["create-user"] } });
        await expect(storage.listApiBindings(SCOPE)).resolves.toEqual([]);
        await expect(menu.listAuditEntries(SCOPE)).resolves.toEqual([
            expect.objectContaining({ action: "manifest.import" }),
            expect.objectContaining({ action: "manifest.import", actorId: "deployer" }),
        ]);
        expect((await menu.validate(SCOPE))).toContainEqual(expect.objectContaining({
            code: "V-10",
            resource: "ui:button:users.create",
        }));

        await menu.importApiManifest(SCOPE, { bindings: [{
            ...API_BINDING,
            id: "health",
            ownerType: "apiGroup",
            ownerId: "system",
            description: "Health endpoint",
        }] });
        const apiSummary = await menu.importApiManifest(SCOPE, { bindings: [] });
        expect(apiSummary.deleted).toBe(1);
        expect(apiSummary.changes.deletedIds).toEqual(["health"]);
    });

    it("rejects invalid manifests before mutation", async () => {
        const { core } = await createRoleCore();
        const storage = new MemoryMenuStorageAdapter();
        const menu = createMenuPermission({ core, storage });
        await menu.importFrontendManifest(SCOPE, NODES);

        await expect(menu.importFrontendManifest(SCOPE, [
            { id: "orphan", parentId: "missing", type: "menu", title: "Orphan" },
        ])).rejects.toThrow("Menu manifest validation failed: V-03");
        await expect(storage.listMenuNodes(SCOPE)).resolves.toEqual(NODES);
    });

    it("restores both asset sets when a manifest write or its audit fails", async () => {
        const { core } = await createRoleCore();
        const storage = new FailingManifestStorage();
        const menu = createMenuPermission({ core, storage });
        await menu.importFrontendManifest(SCOPE, { nodes: NODES, apiBindings: [API_BINDING] });

        storage.failNextApiReplace = true;
        await expect(menu.importFrontendManifest(SCOPE, {
            nodes: NODES.map((node) => node.id === "users" ? { ...node, title: "Changed" } : node),
            apiBindings: [],
        })).rejects.toThrow("previous state was restored");
        await expect(storage.listMenuNodes(SCOPE)).resolves.toEqual(NODES);
        await expect(storage.listApiBindings(SCOPE)).resolves.toEqual([API_BINDING]);

        const auditStorage = new FailingAuditStorage();
        const auditedMenu = createMenuPermission({ core, storage: auditStorage });
        await auditedMenu.importFrontendManifest(SCOPE, { nodes: NODES, apiBindings: [API_BINDING] });
        auditStorage.failNextAudit = true;
        await expect(auditedMenu.importFrontendManifest(SCOPE, {
            nodes: NODES.map((node) => node.id === "users" ? { ...node, title: "Changed" } : node),
            apiBindings: [API_BINDING],
        })).rejects.toThrow("previous state was restored");
        await expect(auditStorage.listMenuNodes(SCOPE)).resolves.toEqual(NODES);
        await expect(auditStorage.listAuditEntries(SCOPE)).resolves.toHaveLength(1);
    });

    it("restores role rules when audit persistence fails and rejects unknown assets", async () => {
        const { core, scoped } = await createRoleCore();
        const storage = new FailingAuditStorage();
        const menu = createMenuPermission({ core, storage });
        await menu.importFrontendManifest(SCOPE, { nodes: NODES, apiBindings: [API_BINDING] });
        await scoped.roles.allow("admin", "read", "ui:menu:users");
        const before = await scoped.roles.getRules("admin");

        storage.failNextAudit = true;
        await expect(menu.saveRoleAuthorization(SCOPE, "admin", {
            allow: [{ action: "invoke", resource: "ui:button:users.create" }],
        })).rejects.toThrow("previous role rules were restored");
        await expect(scoped.roles.getRules("admin")).resolves.toEqual(before);

        await expect(menu.saveRoleAuthorization(SCOPE, "admin", {
            allow: [{ action: "read", resource: "ui:menu:unknown" }],
        })).rejects.toThrow("references an unknown asset");
        await expect(scoped.roles.getRules("admin")).resolves.toEqual(before);
    });

    it("compensates a partial manager write and emits stable added/removed diffs", async () => {
        const ruleStorage = new FailingRuleStorage();
        const { core, scoped } = await createRoleCore(ruleStorage);
        const menu = createMenuPermission({ core });
        await menu.importFrontendManifest(SCOPE, { nodes: NODES, apiBindings: [API_BINDING] });
        await scoped.roles.allow("admin", "read", "ui:menu:users");
        const before = await scoped.roles.getRules("admin");

        ruleStorage.scopedRulesWriteCount = 0;
        ruleStorage.failOnScopedRulesWrite = 2;
        await expect(menu.saveRoleAuthorization(SCOPE, "admin", {
            allow: [
                { action: "read", resource: "ui:page:users" },
                { action: "invoke", resource: "ui:button:users.create" },
            ],
        })).rejects.toThrow("previous role rules were restored");
        await expect(scoped.roles.getRules("admin")).resolves.toEqual(before);

        ruleStorage.failOnScopedRulesWrite = 0;
        const audit = await menu.saveRoleAuthorization(SCOPE, "admin", {
            allow: [
                { action: "invoke", resource: "ui:button:users.create" },
                { action: "invoke", resource: "ui:button:users.create" },
            ],
            revoke: [{ action: "read", resource: "ui:menu:users" }],
        });
        expect(audit.changes).toEqual({
            added: [{ type: "allow", action: "invoke", resource: "ui:button:users.create" }],
            removed: [{ type: "allow", action: "read", resource: "ui:menu:users" }],
        });
    });

    it("versions snapshots with storage revision and effective permission hashes", async () => {
        const { core, scoped } = await createRoleCore();
        const storage = new MemoryMenuStorageAdapter();
        const menu = createMenuPermission({ core, storage, cache: { maxEntries: 4 } });
        await menu.importFrontendManifest(SCOPE, NODES);
        await scoped.roles.allow("admin", "read", "ui:menu:users");
        await scoped.roles.allow("admin", "invoke", "ui:button:users.create");
        await scoped.roles.allow("admin", "invoke", "api:POST:/api/users");
        await menu.importApiManifest(SCOPE, { bindings: [API_BINDING] });

        const first = await menu.getVisibleMenuSnapshot(SUBJECT);
        const cached = await menu.getVisibleMenuSnapshot(SUBJECT);
        expect(cached).toEqual(first);

        await storage.replaceMenuNodes(SCOPE, NODES.map((node) => node.id === "users" ? { ...node, title: "People" } : node));
        const assetChanged = await menu.getVisibleMenuSnapshot(SUBJECT);
        expect(assetChanged.version).not.toBe(first.version);
        expect(assetChanged.etag).not.toBe(first.etag);
        expect(assetChanged.data[0].title).toBe("People");

        const buttonAllowed = await menu.getButtonPermissionSnapshot(SUBJECT, "users.page", { strictApiBindings: true });
        expect(buttonAllowed.data["users.create"]).toMatchObject({ visible: true, enabled: true });
        await scoped.roles.revokeRule("admin", "invoke", "api:POST:/api/users");
        const buttonApiRevoked = await menu.getButtonPermissionSnapshot(SUBJECT, "users.page", { strictApiBindings: true });
        expect(buttonApiRevoked.version).not.toBe(buttonAllowed.version);
        expect(buttonApiRevoked.data["users.create"]).toMatchObject({
            visible: true,
            enabled: false,
            reason: "required-api-denied",
        });

        await scoped.roles.revokeRule("admin", "read", "ui:menu:users");
        const permissionChanged = await menu.getVisibleMenuSnapshot(SUBJECT);
        expect(permissionChanged.version).not.toBe(assetChanged.version);
        expect(permissionChanged.data).toEqual([]);
    });

    it("honors any/all permission groups for required button APIs", async () => {
        const { core, scoped } = await createRoleCore();
        const menu = createMenuPermission({ core });
        await menu.importFrontendManifest(SCOPE, NODES);
        await scoped.roles.allow("admin", "invoke", "ui:button:users.create");
        await scoped.roles.allow("admin", "invoke", "api:POST:/api/users");
        const groupedBindings: ApiBinding[] = [
            { ...API_BINDING, id: "create-user:invoke", permissionGroup: "create-user", permissionMode: "any" },
            { ...API_BINDING, id: "create-user:manage", action: "manage", permissionGroup: "create-user", permissionMode: "any" },
        ];
        await menu.importApiManifest(SCOPE, groupedBindings);

        await expect(menu.getVisibleButtons(SUBJECT, "users.page", { strictApiBindings: true }))
            .resolves.toMatchObject({ "users.create": { visible: true, enabled: true } });

        await menu.importApiManifest(SCOPE, groupedBindings.map((binding) => ({ ...binding, permissionMode: "all" })));
        await expect(menu.getVisibleButtons(SUBJECT, "users.page", { strictApiBindings: true }))
            .resolves.toMatchObject({
                "users.create": { visible: true, enabled: false, reason: "required-api-denied" },
            });
    });

    it("validates binding owners, duplicate ids, role/API consistency and wildcard stale rules", () => {
        const diagnostics = validateMenuConfiguration(NODES, [API_BINDING, API_BINDING], [{
            roleId: "operator",
            rules: [
                { type: "allow", action: "invoke", resource: "ui:button:*" },
                { type: "allow", action: "read", resource: "ui:menu:*" },
            ],
        }]);
        expect(diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "V-09" }),
            expect.objectContaining({ code: "V-13" }),
        ]));
        expect(diagnostics.some((diagnostic) => diagnostic.code === "V-10")).toBe(false);

        const missingOwner = validateMenuConfiguration(NODES, [{ ...API_BINDING, id: "missing", ownerId: "missing" }]);
        expect(missingOwner).toContainEqual(expect.objectContaining({ code: "V-14", severity: "error" }));
    });
});
