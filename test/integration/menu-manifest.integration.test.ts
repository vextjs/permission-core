import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MenuManifestExportRecord, MenuManifestInput, PermissionScope } from "../../src/types";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import { MenuManifestService } from "../../src/menu";
import {
    createRoleMenuAggregateFields,
    createRoleMenuGrantSnapshot,
} from "../../src/menu/source-rewrite";
import { SIMPLE_COLLATION } from "../../src/persistence/indexes";
import { PermissionRepository } from "../../src/persistence/repository";
import {
    createMenuSourceId,
    createSemanticKey,
    materializeRoleRuleDocument,
    RoleMutationService,
    UserRoleMutationService,
} from "../../src/rbac";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;

function createRepository(context: RealMongoContext, prefix: string, schemes: ResourceSchemeRegistry) {
    const schemeContractDigest = schemes.schemeContractDigest;
    return new PermissionRepository(context.monsqlize, prefix, {
        schemeContractDigest,
        schemaContractKey: digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: 2,
            schemeContractDigest,
        }),
    });
}

async function executeManifest(
    service: MenuManifestService,
    scope: PermissionScope,
    input: MenuManifestInput,
    idempotencyKey: string,
) {
    const preview = await service.preview(scope, input, { actorId: "admin" });
    if (!preview.executable) throw new Error(`expected executable manifest: ${preview.conflicts.items.map((item) => item.code).join(",")}`);
    return service.import(scope, input, {
        ...preview.expected,
        previewToken: preview.previewToken,
        actorId: "admin",
        idempotencyKey,
    });
}

describe("v2 menu manifest lifecycle on MonSQLize 3.1", () => {
    let context: RealMongoContext;

    beforeAll(async () => {
        context = await startRealMongo();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    it("imports, exports, paginates, replays, and round-trips a canonical replace manifest", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_manifest_roundtrip_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-manifest-roundtrip" });
        const service = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 41), "menu-manifest-roundtrip"),
        );
        const input = {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 9 },
                {
                    id: "orders",
                    parentId: "root",
                    type: "page",
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission: { action: "read", resource: "ui:page:orders" },
                    order: 7,
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
        } satisfies MenuManifestInput;

        const preview = await service.preview(scope, input, { actorId: "admin" });
        expect(preview).toMatchObject({
            executable: true,
            summary: { inserted: 3, updated: 0, deleted: 0, unchanged: 0, conflicted: 0 },
            plan: {
                mode: "replace",
                nodeOperations: { total: 2 },
                bindingOperations: { total: 1 },
                sourceImpacts: { total: 0 },
            },
        });
        if (!preview.executable) throw new Error("expected initial manifest preview to be executable");
        const imported = await service.import(scope, input, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "manifest-initial-replace",
        });
        expect(imported).toMatchObject({ changed: true, replayed: false, revision: 1 });

        const exported = await service.export(scope);
        expect(exported.data).toMatchObject({ schemaVersion: 2 });
        expect(exported.data.nodes.map((node) => [node.id, node.order])).toEqual([
            ["orders", 0],
            ["root", 0],
        ]);
        expect(exported.data.apiBindings.map((binding) => binding.id)).toEqual(["orders-read"]);
        const roundTripInput = {
            schemaVersion: 2,
            mode: "replace",
            nodes: exported.data.nodes,
            apiBindings: exported.data.apiBindings,
        } satisfies MenuManifestInput;
        const noOpPreview = await service.preview(scope, roundTripInput, { actorId: "admin" });
        expect(noOpPreview).toMatchObject({
            executable: true,
            summary: { inserted: 0, updated: 0, deleted: 0, unchanged: 3, conflicted: 0 },
            plan: {
                nodeOperations: { total: 0 },
                unchangedNodes: { total: 2 },
                bindingOperations: { total: 0 },
                unchangedBindings: { total: 1 },
            },
        });
        if (!noOpPreview.executable) throw new Error("expected exported manifest to preview as a no-op");
        const noOp = await service.import(scope, roundTripInput, {
            ...noOpPreview.expected,
            previewToken: noOpPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "manifest-roundtrip-noop",
        });
        expect(noOp).toMatchObject({ changed: false, revision: 1 });

        const replay = await service.import(scope, input, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "manifest-initial-replace",
        });
        expect(replay).toMatchObject({ replayed: true, operationId: imported.operationId });

        const records: MenuManifestExportRecord[] = [];
        let after: string | undefined;
        do {
            const page = await service.exportPage(scope, { first: 1, ...(after === undefined ? {} : { after }) });
            records.push(...page.items);
            after = page.pageInfo.endCursor ?? undefined;
            if (!page.pageInfo.hasNext) break;
        } while (after !== undefined);
        expect(records.map((record) => ({ kind: record.kind, id: record.value.id }))).toEqual([
            { kind: "api-binding", id: "orders-read" },
            { kind: "node", id: "orders" },
            { kind: "node", id: "root" },
        ]);
        const pagedRoundTrip = {
            schemaVersion: 2,
            mode: "replace",
            nodes: records.flatMap((record) => record.kind === "node" ? [record.value] : []),
            apiBindings: records.flatMap((record) => record.kind === "api-binding" ? [record.value] : []),
        } satisfies MenuManifestInput;
        const pagedNoOp = await service.preview(scope, pagedRoundTrip, { actorId: "admin" });
        expect(pagedNoOp).toMatchObject({
            executable: true,
            summary: { inserted: 0, updated: 0, deleted: 0, unchanged: 3, conflicted: 0 },
        });
        expect((await service.exportPage(scope, { kind: "node" })).items.map((record) => record.kind))
            .toEqual(["node", "node"]);

        const stalePage = await service.exportPage(scope, { first: 1 });
        await executeManifest(service, scope, {
            schemaVersion: 2,
            mode: "merge",
            nodes: [{ id: "settings", type: "page", title: "Settings", path: "/settings", name: "settings", component: "SettingsPage", permission: { action: "read", resource: "ui:page:settings" }, order: 99 }],
            apiBindings: [],
        }, "manifest-add-settings");
        await expect(service.exportPage(scope, { first: 1, after: stalePage.pageInfo.endCursor! }))
            .rejects.toMatchObject({ code: "CURSOR_STALE" });
    }, TEST_TIMEOUT);

    it("applies merge full-state defaults and stable listed-retained sibling ordering", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_manifest_merge_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-manifest-merge" });
        const service = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 43), "menu-manifest-merge"),
        );
        await executeManifest(service, scope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                { id: "a", parentId: "root", type: "page", title: "A", path: "/a", name: "a", component: "APage", permission: { action: "read", resource: "ui:page:a" }, status: "disabled", hidden: true, order: 0 },
                { id: "c", parentId: "root", type: "page", title: "C old", path: "/c", name: "c", component: "CPage", permission: { action: "read", resource: "ui:page:c" }, icon: "old-icon", status: "disabled", hidden: true, order: 1 },
            ],
            apiBindings: [{
                id: "a-read",
                method: "GET",
                path: "/api/a",
                purpose: "entry",
                authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/a" }] },
                owners: [{ type: "page", id: "a", required: true }],
                description: "old description",
                status: "disabled",
            }],
        }, "manifest-merge-seed");

        const merge = {
            schemaVersion: 2,
            mode: "merge",
            nodes: [
                { id: "b", parentId: "root", type: "page", title: "B", path: "/b", name: "b", component: "BPage", permission: { action: "read", resource: "ui:page:b" }, order: 0 },
                { id: "c", parentId: "root", type: "page", title: "C new", path: "/c", name: "c", component: "CPage", permission: { action: "read", resource: "ui:page:c" }, order: 1 },
            ],
            apiBindings: [{
                id: "a-read",
                method: "GET",
                path: "/api/a",
                purpose: "entry",
                authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/a" }] },
            }],
        } satisfies MenuManifestInput;
        const preview = await service.preview(scope, merge, { actorId: "admin" });
        expect(preview).toMatchObject({
            executable: true,
            summary: { inserted: 1, updated: 2, deleted: 0, unchanged: 2, conflicted: 0 },
        });
        if (!preview.executable) throw new Error("expected merge preview to be executable");
        await service.import(scope, merge, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "manifest-merge-apply",
        });
        const exported = await service.export(scope);
        const children = exported.data.nodes
            .filter((node) => node.parentId === "root")
            .sort((left, right) => left.order - right.order);
        expect(children.map((node) => [node.id, node.order])).toEqual([["a", 0], ["b", 1], ["c", 2]]);
        expect(children.find((node) => node.id === "a")).toMatchObject({ status: "disabled", hidden: true });
        expect(children.find((node) => node.id === "c")).toMatchObject({ title: "C new", status: "enabled", hidden: false });
        expect(children.find((node) => node.id === "c")).not.toHaveProperty("icon");
        expect(exported.data.apiBindings[0]).toMatchObject({ id: "a-read", status: "enabled", owners: [] });
        expect(exported.data.apiBindings[0]).not.toHaveProperty("description");
    }, TEST_TIMEOUT);

    it("swaps unique node and endpoint identities before applying authoritative replace deletions", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_manifest_swap_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-manifest-swap" });
        const service = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 44), "menu-manifest-swap"),
        );
        await executeManifest(service, scope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                { id: "a", parentId: "root", type: "page", title: "A", path: "/a", name: "a", component: "APage", permission: { action: "read", resource: "ui:page:a" }, order: 0 },
                { id: "b", parentId: "root", type: "page", title: "B", path: "/b", name: "b", component: "BPage", permission: { action: "read", resource: "ui:page:b" }, order: 1 },
            ],
            apiBindings: [
                {
                    id: "a-read",
                    method: "GET",
                    path: "/api/a",
                    purpose: "entry",
                    authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/a" }] },
                    owners: [{ type: "page", id: "a", required: true }],
                },
                {
                    id: "b-read",
                    method: "GET",
                    path: "/api/b",
                    purpose: "entry",
                    authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/b" }] },
                    owners: [{ type: "page", id: "b", required: true }],
                },
            ],
        }, "manifest-swap-seed");

        const swap = {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                { id: "a", parentId: "root", type: "page", title: "A", path: "/b", name: "b", component: "APage", permission: { action: "read", resource: "ui:page:a" }, order: 0 },
                { id: "b", parentId: "root", type: "page", title: "B", path: "/a", name: "a", component: "BPage", permission: { action: "read", resource: "ui:page:b" }, order: 1 },
            ],
            apiBindings: [
                {
                    id: "a-read",
                    method: "GET",
                    path: "/api/b",
                    purpose: "entry",
                    authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/b" }] },
                    owners: [{ type: "page", id: "a", required: true }],
                },
                {
                    id: "b-read",
                    method: "GET",
                    path: "/api/a",
                    purpose: "entry",
                    authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/a" }] },
                    owners: [{ type: "page", id: "b", required: true }],
                },
            ],
        } satisfies MenuManifestInput;
        const swapPreview = await service.preview(scope, swap, { actorId: "admin" });
        if (!swapPreview.executable) throw new Error("expected unique identity swaps to be executable");
        expect(swapPreview).toMatchObject({
            summary: { inserted: 0, updated: 4, deleted: 0, unchanged: 1, conflicted: 0 },
            plan: { nodeOperations: { total: 2 }, bindingOperations: { total: 2 } },
        });
        await service.import(scope, swap, {
            ...swapPreview.expected,
            previewToken: swapPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "manifest-swap-apply",
        });
        const swapped = await service.export(scope);
        expect(swapped.data.nodes.find((node) => node.id === "a")).toMatchObject({ path: "/b", name: "b" });
        expect(swapped.data.nodes.find((node) => node.id === "b")).toMatchObject({ path: "/a", name: "a" });
        expect(swapped.data.apiBindings.find((binding) => binding.id === "a-read")).toMatchObject({ path: "/api/b" });
        expect(swapped.data.apiBindings.find((binding) => binding.id === "b-read")).toMatchObject({ path: "/api/a" });

        const prune = {
            schemaVersion: 2,
            mode: "replace",
            nodes: swapped.data.nodes.filter((node) => node.id !== "b"),
            apiBindings: swapped.data.apiBindings.filter((binding) => binding.id !== "b-read"),
        } satisfies MenuManifestInput;
        const prunePreview = await service.preview(scope, prune, { actorId: "admin" });
        if (!prunePreview.executable) throw new Error("expected authoritative replace deletion to be executable");
        expect(prunePreview).toMatchObject({
            summary: { inserted: 0, updated: 0, deleted: 2, unchanged: 3, conflicted: 0 },
            plan: { nodeOperations: { total: 1 }, bindingOperations: { total: 1 } },
        });
        await service.import(scope, prune, {
            ...prunePreview.expected,
            previewToken: prunePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "manifest-prune-apply",
        });
        const pruned = await service.export(scope);
        expect(pruned.data.nodes.map((node) => node.id)).toEqual(["a", "root"]);
        expect(pruned.data.apiBindings.map((binding) => binding.id)).toEqual(["a-read"]);
    }, TEST_TIMEOUT);

    it("rewrites node and API grant sources together and rolls every layer back on a late failure", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_manifest_sources_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-manifest-sources" });
        const scopeKey = createScopeKey(scope);
        const service = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 45), "menu-manifest-sources"),
        );
        const roles = new RoleMutationService(repository, schemes);
        const userRoles = new UserRoleMutationService(repository, schemes);
        await executeManifest(service, scope, {
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
                    permissions: [{ action: "invoke", resource: "api:GET:/api/orders" }],
                },
                owners: [{ type: "page", id: "orders", required: true }],
                canonicalOwner: { type: "page", id: "orders" },
            }],
        }, "manifest-sources-seed");
        await roles.create(scope, { id: "manifest-role", label: "Manifest role" }, {
            actorId: "admin",
            idempotencyKey: "manifest-sources-role",
        });
        await userRoles.assign(scope, "manifest-user", "manifest-role", {
            actorId: "admin",
            idempotencyKey: "manifest-sources-user",
        });

        const now = Date.now();
        const grantId = "grant-manifest-sources";
        const nodeSemanticKey = createSemanticKey("allow", "read", "ui:page:orders");
        const apiSemanticKey = createSemanticKey("allow", "invoke", "api:GET:/api/orders");
        const nodeSource = {
            sourceId: createMenuSourceId({
                grantId,
                semanticKey: nodeSemanticKey,
                contribution: "node",
                assetId: "orders",
            }),
            kind: "menu" as const,
            grantId,
            grantRevision: 1,
            effect: "allow" as const,
            contribution: "node" as const,
            assetId: "orders",
        };
        const apiSource = {
            sourceId: createMenuSourceId({
                grantId,
                semanticKey: apiSemanticKey,
                contribution: "api",
                assetId: "orders",
                apiBindingId: "orders-read",
            }),
            kind: "menu" as const,
            grantId,
            grantRevision: 1,
            effect: "allow" as const,
            contribution: "api" as const,
            assetId: "orders",
            apiBindingId: "orders-read",
        };
        const nodeRule = materializeRoleRuleDocument({
            scopeKey,
            scope,
            roleId: "manifest-role",
            effect: "allow",
            action: "read",
            resource: "ui:page:orders",
            semanticKey: nodeSemanticKey,
            sources: [nodeSource],
            revision: 1,
            createdAt: now,
            updatedAt: now,
        }, scope, scopeKey, schemes);
        const apiRule = materializeRoleRuleDocument({
            scopeKey,
            scope,
            roleId: "manifest-role",
            effect: "allow",
            action: "invoke",
            resource: "api:GET:/api/orders",
            semanticKey: apiSemanticKey,
            sources: [apiSource],
            revision: 1,
            createdAt: now,
            updatedAt: now,
        }, scope, scopeKey, schemes);
        const intent = {
            anchorId: "orders",
            include: { descendants: false, buttons: false, apis: "all" as const, dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        const grant = {
            scopeKey,
            scope,
            roleId: "manifest-role",
            grantId,
            effect: "allow" as const,
            intent,
            snapshot: createRoleMenuGrantSnapshot(intent, [
                { rule: nodeRule, source: nodeSource },
                { rule: apiRule, source: apiSource },
            ]),
            grantRevision: 1,
            createdAt: now,
            updatedAt: now,
        };
        const aggregate = createRoleMenuAggregateFields([grant], [nodeRule, apiRule]);
        await repository.collections.roleRules.insertMany([nodeRule, apiRule].map((rule) => ({
            ...rule,
            sources: rule.sources.map((source) => ({ ...source })),
        })));
        await repository.collections.roleMenuGrants.insertOne({
            ...grant,
            intent: { ...grant.intent },
            snapshot: { ...grant.snapshot },
        });
        expect(await repository.collections.roles.updateOne(
            { scopeKey, roleId: "manifest-role", revision: 1 },
            { $set: aggregate },
            { cache: { invalidate: false }, collation: SIMPLE_COLLATION },
        )).toMatchObject({ matchedCount: 1, modifiedCount: 1 });

        const changedBase = {
            schemaVersion: 2,
            mode: "merge",
            nodes: [{
                id: "orders",
                type: "page",
                title: "Orders v2",
                path: "/orders",
                name: "orders",
                component: "OrdersPage",
                permission: { action: "read", resource: "ui:page:orders-v2" },
                order: 0,
            }],
            apiBindings: [{
                id: "orders-read",
                method: "GET",
                path: "/api/orders-v2",
                purpose: "entry",
                authorization: {
                    mode: "all",
                    permissions: [{ action: "invoke", resource: "api:GET:/api/orders-v2" }],
                },
                owners: [{ type: "page", id: "orders", required: true }],
                canonicalOwner: { type: "page", id: "orders" },
            }],
        } satisfies MenuManifestInput;
        const unresolved = await service.preview(scope, changedBase, { actorId: "admin" });
        expect(unresolved).toMatchObject({
            executable: false,
            previewToken: null,
            expected: null,
            plan: { sourceImpacts: { total: 2, truncated: false } },
        });
        expect(unresolved.plan.sourceImpacts.items.map((impact) => impact.reason).sort())
            .toEqual(["binding-change", "permission-change"]);
        expect(unresolved.conflicts.items.filter((conflict) => conflict.code === "SOURCE_REWRITE_REQUIRED"))
            .toHaveLength(2);
        const resolutions = Object.fromEntries(unresolved.plan.sourceImpacts.items.map((impact) => {
            expect(impact.replacementCandidates).toMatchObject({ total: 1, truncated: false });
            return [impact.sourceId, {
                action: "replace" as const,
                replacementSemanticKey: impact.replacementCandidates.items[0]!.semanticKey,
            }];
        }));
        const changed = {
            ...changedBase,
            sourceRewrite: { mode: "apply" as const, resolutions },
        } satisfies MenuManifestInput;
        const rewritePreview = await service.preview(scope, changed, { actorId: "admin" });
        if (!rewritePreview.executable) {
            throw new Error(`expected combined source rewrite to be executable: ${rewritePreview.conflicts.items.map((item) => item.code).join(",")}`);
        }
        expect(rewritePreview).toMatchObject({
            summary: { inserted: 0, updated: 4, deleted: 0, unchanged: 0, conflicted: 0 },
            capacity: { proof: "exact", disposition: "safe", affectedUsers: { total: 1 } },
        });
        expect(rewritePreview.expected.expectedRevisions).toHaveProperty("rbac");
        const stateBeforeRewrite = await repository.scopeStates.read(scope);
        await service.import(scope, changed, {
            ...rewritePreview.expected,
            previewToken: rewritePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "manifest-sources-rewrite",
        });
        const stateAfterRewrite = await repository.scopeStates.read(scope);
        expect(stateAfterRewrite).toMatchObject({
            revision: stateBeforeRewrite.revision + 1,
            rbacRevision: stateBeforeRewrite.rbacRevision + 1,
            menuRevision: stateBeforeRewrite.menuRevision + 1,
        });
        const exported = await service.export(scope);
        expect(exported.data.nodes[0]).toMatchObject({
            id: "orders",
            permission: { action: "read", resource: "ui:page:orders-v2" },
        });
        expect(exported.data.apiBindings[0]).toMatchObject({
            id: "orders-read",
            path: "/api/orders-v2",
            authorization: { permissions: [{ action: "invoke", resource: "api:GET:/api/orders-v2" }] },
        });
        const nodeSemanticKeyV2 = createSemanticKey("allow", "read", "ui:page:orders-v2");
        const apiSemanticKeyV2 = createSemanticKey("allow", "invoke", "api:GET:/api/orders-v2");
        expect(await repository.collections.roleRules.count(
            { scopeKey, semanticKey: { $in: [nodeSemanticKey, apiSemanticKey] } },
            { cache: 0 },
        )).toBe(0);
        const rewrittenRuleRows = await repository.collections.roleRules.find(
            { scopeKey, semanticKey: { $in: [nodeSemanticKeyV2, apiSemanticKeyV2] } },
            { cache: 0, collation: SIMPLE_COLLATION },
        ).sort({ semanticKey: 1 }).toArray();
        const rewrittenRules = rewrittenRuleRows.map((rule) =>
            materializeRoleRuleDocument(rule, scope, scopeKey, schemes));
        expect(rewrittenRules).toHaveLength(2);
        expect(rewrittenRules.every((rule) => rule.sources.every((source) => source.kind !== "menu" || source.grantRevision === 2)))
            .toBe(true);
        expect(await repository.collections.roleMenuGrants.findOne(
            { scopeKey, roleId: "manifest-role", grantId },
            { cache: 0 },
        )).toMatchObject({ grantRevision: 2 });

        const nextBase = {
            schemaVersion: 2,
            mode: "merge",
            nodes: [{
                id: "orders",
                type: "page",
                title: "Orders v3",
                path: "/orders",
                name: "orders",
                component: "OrdersPage",
                permission: { action: "read", resource: "ui:page:orders-v3" },
                order: 0,
            }],
            apiBindings: [{
                id: "orders-read",
                method: "POST",
                path: "/api/orders-v3",
                purpose: "entry",
                authorization: {
                    mode: "all",
                    permissions: [{ action: "invoke", resource: "api:POST:/api/orders-v3" }],
                },
                owners: [{ type: "page", id: "orders", required: true }],
                canonicalOwner: { type: "page", id: "orders" },
            }],
        } satisfies MenuManifestInput;
        const nextUnresolved = await service.preview(scope, nextBase, { actorId: "admin" });
        const nextResolutions = Object.fromEntries(nextUnresolved.plan.sourceImpacts.items.map((impact) => [
            impact.sourceId,
            {
                action: "replace" as const,
                replacementSemanticKey: impact.replacementCandidates.items[0]!.semanticKey,
            },
        ]));
        const next = {
            ...nextBase,
            sourceRewrite: { mode: "apply" as const, resolutions: nextResolutions },
        } satisfies MenuManifestInput;
        const nextPreview = await service.preview(scope, next, { actorId: "admin" });
        if (!nextPreview.executable) throw new Error("expected late-failure fixture to be executable");
        const stateBeforeFailure = await repository.scopeStates.read(scope);
        const exportBeforeFailure = await service.export(scope);
        const originalCollections = repository.collections;
        const failingRoleMenuGrants = Object.freeze({
            ...originalCollections.roleMenuGrants,
            async updateOne(..._args: Parameters<typeof originalCollections.roleMenuGrants.updateOne>) {
                throw Object.assign(new Error("E11000 injected manifest grant update failure"), { code: 11000 });
            },
        });
        Object.defineProperty(repository, "collections", {
            value: Object.freeze({ ...originalCollections, roleMenuGrants: failingRoleMenuGrants }),
            writable: true,
            configurable: true,
        });
        try {
            await expect(service.import(scope, next, {
                ...nextPreview.expected,
                previewToken: nextPreview.previewToken,
                actorId: "admin",
                idempotencyKey: "manifest-sources-late-failure",
            })).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
        } finally {
            Object.defineProperty(repository, "collections", {
                value: originalCollections,
                writable: true,
                configurable: true,
            });
        }
        const stateAfterFailure = await repository.scopeStates.read(scope);
        expect(stateAfterFailure).toMatchObject({
            revision: stateBeforeFailure.revision,
            rbacRevision: stateBeforeFailure.rbacRevision,
            menuRevision: stateBeforeFailure.menuRevision,
        });
        expect(await service.export(scope)).toMatchObject({
            revision: exportBeforeFailure.revision,
            data: exportBeforeFailure.data,
        });
        expect(await repository.collections.roleRules.count(
            { scopeKey, semanticKey: { $in: [nodeSemanticKeyV2, apiSemanticKeyV2] } },
            { cache: 0 },
        )).toBe(2);
        expect(await repository.collections.roleRules.count(
            {
                scopeKey,
                semanticKey: {
                    $in: [
                        createSemanticKey("allow", "read", "ui:page:orders-v3"),
                        createSemanticKey("allow", "invoke", "api:POST:/api/orders-v3"),
                    ],
                },
            },
            { cache: 0 },
        )).toBe(0);
        expect(await repository.collections.roleMenuGrants.findOne(
            { scopeKey, roleId: "manifest-role", grantId },
            { cache: 0 },
        )).toMatchObject({ grantRevision: 2 });
    }, TEST_TIMEOUT);

    it("returns typed inventory conflicts and rolls node/API writes back as one transaction", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_manifest_conflicts_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-manifest-conflicts" });
        const service = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 47), "menu-manifest-conflicts"),
        );
        await executeManifest(service, scope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                { id: "page", parentId: "root", type: "page", title: "Page", path: "/page", name: "page", component: "PageView", permission: { action: "read", resource: "ui:page:page" }, order: 0 },
            ],
            apiBindings: [{
                id: "page-read",
                method: "GET",
                path: "/api/page",
                purpose: "entry",
                authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/page" }] },
            }],
        }, "manifest-conflict-seed");

        const cases: Array<{ input: MenuManifestInput; codes: string[] }> = [
            {
                input: {
                    schemaVersion: 2,
                    mode: "merge",
                    nodes: [
                        { id: "duplicate", type: "page", title: "Duplicate", path: "/duplicate", name: "duplicate", component: "DuplicatePage", permission: { action: "read", resource: "ui:page:duplicate" }, order: 0 },
                        { id: "duplicate", type: "page", title: "Duplicate", path: "/duplicate", name: "duplicate", component: "DuplicatePage", permission: { action: "read", resource: "ui:page:duplicate" }, order: 0 },
                    ],
                    apiBindings: [],
                },
                codes: ["MENU_ALREADY_EXISTS"],
            },
            {
                input: {
                    schemaVersion: 2,
                    mode: "merge",
                    nodes: [
                        { id: "d", parentId: "root", type: "page", title: "D", path: "/d", name: "d", component: "DPage", permission: { action: "read", resource: "ui:page:d" }, order: 0 },
                        { id: "e", parentId: "root", type: "page", title: "E", path: "/e", name: "e", component: "EPage", permission: { action: "read", resource: "ui:page:e" }, order: 0 },
                    ],
                    apiBindings: [],
                },
                codes: ["MENU_HIERARCHY_INVALID"],
            },
            {
                input: {
                    schemaVersion: 2,
                    mode: "merge",
                    nodes: [{ id: "orphan", parentId: "missing", type: "page", title: "Orphan", path: "/orphan", name: "orphan", component: "OrphanPage", permission: { action: "read", resource: "ui:page:orphan" }, order: 0 }],
                    apiBindings: [],
                },
                codes: ["MENU_NOT_FOUND"],
            },
            {
                input: {
                    schemaVersion: 2,
                    mode: "merge",
                    nodes: [
                        { id: "cycle-a", parentId: "cycle-b", type: "menu", title: "Cycle A", path: "/cycle-a", name: "cycle-a", permission: { action: "read", resource: "ui:menu:cycle-a" }, order: 0 },
                        { id: "cycle-b", parentId: "cycle-a", type: "menu", title: "Cycle B", path: "/cycle-b", name: "cycle-b", permission: { action: "read", resource: "ui:menu:cycle-b" }, order: 0 },
                    ],
                    apiBindings: [],
                },
                codes: ["MENU_HIERARCHY_INVALID"],
            },
            {
                input: {
                    schemaVersion: 2,
                    mode: "merge",
                    nodes: [{ id: "page", parentId: "root", type: "menu", title: "Changed type", path: "/page", name: "page", component: "PageView", permission: { action: "read", resource: "ui:menu:page" }, order: 0 }],
                    apiBindings: [],
                },
                codes: ["INVALID_ARGUMENT"],
            },
            {
                input: {
                    schemaVersion: 2,
                    mode: "merge",
                    nodes: [],
                    apiBindings: [{
                        id: "endpoint-conflict",
                        method: "GET",
                        path: "/api/page",
                        purpose: "entry",
                        authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/page" }] },
                    }],
                },
                codes: ["API_BINDING_ALREADY_EXISTS"],
            },
            {
                input: {
                    schemaVersion: 2,
                    mode: "merge",
                    nodes: [],
                    apiBindings: [
                        {
                            id: "duplicate-binding",
                            method: "POST",
                            path: "/api/duplicate",
                            purpose: "operation",
                            authorization: { mode: "all", permissions: [{ action: "create", resource: "api:POST:/api/duplicate" }] },
                        },
                        {
                            id: "duplicate-binding",
                            method: "POST",
                            path: "/api/duplicate",
                            purpose: "operation",
                            authorization: { mode: "all", permissions: [{ action: "create", resource: "api:POST:/api/duplicate" }] },
                        },
                    ],
                },
                codes: ["API_BINDING_ALREADY_EXISTS"],
            },
        ];
        for (const entry of cases) {
            const preview = await service.preview(scope, entry.input, { actorId: "admin" });
            expect(preview.executable).toBe(false);
            expect(preview.previewToken).toBeNull();
            expect(preview.expected).toBeNull();
            expect(preview.conflicts.items.map((conflict) => conflict.code))
                .toEqual(expect.arrayContaining(entry.codes));
        }

        const rollbackInput = {
            schemaVersion: 2,
            mode: "merge",
            nodes: [{ id: "rollback-node", type: "page", title: "Rollback", path: "/rollback", name: "rollback", component: "RollbackPage", permission: { action: "read", resource: "ui:page:rollback" }, order: 9 }],
            apiBindings: [{
                id: "rollback-binding",
                method: "POST",
                path: "/api/rollback",
                purpose: "operation",
                authorization: { mode: "all", permissions: [{ action: "create", resource: "api:POST:/api/rollback" }] },
            }],
        } satisfies MenuManifestInput;
        const rollbackPreview = await service.preview(scope, rollbackInput, { actorId: "admin" });
        if (!rollbackPreview.executable) throw new Error("expected rollback fixture preview to be executable");
        const originalCollections = repository.collections;
        const failingApiBindings = Object.freeze({
            ...originalCollections.apiBindings,
            async insertOne(..._args: Parameters<typeof originalCollections.apiBindings.insertOne>) {
                throw new Error("injected manifest API insert failure");
            },
        });
        Object.defineProperty(repository, "collections", {
            value: Object.freeze({ ...originalCollections, apiBindings: failingApiBindings }),
            writable: true,
            configurable: true,
        });
        try {
            await expect(service.import(scope, rollbackInput, {
                ...rollbackPreview.expected,
                previewToken: rollbackPreview.previewToken,
                actorId: "admin",
                idempotencyKey: "manifest-rollback",
            })).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
        } finally {
            Object.defineProperty(repository, "collections", {
                value: originalCollections,
                writable: true,
                configurable: true,
            });
        }
        const afterRollback = await service.export(scope);
        expect(afterRollback.data.nodes.some((node) => node.id === "rollback-node")).toBe(false);
        expect(afterRollback.data.apiBindings.some((binding) => binding.id === "rollback-binding")).toBe(false);
        expect(afterRollback.revision).toBe(1);
    }, TEST_TIMEOUT);

    it("rejects more than 1000 atomic entity mutations without writing a partial inventory", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_manifest_limit_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-manifest-limit" });
        const service = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 53), "menu-manifest-limit"),
        );
        const input = {
            schemaVersion: 2,
            mode: "replace",
            nodes: Array.from({ length: 1_001 }, (_, index) => ({
                id: `root-${String(index).padStart(4, "0")}`,
                type: "directory" as const,
                title: `Root ${index}`,
                order: index,
            })),
            apiBindings: [],
        } satisfies MenuManifestInput;
        const preview = await service.preview(scope, input, { actorId: "admin" });
        expect(preview).toMatchObject({
            executable: false,
            previewToken: null,
            expected: null,
            summary: { inserted: 1_001 },
            plan: { nodeOperations: { total: 1_001 } },
        });
        expect(preview.conflicts.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "LIMIT_EXCEEDED", id: "manifest-entity-capacity" }),
        ]));
        const exported = await service.export(scope);
        expect(exported).toMatchObject({ revision: 0, data: { nodes: [], apiBindings: [] } });
    }, TEST_TIMEOUT);
});
