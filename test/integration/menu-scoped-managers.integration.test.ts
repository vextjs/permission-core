import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionCore } from "../../src";
import type { MenuPermissionSelection, PermissionScope } from "../../src/types";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const PREFIX = `pc_b44_scoped_${randomUUID().replaceAll("-", "")}`;

function scope(label: string): PermissionScope {
    return { tenantId: `tenant-${label}-${randomUUID()}` };
}

describe("public scoped menu managers on MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let core: PermissionCore;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 97 });
        core = new PermissionCore({
            monsqlize: context.monsqlize,
            collectionPrefix: PREFIX,
            tokenSecret: "permission-core-scoped-menu-manager-secret",
        });
        await core.init();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await core?.close();
        await context?.close();
    }, TEST_TIMEOUT);

    it("routes frozen menu and API managers through the public scope facade", async () => {
        const targetScope = scope("surface");
        const scoped = core.scope(targetScope);
        expect(Object.isFrozen(scoped)).toBe(true);
        expect(Object.isFrozen(scoped.menus)).toBe(true);
        expect(Object.isFrozen(scoped.menus.manifest)).toBe(true);
        expect(Object.isFrozen(scoped.apiBindings)).toBe(true);
        expect(Object.keys(scoped)).toEqual(["roles", "userRoles", "menus", "apiBindings"]);

        const manifest = {
            schemaVersion: 2 as const,
            mode: "replace" as const,
            nodes: [
                { id: "root", type: "directory" as const, title: "Root", order: 0 },
                {
                    id: "orders",
                    parentId: "root",
                    type: "page" as const,
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission: { action: "read" as const, resource: "ui:page:orders" },
                    order: 0,
                },
            ],
            apiBindings: [],
        };
        const manifestPreview = await scoped.menus.manifest.preview(manifest, { actorId: "admin" });
        if (!manifestPreview.executable) throw new Error("expected manifest preview to be executable");
        await expect(scoped.menus.manifest.import(manifest, {
            ...manifestPreview.expected,
            previewToken: manifestPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "public-manifest-import",
        })).resolves.toMatchObject({ changed: true });
        await expect(scoped.menus.manifest.export()).resolves.toMatchObject({
            data: { schemaVersion: 2, nodes: expect.arrayContaining([expect.objectContaining({ id: "orders" })]) },
        });
        await expect(scoped.menus.manifest.exportPage({ first: 10 })).resolves.toMatchObject({
            items: expect.arrayContaining([expect.objectContaining({ kind: "node" })]),
        });

        const orders = await scoped.menus.get("orders");
        expect(orders.data).toMatchObject({ id: "orders", revision: 1 });
        await expect(scoped.menus.list({ parentId: "root" })).resolves.toMatchObject({
            items: [expect.objectContaining({ id: "orders" })],
        });
        await expect(scoped.menus.getTree()).resolves.toMatchObject({
            data: [expect.objectContaining({ id: "root", children: [expect.objectContaining({ id: "orders" })] })],
        });
        await expect(scoped.menus.update("orders", { title: "Order management" }, {
            expectedRevision: orders.data.revision,
            actorId: "admin",
        })).resolves.toMatchObject({ changed: true, data: { title: "Order management", revision: 2 } });

        const pathRequest = { patch: { path: "/operations/orders" } };
        const pathPreview = await scoped.menus.previewUpdate("orders", pathRequest, { actorId: "admin" });
        if (!pathPreview.executable) throw new Error("expected path-only menu preview to be executable");
        expect(pathPreview).toMatchObject({
            capacity: null,
            plan: { sourceImpacts: { total: 0 }, after: { path: "/operations/orders" } },
        });
        await expect(scoped.menus.executeUpdate("orders", pathRequest, {
            ...pathPreview.expected,
            previewToken: pathPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "public-menu-path-update",
        })).resolves.toMatchObject({ changed: true, data: { path: "/operations/orders", revision: 3 } });

        const createdBinding = await scoped.apiBindings.create({
            id: "orders-read",
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: "api:GET:/api/orders" }],
            },
            owners: [{ type: "page", id: "orders", required: true }],
            canonicalOwner: { type: "page", id: "orders" },
        }, { actorId: "admin" });
        expect(createdBinding).toMatchObject({ changed: true, data: { id: "orders-read", revision: 1 } });
        await expect(scoped.apiBindings.get("orders-read")).resolves.toMatchObject({
            data: { method: "GET", path: "/api/orders" },
        });
        await expect(scoped.apiBindings.list({ ownerId: "orders" })).resolves.toMatchObject({
            items: [expect.objectContaining({ id: "orders-read" })],
        });
        await expect(scoped.apiBindings.update("orders-read", { description: "Reads orders" }, {
            expectedRevision: createdBinding.data.revision,
            actorId: "admin",
        })).resolves.toMatchObject({ changed: true, data: { description: "Reads orders", revision: 2 } });
        const apiRequest = { patch: { purpose: "lookup" as const } };
        const apiPreview = await scoped.apiBindings.previewUpdate("orders-read", apiRequest, { actorId: "admin" });
        if (!apiPreview.executable) throw new Error("expected API impact preview to be executable");
        await expect(scoped.apiBindings.executeUpdate("orders-read", apiRequest, {
            ...apiPreview.expected,
            previewToken: apiPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "public-api-impact-update",
        })).resolves.toMatchObject({ changed: true, data: { purpose: "lookup", revision: 3 } });
        await expect(scoped.apiBindings.getRemovalImpact("orders-read")).resolves.toMatchObject({
            data: { bindingId: "orders-read" },
        });
        await expect(scoped.menus.getRemovalImpact("orders")).resolves.toMatchObject({
            data: { nodeId: "orders", apiBindings: { total: 1 } },
        });
        await expect(scoped.menus.findStaleReferences({ first: 10 })).resolves.toMatchObject({ items: [] });
    }, TEST_TIMEOUT);

    it("requires and atomically applies role-source rewrites for permission changes", async () => {
        const targetScope = scope("rewrite");
        const scoped = core.scope(targetScope);
        const manifest = {
            schemaVersion: 2 as const,
            mode: "replace" as const,
            nodes: [
                { id: "root", type: "directory" as const, title: "Root", order: 0 },
                {
                    id: "reports",
                    parentId: "root",
                    type: "page" as const,
                    title: "Reports",
                    path: "/reports",
                    name: "reports",
                    component: "ReportsPage",
                    permission: { action: "read" as const, resource: "ui:page:reports" },
                    dataPermissions: [{ action: "read" as const, resource: "db:reports" as const, label: "Read reports" }],
                    order: 0,
                },
            ],
            apiBindings: [],
        };
        const manifestPreview = await scoped.menus.manifest.preview(manifest, { actorId: "admin" });
        if (!manifestPreview.executable) throw new Error("expected manifest preview to be executable");
        await scoped.menus.manifest.import(manifest, {
            ...manifestPreview.expected,
            previewToken: manifestPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "rewrite-manifest",
        });
        await scoped.roles.create({ id: "report-reader", label: "Report reader" });
        await scoped.userRoles.assign("u-rewrite", "report-reader");
        const selection: MenuPermissionSelection = {
            nodeIds: ["reports"],
            include: { descendants: false, buttons: false, apis: "none", dataPermissions: true },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        const grantPreview = await scoped.roles.menuPermissions.preview(
            "report-reader",
            { operation: "grant", selection },
            { actorId: "admin" },
        );
        if (!grantPreview.executable) throw new Error("expected role menu grant preview to be executable");
        await scoped.roles.menuPermissions.grant("report-reader", selection, {
            ...grantPreview.expected,
            previewToken: grantPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "rewrite-role-grant",
        });
        await expect(core.can({ userId: "u-rewrite", scope: targetScope }, "read", "ui:page:reports"))
            .resolves.toBe(true);

        const rejectedRequest = {
            patch: { permission: { action: "read" as const, resource: "ui:page:analytics" } },
        };
        const unresolved = await scoped.menus.previewUpdate("reports", rejectedRequest, { actorId: "admin" });
        expect(unresolved).toMatchObject({
            executable: false,
            previewToken: null,
            conflicts: { items: [expect.objectContaining({ code: "SOURCE_REWRITE_REQUIRED" })] },
            plan: { sourceImpacts: { total: 1 } },
        });
        const impact = unresolved.plan.sourceImpacts.items[0]!;
        const replacementSemanticKey = impact.replacementCandidates.items[0]!.semanticKey;
        const rewriteRequest = {
            ...rejectedRequest,
            sourceRewrite: {
                mode: "apply" as const,
                resolutions: {
                    [impact.sourceId]: { action: "replace" as const, replacementSemanticKey },
                },
            },
        };
        const rewritePreview = await scoped.menus.previewUpdate("reports", rewriteRequest, { actorId: "admin" });
        if (!rewritePreview.executable) {
            throw new Error(`expected source rewrite preview to be executable: ${rewritePreview.conflicts.items.map((item) => item.code).join(",")}`);
        }
        expect(rewritePreview.expected.expectedRevisions).toHaveProperty("rbac");
        expect(rewritePreview.capacity).toMatchObject({
            proof: "exact",
            disposition: "safe",
            accessDirection: "mixed",
            affectedUsers: { total: 1 },
        });
        const executeOptions = {
            ...rewritePreview.expected,
            previewToken: rewritePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "public-menu-source-rewrite",
        };
        await expect(scoped.menus.executeUpdate("reports", rewriteRequest, executeOptions))
            .resolves.toMatchObject({
                changed: true,
                replayed: false,
                data: { permission: { resource: "ui:page:analytics" }, revision: 2 },
            });
        await expect(scoped.menus.executeUpdate("reports", rewriteRequest, executeOptions))
            .resolves.toMatchObject({ changed: true, replayed: true });
        await expect(core.can({ userId: "u-rewrite", scope: targetScope }, "read", "ui:page:reports"))
            .resolves.toBe(false);
        await expect(core.can({ userId: "u-rewrite", scope: targetScope }, "read", "ui:page:analytics"))
            .resolves.toBe(true);
        await expect(core.forSubject({ userId: "u-rewrite", scope: targetScope }).menus.getRouteState("/reports"))
            .resolves.toMatchObject({ data: { allowed: true, resource: "ui:page:analytics" } });

        const dataRejected = await scoped.menus.previewUpdate("reports", {
            patch: {
                dataPermissions: [{ action: "read", resource: "db:analytics", label: "Read analytics" }],
            },
        }, { actorId: "admin" });
        expect(dataRejected).toMatchObject({
            executable: false,
            conflicts: { items: [expect.objectContaining({ code: "SOURCE_REWRITE_REQUIRED" })] },
            plan: { sourceImpacts: { total: 1 } },
        });
        const dataImpact = dataRejected.plan.sourceImpacts.items[0]!;
        const dataCandidate = dataImpact.replacementCandidates.items[0]!;
        expect(dataCandidate.rule).toMatchObject({ action: "read", resource: "db:analytics" });
        const dataRequest = {
            patch: {
                dataPermissions: [{ action: "read" as const, resource: "db:analytics" as const, label: "Read analytics" }],
            },
            sourceRewrite: {
                mode: "apply" as const,
                resolutions: {
                    [dataImpact.sourceId]: {
                        action: "replace" as const,
                        replacementSemanticKey: dataCandidate.semanticKey,
                    },
                },
            },
        };
        const dataPreview = await scoped.menus.previewUpdate("reports", dataRequest, { actorId: "admin" });
        if (!dataPreview.executable) throw new Error("expected data source rewrite preview to be executable");
        await expect(scoped.menus.executeUpdate("reports", dataRequest, {
            ...dataPreview.expected,
            previewToken: dataPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "public-menu-data-source-rewrite",
        })).resolves.toMatchObject({
            changed: true,
            data: { dataPermissions: [{ resource: "db:analytics" }], revision: 3 },
        });
        const ownRules = await scoped.roles.getOwnRules("report-reader");
        expect(ownRules.data.map((rule) => rule.resource).sort()).toEqual([
            "db:analytics",
            "ui:page:analytics",
        ]);
        expect(ownRules.data.every((rule) => rule.sources.items.every((source) => (
            source.kind !== "menu" || source.state.integrity === "valid"
        )))).toBe(true);
        await expect(scoped.roles.menuPermissions.getDirect("report-reader")).resolves.toMatchObject({
            data: {
                grants: [expect.objectContaining({
                    sourceStatus: expect.objectContaining({ integrity: "valid", drift: "current" }),
                })],
            },
        });

        const staleRequest = { patch: { path: "/analytics/reports" } };
        const stalePreview = await scoped.menus.previewUpdate("reports", staleRequest, { actorId: "admin" });
        if (!stalePreview.executable) throw new Error("expected stale-plan setup preview to be executable");
        await scoped.menus.update("reports", { title: "Analytics reports" }, {
            expectedRevision: 3,
            actorId: "admin",
        });
        await expect(scoped.menus.executeUpdate("reports", staleRequest, {
            ...stalePreview.expected,
            previewToken: stalePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "stale-menu-impact-update",
        })).rejects.toMatchObject({ code: expect.stringMatching(/PREVIEW_STALE|REVISION_CONFLICT/u) });
        await expect(scoped.menus.get("reports")).resolves.toMatchObject({
            data: {
                title: "Analytics reports",
                path: "/reports",
                permission: { resource: "ui:page:analytics" },
                dataPermissions: [{ resource: "db:analytics" }],
                revision: 4,
            },
        });
    }, TEST_TIMEOUT);
});
