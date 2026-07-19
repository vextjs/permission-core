import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionCore } from "../../src";
import type {
    MenuManifestInput,
    MenuPermissionChange,
    MenuPermissionSelection,
    PermissionScope,
} from "../../src/types";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import { deepFreeze } from "../../src/internal/plain-data";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import {
    MenuManifestService,
    MenuNodeImpactMutationService,
} from "../../src/menu";
import {
    createRoleMenuAggregateFields,
    createRoleMenuGrantSnapshot,
} from "../../src/menu/source-rewrite";
import { MenuScopeReader } from "../../src/menu/store";
import { PermissionRepository } from "../../src/persistence/repository";
import { createMenuSourceId } from "../../src/rbac/materialize";
import { RbacScopeReader } from "../../src/rbac/store";
import { normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const PREFIX = `pc_b43_reads_${randomUUID().replaceAll("-", "")}`;

function scope(label: string): PermissionScope {
    return { tenantId: `tenant-${label}-${randomUUID()}` };
}

function createRepository(context: RealMongoContext, schemes: ResourceSchemeRegistry) {
    return new PermissionRepository(context.monsqlize, PREFIX, {
        schemeContractDigest: schemes.schemeContractDigest,
        schemaContractKey: digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: 2,
            schemeContractDigest: schemes.schemeContractDigest,
        }),
    });
}

async function importManifest(
    service: MenuManifestService,
    targetScope: PermissionScope,
    input: MenuManifestInput,
) {
    const preview = await service.preview(targetScope, input, { actorId: "admin" });
    if (!preview.executable) {
        throw new Error(`manifest conflicts: ${preview.conflicts.items.map((item) => item.code).join(",")}`);
    }
    return service.import(targetScope, input, {
        ...preview.expected,
        previewToken: preview.previewToken,
        actorId: "admin",
        idempotencyKey: `manifest-${randomUUID()}`,
    });
}

async function executeMenuChange(
    manager: ReturnType<PermissionCore["scope"]>["roles"]["menuPermissions"],
    roleId: string,
    change: MenuPermissionChange,
) {
    const preview = await manager.preview(roleId, change, { actorId: "admin" });
    if (!preview.executable) {
        throw new Error(`menu grant conflicts: ${preview.conflicts.items.map((item) => item.code).join(",")}`);
    }
    const options = {
        ...preview.expected,
        previewToken: preview.previewToken,
        actorId: "admin",
        idempotencyKey: `role-menu-${randomUUID()}`,
    };
    if (change.operation === "grant") return manager.grant(roleId, change.selection, options);
    if (change.operation === "deny") return manager.deny(roleId, change.selection, options);
    if (change.operation === "revoke") return manager.revoke(roleId, { grantIds: change.grantIds }, options);
    if (change.operation === "set") return manager.set(roleId, change.assignments, options);
    throw new Error("Unsupported role-menu change.");
}

describe("role menu reads, drift, integrity, and repair on MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let core: PermissionCore;
    let repository: PermissionRepository;
    let schemes: ResourceSchemeRegistry;
    let manifests: MenuManifestService;
    let menuImpacts: MenuNodeImpactMutationService;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 97 });
        schemes = new ResourceSchemeRegistry();
        repository = createRepository(context, schemes);
        core = new PermissionCore({
            monsqlize: context.monsqlize,
            collectionPrefix: PREFIX,
            tokenSecret: "permission-core-role-menu-read-token-secret",
        });
        await core.init();
        const tokens = new SignedTokenCodec(Buffer.alloc(32, 91), "role-menu-read-tests");
        manifests = new MenuManifestService(repository, schemes, tokens);
        menuImpacts = new MenuNodeImpactMutationService(repository, schemes, tokens);
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await core?.close();
        await context?.close();
    }, TEST_TIMEOUT);

    it("projects direct and inherited grants with deny conflicts and no role-level allowed boolean", async () => {
        const targetScope = scope("inheritance");
        const scoped = core.scope(targetScope);
        await scoped.roles.create({ id: "base", label: "Base" });
        await scoped.roles.create({ id: "child", label: "Child", parentId: "base" });
        await scoped.userRoles.assign("u-inheritance", "child");
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                {
                    id: "orders",
                    parentId: "root",
                    type: "page",
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission: { action: "read", resource: "ui:page:orders" },
                    order: 0,
                },
            ],
            apiBindings: [{
                id: "orders-read",
                method: "GET",
                path: "/api/orders",
                purpose: "entry",
                authorization: {
                    mode: "all",
                    permissions: [{ action: "read", resource: "api:GET:/api/orders" }],
                },
                owners: [{ type: "page", id: "orders", required: true }],
                canonicalOwner: { type: "page", id: "orders" },
            }],
        });
        const selection: MenuPermissionSelection = {
            nodeIds: ["orders"],
            include: { descendants: false, buttons: false, apis: "required", dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        await executeMenuChange(scoped.roles.menuPermissions, "base", { operation: "grant", selection });
        const manualGrant = await scoped.roles.allow("base", { action: "read", resource: "ui:page:orders" });
        expect(manualGrant).toMatchObject({ changed: true });
        expect(manualGrant.data.sources.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "menu" }),
            expect.objectContaining({ kind: "manual", state: "active" }),
        ]));
        const repeatedManualGrant = await scoped.roles.allow(
            "base",
            { action: "read", resource: "ui:page:orders" },
        );
        expect(repeatedManualGrant).toMatchObject({ changed: false });
        expect(repeatedManualGrant.data.sources.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "menu" }),
            expect.objectContaining({ kind: "manual", state: "active" }),
        ]));
        await executeMenuChange(scoped.roles.menuPermissions, "child", { operation: "deny", selection });

        const direct = await scoped.roles.menuPermissions.getDirect("base");
        const effective = await scoped.roles.menuPermissions.getEffective("child");
        const tree = await scoped.roles.menuPermissions.getAuthorizationTree("child");
        const ownRules = await scoped.roles.getOwnRules("base");
        const orders = tree.data[0]!.children[0]!;

        expect(direct.data.grants).toHaveLength(1);
        expect(direct.data.grants[0]).toMatchObject({
            effect: "allow",
            sourceStatus: { integrity: "valid", availability: "active", drift: "current" },
        });
        expect(effective.data.grants.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ sourceRoleId: "base", inherited: true, depth: 1, effect: "allow" }),
            expect.objectContaining({ sourceRoleId: "child", inherited: false, depth: 0, effect: "deny" }),
        ]));
        expect(effective.data.conflicts.total).toBe(2);
        expect(orders).toMatchObject({ state: "conflict", selection: "all" });
        expect(orders.apiBindingStates.items[0]).toMatchObject({ coverage: "conflict" });
        expect(JSON.stringify(tree.data)).not.toMatch(/"allowed"/u);
        const ownPageRule = ownRules.data.find((rule) => rule.resource === "ui:page:orders")!;
        expect(ownPageRule.sources.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "menu",
                state: { integrity: "valid", availability: "active", drift: "current" },
            }),
            expect.objectContaining({ kind: "manual", state: "active" }),
        ]));
        await expect(core.can({ userId: "u-inheritance", scope: targetScope }, "read", "ui:page:orders"))
            .resolves.toBe(false);

        await expect(scoped.roles.revoke("base", {
            effect: "allow",
            action: "read",
            resource: "ui:page:orders",
        })).resolves.toMatchObject({ changed: true, data: { removed: 1 } });
        const afterRevoke = await scoped.roles.getOwnRules("base");
        const menuOnlyPageRule = afterRevoke.data.find((rule) => rule.resource === "ui:page:orders")!;
        expect(menuOnlyPageRule.sources.items).toEqual([
            expect.objectContaining({ kind: "menu" }),
        ]);
    }, TEST_TIMEOUT);

    it("keeps future assets unauthorized and treats inactive menu and manual sources independently", async () => {
        const targetScope = scope("drift");
        const scoped = core.scope(targetScope);
        await scoped.roles.create({ id: "operator", label: "Operator" });
        await scoped.roles.allow("operator", { action: "read", resource: "ui:page:orders" });
        await scoped.userRoles.assign("u-drift", "operator");
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [{
                id: "orders",
                type: "page",
                title: "Orders",
                path: "/orders",
                name: "orders",
                component: "OrdersPage",
                permission: { action: "read", resource: "ui:page:orders" },
                order: 0,
            }],
            apiBindings: [{
                id: "orders-read",
                method: "GET",
                path: "/api/orders",
                purpose: "entry",
                authorization: {
                    mode: "all",
                    permissions: [{ action: "read", resource: "api:GET:/api/orders" }],
                },
                owners: [{ type: "page", id: "orders", required: true }],
            }],
        });
        const selection: MenuPermissionSelection = {
            nodeIds: ["orders"],
            include: { descendants: false, buttons: true, apis: "required", dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        await executeMenuChange(scoped.roles.menuPermissions, "operator", { operation: "grant", selection });
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "merge",
            nodes: [
                {
                    id: "orders",
                    type: "page",
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission: { action: "read", resource: "ui:page:orders" },
                    order: 0,
                },
                {
                    id: "order-detail",
                    parentId: "orders",
                    type: "button",
                    title: "Order detail",
                    code: "view-detail",
                    permission: { action: "read", resource: "ui:button:order-detail" },
                    order: 0,
                },
            ],
            apiBindings: [],
        });

        const drifted = await scoped.roles.menuPermissions.getDirect("operator");
        expect(drifted.data.grants[0]!.sourceStatus).toMatchObject({
            integrity: "valid",
            availability: "active",
            drift: "refresh-available",
        });
        await expect(core.can({ userId: "u-drift", scope: targetScope }, "read", "ui:button:order-detail"))
            .resolves.toBe(false);

        const preview = await menuImpacts.previewSetStatus(targetScope, "orders", "disabled", { actorId: "admin" });
        expect(preview.executable).toBe(true);
        if (!preview.executable) throw new Error("status preview unexpectedly blocked");
        await menuImpacts.setStatus(targetScope, "orders", "disabled", {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: `status-${randomUUID()}`,
        });

        const inactive = await scoped.roles.menuPermissions.getDirect("operator");
        const rules = await scoped.roles.getOwnRules("operator");
        const uiRule = rules.data.find((rule) => rule.resource === "ui:page:orders")!;
        expect(inactive.data.grants[0]!.sourceStatus).toMatchObject({
            integrity: "valid",
            availability: "inactive",
            drift: "refresh-available",
        });
        expect(uiRule.sources.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "manual", state: "active" }),
            expect.objectContaining({
                kind: "menu",
                state: { integrity: "valid", availability: "inactive", drift: "refresh-available" },
                stateReason: "asset-disabled",
            }),
        ]));
        await expect(core.can({ userId: "u-drift", scope: targetScope }, "read", "ui:page:orders"))
            .resolves.toBe(true);
        await expect(core.can({ userId: "u-drift", scope: targetScope }, "read", "api:GET:/api/orders"))
            .resolves.toBe(false);
    }, TEST_TIMEOUT);

    it("fails subject snapshots closed and repairs a selected invalid reference by explicit revoke", async () => {
        const targetScope = scope("repair");
        const normalizedScope = normalizeScope(targetScope);
        const scoped = core.scope(targetScope);
        await scoped.roles.create({ id: "repair-role", label: "Repair role" });
        await scoped.userRoles.assign("u-repair", "repair-role");
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [{
                id: "reports",
                type: "page",
                title: "Reports",
                path: "/reports",
                name: "reports",
                component: "ReportsPage",
                permission: { action: "read", resource: "ui:page:reports" },
                order: 0,
            }],
            apiBindings: [],
        });
        const selection: MenuPermissionSelection = {
            nodeIds: ["reports"],
            include: { descendants: false, buttons: false, apis: "none", dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        await executeMenuChange(scoped.roles.menuPermissions, "repair-role", { operation: "grant", selection });

        const state = await repository.scopeStates.read(normalizedScope);
        const rbacReader = new RbacScopeReader(repository, schemes, state);
        const menuReader = new MenuScopeReader(repository, schemes, state);
        const role = await rbacReader.requireRole("repair-role");
        const beforeRules = await rbacReader.readRulesForRole("repair-role");
        const beforeGrants = await menuReader.readGrantsForRole("repair-role");
        const grant = beforeGrants[0]!;
        const nextGrantRevision = grant.grantRevision + 1;
        const afterRules = beforeRules.map((rule) => deepFreeze({
            ...rule,
            sources: rule.sources.map((source) => {
                if (source.kind !== "menu") return source;
                const assetId = "missing-reports";
                return deepFreeze({
                    ...source,
                    assetId,
                    grantRevision: nextGrantRevision,
                    sourceId: createMenuSourceId({
                        grantId: source.grantId,
                        semanticKey: rule.semanticKey,
                        contribution: source.contribution,
                        assetId,
                        ...(source.contribution === "api" ? { apiBindingId: source.apiBindingId } : {}),
                        ...(source.contribution === "data" ? { dataResource: source.dataResource } : {}),
                    }),
                });
            }),
            revision: rule.revision + 1,
            updatedAt: rule.updatedAt + 1,
        }));
        const contributions = afterRules.flatMap((rule) => rule.sources.flatMap((source) => (
            source.kind === "menu" ? [{ rule, source }] : []
        )));
        const afterGrant = deepFreeze({
            ...grant,
            grantRevision: nextGrantRevision,
            snapshot: createRoleMenuGrantSnapshot(grant.intent, contributions),
            updatedAt: grant.updatedAt + 1,
        });
        const aggregate = createRoleMenuAggregateFields([afterGrant], afterRules);
        await repository.collections.roleRules.updateOne(
            { scopeKey: state.scopeKey, roleId: "repair-role", semanticKey: afterRules[0]!.semanticKey },
            { $set: {
                sources: afterRules[0]!.sources,
                revision: afterRules[0]!.revision,
                updatedAt: afterRules[0]!.updatedAt,
            } },
            { cache: { invalidate: false } },
        );
        await repository.collections.roleMenuGrants.updateOne(
            { scopeKey: state.scopeKey, roleId: "repair-role", grantId: grant.grantId },
            { $set: {
                snapshot: afterGrant.snapshot,
                grantRevision: afterGrant.grantRevision,
                updatedAt: afterGrant.updatedAt,
            } },
            { cache: { invalidate: false } },
        );
        await repository.collections.roles.updateOne(
            { scopeKey: state.scopeKey, roleId: "repair-role", revision: role.revision },
            { $set: { ...aggregate, revision: role.revision + 1, updatedAt: role.updatedAt + 1 } },
            { cache: { invalidate: false } },
        );

        await expect(core.can({ userId: "u-repair", scope: targetScope }, "read", "ui:page:reports"))
            .rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        const direct = await scoped.roles.menuPermissions.getDirect("repair-role");
        expect(direct.data.grants[0]!.sourceStatus.integrity).toBe("invalid");
        const effective = await scoped.roles.menuPermissions.getEffective("repair-role");
        expect(effective.data.grants.items[0]!.sourceStatus.integrity).toBe("invalid");
        const tree = await scoped.roles.menuPermissions.getAuthorizationTree("repair-role");
        expect(tree.data[0]!.sourceStatus).toMatchObject({ integrity: "invalid" });
        const effectiveRules = await scoped.roles.getEffectiveRules("repair-role");
        const reportsRule = effectiveRules.data.rules.items
            .find((rule) => rule.resource === "ui:page:reports")!;
        expect(reportsRule.sources.items).toEqual([
            expect.objectContaining({
                kind: "menu",
                state: expect.objectContaining({ integrity: "invalid" }),
            }),
        ]);
        await expect(scoped.roles.getChain("repair-role")).resolves.toMatchObject({
            data: [expect.objectContaining({ role: expect.objectContaining({ id: "repair-role" }) })],
        });
        await expect(scoped.userRoles.getEffective("u-repair")).resolves.toMatchObject({
            data: {
                userId: "u-repair",
                effective: { items: [expect.objectContaining({ role: expect.objectContaining({ id: "repair-role" }) })] },
            },
        });
        const stale = await scoped.roles.menuPermissions.listStale();
        expect(stale.items).toEqual([expect.objectContaining({
            roleId: "repair-role",
            grantId: grant.grantId,
            reason: "asset-missing",
        })]);
        const sourceId = stale.items[0]!.sourceId;
        const rejected = await scoped.roles.menuPermissions.previewRepairStale(
            { sourceIds: [sourceId] },
            { actorId: "admin" },
        );
        expect(rejected.executable).toBe(false);
        expect(rejected.conflicts.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "SOURCE_REWRITE_REQUIRED", id: sourceId }),
        ]));
        const repairInput = {
            sourceIds: [sourceId],
            sourceRewrite: { mode: "apply" as const, resolutions: { [sourceId]: { action: "revoke" as const } } },
        };
        const repairPreview = await scoped.roles.menuPermissions.previewRepairStale(repairInput, { actorId: "admin" });
        expect(repairPreview.executable).toBe(true);
        if (!repairPreview.executable) throw new Error("repair preview unexpectedly blocked");
        const repaired = await scoped.roles.menuPermissions.repairStale(repairInput, {
            ...repairPreview.expected,
            previewToken: repairPreview.previewToken,
            actorId: "admin",
            idempotencyKey: `repair-${randomUUID()}`,
        });
        expect(repaired).toMatchObject({ changed: true, data: { deleted: 1 } });
        await expect(core.can({ userId: "u-repair", scope: targetScope }, "read", "ui:page:reports"))
            .resolves.toBe(false);
        expect((await scoped.roles.menuPermissions.listStale()).items).toEqual([]);
        expect((await scoped.roles.menuPermissions.getDirect("repair-role")).data.grants).toEqual([]);
    }, TEST_TIMEOUT);

    it("invalidates authorization cursors and ETags when only the menu revision changes", async () => {
        const targetScope = scope("menu-revision");
        const scoped = core.scope(targetScope);
        await scoped.roles.create({ id: "cursor-role", label: "Cursor role" });
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                {
                    id: "alpha",
                    type: "page",
                    title: "Alpha",
                    path: "/alpha",
                    name: "alpha",
                    component: "AlphaPage",
                    permission: { action: "read", resource: "ui:page:alpha" },
                    order: 0,
                },
                {
                    id: "beta",
                    type: "page",
                    title: "Beta",
                    path: "/beta",
                    name: "beta",
                    component: "BetaPage",
                    permission: { action: "read", resource: "ui:page:beta" },
                    order: 1,
                },
            ],
            apiBindings: [],
        });
        const selection = (nodeId: string): MenuPermissionSelection => ({
            nodeIds: [nodeId],
            include: { descendants: false, buttons: false, apis: "none", dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        });
        await executeMenuChange(scoped.roles.menuPermissions, "cursor-role", {
            operation: "grant",
            selection: selection("alpha"),
        });
        await executeMenuChange(scoped.roles.menuPermissions, "cursor-role", {
            operation: "grant",
            selection: selection("beta"),
        });

        const directPage = await scoped.roles.menuPermissions.listDirect("cursor-role", { first: 1 });
        const ownRulesPage = await scoped.roles.listOwnRules("cursor-role", { first: 1 });
        expect(directPage.pageInfo).toMatchObject({ hasNext: true, endCursor: expect.any(String) });
        expect(ownRulesPage.pageInfo).toMatchObject({ hasNext: true, endCursor: expect.any(String) });
        const before = {
            direct: (await scoped.roles.menuPermissions.getDirect("cursor-role")).etag,
            effective: (await scoped.roles.menuPermissions.getEffective("cursor-role")).etag,
            tree: (await scoped.roles.menuPermissions.getAuthorizationTree("cursor-role")).etag,
            ownRules: (await scoped.roles.getOwnRules("cursor-role")).etag,
            effectiveRules: (await scoped.roles.getEffectiveRules("cursor-role")).etag,
        };

        const preview = await menuImpacts.previewSetStatus(targetScope, "alpha", "disabled", { actorId: "admin" });
        expect(preview.executable).toBe(true);
        if (!preview.executable) throw new Error("status preview unexpectedly blocked");
        await menuImpacts.setStatus(targetScope, "alpha", "disabled", {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: `status-${randomUUID()}`,
        });

        await expect(scoped.roles.menuPermissions.listDirect("cursor-role", {
            first: 1,
            after: directPage.pageInfo.endCursor!,
        })).rejects.toMatchObject({
            code: "CURSOR_STALE",
            details: expect.objectContaining({ owner: "scope.menu" }),
        });
        await expect(scoped.roles.listOwnRules("cursor-role", {
            first: 1,
            after: ownRulesPage.pageInfo.endCursor!,
        })).rejects.toMatchObject({
            code: "CURSOR_STALE",
            details: expect.objectContaining({ owner: "scope.menu" }),
        });
        const after = {
            direct: (await scoped.roles.menuPermissions.getDirect("cursor-role")).etag,
            effective: (await scoped.roles.menuPermissions.getEffective("cursor-role")).etag,
            tree: (await scoped.roles.menuPermissions.getAuthorizationTree("cursor-role")).etag,
            ownRules: (await scoped.roles.getOwnRules("cursor-role")).etag,
            effectiveRules: (await scoped.roles.getEffectiveRules("cursor-role")).etag,
        };
        expect(after).not.toEqual(before);
        for (const key of Object.keys(before) as (keyof typeof before)[]) {
            expect(after[key], `${key} ETag`).not.toBe(before[key]);
        }
    }, TEST_TIMEOUT);
});
