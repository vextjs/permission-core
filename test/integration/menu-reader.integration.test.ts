import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, canonicalByteLength, compareUtf8, digestCanonical } from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import {
    apiBindingDocumentFromInput,
    apiBindingManifestItem,
    ApiBindingImpactMutationService,
    ApiBindingMutationService,
    evaluateApiBindingAvailability,
    evaluateOwnerApiAvailability,
    MenuNodeImpactMutationService,
    MenuNodeMutationService,
    MenuQueryService,
    MenuReadStore,
    MenuScopeReader,
    menuManifestNode,
    menuNodeDocumentFromInput,
    menuNodeManifestItemFromDocument,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
} from "../../src/menu";
import {
    createRoleMenuAggregateFields,
    createRoleMenuGrantSnapshot,
} from "../../src/menu/source-rewrite";
import { PermissionRepository } from "../../src/persistence/repository";
import { PERSISTED_SCHEMA_VERSION } from "../../src/persistence/documents";
import { SIMPLE_COLLATION } from "../../src/persistence/indexes";
import {
    createMenuSourceId,
    createSemanticKey,
    materializeRoleRuleDocument,
    RbacScopeReader,
    RoleMutationService,
    UserRoleMutationService,
} from "../../src/rbac";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;

describe("v2 menu read model on MonSQLize 3.1", () => {
    let context: RealMongoContext;

    beforeAll(async () => {
        context = await startRealMongo();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    it("uses real Mongo ordering, ObjectId cursor anchors, scope isolation, and aggregate verification", async () => {
        const prefix = `pc_b4_reader_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const contract = {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        };
        const repository = new PermissionRepository(context.monsqlize, prefix, contract, 1);
        await repository.ensureIndexes();

        const scope = normalizeScope({ tenantId: "tenant-menu-real" });
        const scopeKey = createScopeKey(scope);
        const now = Date.now();
        const permission = { action: "read" as const, resource: "ui:page:orders" };
        const normalizedNodes = [
            { input: normalizeMenuNodeCreateInput({ id: "root-a", type: "directory", title: "Root A" }, schemes), order: 0 },
            { input: normalizeMenuNodeCreateInput({ id: "root-b", type: "directory", title: "Root B" }, schemes), order: 1 },
            {
                input: normalizeMenuNodeCreateInput({
                    id: "orders-page",
                    parentId: "root-a",
                    type: "page",
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission,
                }, schemes),
                order: 0,
            },
        ];
        const normalizedBindings = [normalizeApiBindingCreateInput({
            id: "orders-read",
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/orders" }] },
            owners: [{ type: "page", id: "orders-page", required: true }],
            canonicalOwner: { type: "page", id: "orders-page" },
        }, schemes)];
        const nodeDocuments = normalizedNodes.map(({ input, order }) => menuNodeDocumentFromInput(
            scopeKey,
            scope,
            input,
            order,
            1,
            now,
        ));
        const bindingDocuments = normalizedBindings.map((input) => apiBindingDocumentFromInput(
            scopeKey,
            scope,
            input,
            1,
            now,
        ));
        const replaceManifestBytes = canonicalByteLength({
            schemaVersion: 2,
            mode: "replace",
            nodes: normalizedNodes
                .map(({ input, order }) => menuManifestNode(input, order))
                .sort((left, right) => compareUtf8(left.id, right.id)),
            apiBindings: normalizedBindings
                .map(apiBindingManifestItem)
                .sort((left, right) => compareUtf8(left.id, right.id)),
        });

        await repository.collections.scopeState.insertOne({
            scopeKey,
            scope,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest: contract.schemeContractDigest,
            schemaContractKey: contract.schemaContractKey,
            revision: 1,
            rbacRevision: 0,
            menuRevision: 1,
            auditRevision: 1,
            menuConfigCount: 0,
            menuConfigBytes: 0,
            responseFieldCount: 0,
            responseFieldOwnerCount: 0,
            menuNodeCount: nodeDocuments.length,
            apiBindingCount: bindingDocuments.length,
            replaceManifestBytes,
            createdAt: now,
            updatedAt: now,
        });
        await repository.collections.menuNodes.insertMany(nodeDocuments.map((document) => ({ ...document })));
        await repository.collections.apiBindings.insertMany(bindingDocuments.map((document) => ({ ...document })));

        const service = new MenuQueryService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 11), "real-menu-reader"),
        );
        const first = await service.listMenus(scope, { first: 2 });
        expect(first.items.map((item) => item.id)).toEqual(["root-a", "root-b"]);
        expect(first.pageInfo.endCursor).toEqual(expect.any(String));
        const second = await service.listMenus(scope, { first: 1, after: first.pageInfo.endCursor! });
        expect(second.items.map((item) => item.id)).toEqual(["orders-page"]);
        expect((await service.getTree(scope)).data).toHaveLength(2);
        expect((await service.listApiBindings(scope)).items.map((item) => item.id)).toEqual(["orders-read"]);
        expect((await service.listMenus({ tenantId: "tenant-menu-other" })).items).toEqual([]);

        const inventory = await (await new MenuReadStore(repository, schemes).open(scope)).readCompleteInventory();
        expect(inventory).toMatchObject({ manifestBytes: replaceManifestBytes });
        expect(inventory.nodes).toHaveLength(3);

        await repository.collections.scopeState.updateOne(
            { scopeKey },
            { $inc: { revision: 1, menuRevision: 1, auditRevision: 1 }, $set: { updatedAt: now + 1 } },
            { cache: 0, collation: SIMPLE_COLLATION },
        );
        await expect(service.listMenus(scope, { after: first.pageInfo.endCursor! })).rejects.toMatchObject({ code: "CURSOR_STALE" });
    }, TEST_TIMEOUT);

    it("commits menu create/update, aggregate deltas, audit, idempotent replay, and rollback atomically", async () => {
        const prefix = `pc_b4_menu_mutation_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-mutation" });
        const service = new MenuNodeMutationService(repository, schemes);

        const rootInput = { id: "root", type: "directory" as const, title: "Root" };
        const created = await service.create(scope, rootInput, {
            actorId: "admin",
            idempotencyKey: "create-root",
        });
        expect(created).toMatchObject({ changed: true, replayed: false, revision: 1, data: { id: "root", order: 0 } });
        expect(created.revisions).toMatchObject({ global: 1, rbac: 0, menu: 1 });
        const replay = await service.create(scope, rootInput, {
            actorId: "admin",
            idempotencyKey: "create-root",
        });
        expect(replay).toMatchObject({ changed: true, replayed: true, operationId: created.operationId });

        const page = await service.create(scope, {
            id: "orders",
            parentId: "root",
            type: "page",
            title: "Orders",
            path: "/orders",
            name: "orders",
            component: "OrdersPage",
            permission: { action: "read", resource: "ui:page:orders" },
        }, { actorId: "admin", idempotencyKey: "create-orders" });
        expect(page.data).toMatchObject({ parentId: "root", order: 0, revision: 1 });

        const updated = await service.update(scope, "orders", {
            title: "Order management",
            icon: "shopping-cart",
            hidden: true,
        }, {
            actorId: "admin",
            idempotencyKey: "update-orders",
            expectedRevision: 1,
        });
        expect(updated).toMatchObject({ changed: true, revision: 2, data: { title: "Order management", hidden: true } });
        const noChange = await service.update(scope, "orders", { title: "Order management" }, {
            actorId: "admin",
            idempotencyKey: "noop-orders",
            expectedRevision: 2,
        });
        expect(noChange).toMatchObject({ changed: false, revision: 2 });
        expect(noChange.revisions.menu).toBe(updated.revisions.menu);
        expect(noChange.revisions.audit).toBeGreaterThan(updated.revisions.audit);

        const apiService = new ApiBindingMutationService(repository, schemes);
        const api = await apiService.create(scope, {
            id: "orders-read",
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/orders" }] },
            owners: [{ type: "page", id: "orders", required: true, availabilityGroup: "orders-api", availabilityMode: "any" }],
            canonicalOwner: { type: "page", id: "orders" },
        }, { actorId: "admin", idempotencyKey: "create-orders-api" });
        expect(api).toMatchObject({ changed: true, revision: 1, data: { id: "orders-read", method: "GET" } });
        const apiUpdated = await apiService.update(scope, "orders-read", {
            purpose: "lookup",
            description: "Lists orders",
        }, { actorId: "admin", idempotencyKey: "update-orders-api", expectedRevision: 1 });
        expect(apiUpdated).toMatchObject({ changed: true, revision: 2, data: { purpose: "lookup", description: "Lists orders" } });

        await expect(apiService.create(scope, {
            id: "orders-read-copy",
            method: "GET",
            path: "/api/orders",
            purpose: "lookup",
            authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/orders" }] },
        }, { actorId: "admin", idempotencyKey: "duplicate-endpoint" })).rejects.toMatchObject({ code: "API_BINDING_ALREADY_EXISTS" });
        await expect(apiService.create(scope, {
            id: "orders-write",
            method: "POST",
            path: "/api/orders",
            purpose: "operation",
            authorization: { mode: "all", permissions: [{ action: "create", resource: "api:POST:/api/orders" }] },
            owners: [{ type: "page", id: "orders", required: true, availabilityGroup: "orders-api", availabilityMode: "all" }],
        }, { actorId: "admin", idempotencyKey: "conflicting-owner-group" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(apiService.create(scope, {
            id: "wrong-owner-type",
            method: "DELETE",
            path: "/api/orders/:id",
            purpose: "operation",
            authorization: { mode: "all", permissions: [{ action: "delete", resource: "api:DELETE:/api/orders/:id" }] },
            owners: [{ type: "button", id: "orders", required: true }],
        }, { actorId: "admin", idempotencyKey: "wrong-owner-type" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        const beforeFailure = await repository.scopeStates.read(scope);
        await expect(service.create(scope, {
            id: "bad-button",
            type: "button",
            title: "Bad",
            code: "bad",
            permission: { action: "read", resource: "ui:button:bad" },
        }, { actorId: "admin", idempotencyKey: "bad-button" })).rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        await expect(service.create(scope, {
            id: "orders-copy",
            parentId: "root",
            type: "page",
            title: "Orders copy",
            path: "/orders",
            name: "orders-copy",
            component: "OrdersCopyPage",
            permission: { action: "read", resource: "ui:page:orders-copy" },
        }, { actorId: "admin", idempotencyKey: "duplicate-path" })).rejects.toMatchObject({ code: "MENU_ALREADY_EXISTS" });
        const afterFailure = await repository.scopeStates.read(scope);
        expect(afterFailure).toMatchObject({
            revision: beforeFailure.revision,
            menuRevision: beforeFailure.menuRevision,
            auditRevision: beforeFailure.auditRevision,
            menuNodeCount: 2,
        });

        const inventory = await (await new MenuReadStore(repository, schemes).open(scope)).readCompleteInventory();
        expect(inventory.nodes.map((node) => node.nodeId)).toEqual(["orders", "root"]);
        expect(inventory.bindings.map((binding) => binding.bindingId)).toEqual(["orders-read"]);
        expect(inventory.manifestBytes).toBe(afterFailure.replaceManifestBytes);
    }, TEST_TIMEOUT);

    it("manages API binding identity, owners, defaults, metadata, tenant scope, and error classification", async () => {
        const prefix = `pc_b4_api_crud_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-api-crud" });
        const otherScope = normalizeScope({ tenantId: "tenant-api-crud-other" });
        const menus = new MenuNodeMutationService(repository, schemes);
        const api = new ApiBindingMutationService(repository, schemes);
        const queries = new MenuQueryService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 41), "api-crud-cursor"),
        );

        await menus.create(scope, {
            id: "owner-a",
            type: "page",
            title: "Owner A",
            path: "/owner-a",
            name: "owner-a",
            component: "OwnerA",
            permission: { action: "read", resource: "ui:page:owner-a" },
        }, { actorId: "admin", idempotencyKey: "api-owner-a" });
        await menus.create(scope, {
            id: "owner-b",
            type: "page",
            title: "Owner B",
            path: "/owner-b",
            name: "owner-b",
            component: "OwnerB",
            permission: { action: "read", resource: "ui:page:owner-b" },
        }, { actorId: "admin", idempotencyKey: "api-owner-b" });

        const backgroundInput = {
            id: "jobs-run",
            method: " post ",
            path: "//jobs//run/?trace=1#result",
            purpose: "background" as const,
            authorization: {
                mode: "all" as const,
                permissions: [{ action: "invoke", resource: "api:POST:/jobs/run" }],
            },
        };
        const background = await api.create(scope, backgroundInput, {
            actorId: "admin",
            idempotencyKey: "api-jobs-run",
        });
        expect(background).toMatchObject({
            changed: true,
            replayed: false,
            data: { id: "jobs-run", method: "POST", path: "/jobs/run", status: "enabled", owners: [] },
        });
        expect(background.data).not.toHaveProperty("canonicalOwner");
        expect((await api.create(scope, backgroundInput, {
            actorId: "admin",
            idempotencyKey: "api-jobs-run",
        })).replayed).toBe(true);
        expect((await queries.getApiBinding(scope, "jobs-run")).data).toEqual(background.data);

        const ordersRead = await api.create(scope, {
            id: "orders-read",
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: "api:GET:/api/orders" }],
            },
            owners: [
                { type: "page", id: "owner-a", required: true, availabilityGroup: "orders-api", availabilityMode: "any" },
                { type: "page", id: "owner-b", required: false },
            ],
            canonicalOwner: { type: "page", id: "owner-a" },
        }, { actorId: "admin", idempotencyKey: "api-orders-read" });
        await api.create(scope, {
            id: "orders-write",
            method: "POST",
            path: "/api/orders",
            purpose: "operation",
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: "api:POST:/api/orders" }],
            },
            owners: [
                { type: "page", id: "owner-a", required: true, availabilityGroup: "orders-api", availabilityMode: "any" },
            ],
            canonicalOwner: { type: "page", id: "owner-a" },
        }, { actorId: "admin", idempotencyKey: "api-orders-write" });
        expect(ordersRead.data).toMatchObject({
            owners: [
                { type: "page", id: "owner-a", required: true },
                { type: "page", id: "owner-b", required: false },
            ],
            canonicalOwner: { type: "page", id: "owner-a" },
        });
        expect((await queries.listApiBindings(scope, { ownerId: "owner-a" })).items.map((binding) => binding.id))
            .toEqual(["orders-read", "orders-write"]);

        await expect(api.create(scope, {
            ...backgroundInput,
            id: "jobs-run-copy",
            method: "POST",
            path: "/jobs/run/#duplicate",
        }, { actorId: "admin", idempotencyKey: "api-duplicate-endpoint" }))
            .rejects.toMatchObject({ code: "API_BINDING_ALREADY_EXISTS" });
        await expect(api.create(scope, {
            ...backgroundInput,
            method: "DELETE",
            path: "/jobs/run/delete",
        }, { actorId: "admin", idempotencyKey: "api-duplicate-id" }))
            .rejects.toMatchObject({ code: "API_BINDING_ALREADY_EXISTS" });
        await expect(api.create(scope, {
            id: "missing-owner",
            method: "GET",
            path: "/api/missing-owner",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/missing-owner" }] },
            owners: [{ type: "page", id: "missing", required: true }],
        }, { actorId: "admin", idempotencyKey: "api-missing-owner" }))
            .rejects.toMatchObject({ code: "MENU_NOT_FOUND" });
        await expect(api.create(scope, {
            id: "wrong-owner-type",
            method: "GET",
            path: "/api/wrong-owner-type",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/wrong-owner-type" }] },
            owners: [{ type: "button", id: "owner-a", required: true }],
        }, { actorId: "admin", idempotencyKey: "api-wrong-owner-type" }))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(api.create(scope, {
            id: "owner-group-conflict",
            method: "GET",
            path: "/api/owner-group-conflict",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/owner-group-conflict" }] },
            owners: [{ type: "page", id: "owner-a", required: true, availabilityGroup: "orders-api", availabilityMode: "all" }],
        }, { actorId: "admin", idempotencyKey: "api-owner-group-conflict" }))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        const otherBackground = await api.create(otherScope, backgroundInput, {
            actorId: "admin",
            idempotencyKey: "api-jobs-run-other-tenant",
        });
        expect(otherBackground.data).toMatchObject({ id: "jobs-run", method: "POST", path: "/jobs/run" });

        const updated = await api.update(scope, "orders-read", {
            purpose: "lookup",
            description: "Lists orders",
        }, { actorId: "admin", idempotencyKey: "api-orders-read-update", expectedRevision: 1 });
        expect(updated).toMatchObject({ changed: true, replayed: false, revision: 2, data: { purpose: "lookup", description: "Lists orders" } });
        expect((await api.update(scope, "orders-read", {
            purpose: "lookup",
            description: "Lists orders",
        }, { actorId: "admin", idempotencyKey: "api-orders-read-update", expectedRevision: 1 })).replayed).toBe(true);
        const noChange = await api.update(scope, "orders-read", { purpose: "lookup" }, {
            actorId: "admin",
            idempotencyKey: "api-orders-read-noop",
            expectedRevision: 2,
        });
        expect(noChange).toMatchObject({ changed: false, revision: 2 });
        const cleared = await api.update(scope, "orders-read", { description: null }, {
            actorId: "admin",
            idempotencyKey: "api-orders-read-clear",
            expectedRevision: 2,
        });
        expect(cleared).toMatchObject({ changed: true, revision: 3 });
        expect(cleared.data).not.toHaveProperty("description");
        await expect(api.update(scope, "orders-read", { purpose: "entry" }, {
            actorId: "admin",
            idempotencyKey: "api-orders-read-stale",
            expectedRevision: 2,
        })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
        await expect(api.update(scope, "orders-read", { path: "/forbidden" } as never, {
            actorId: "admin",
            idempotencyKey: "api-orders-read-impact-bypass",
            expectedRevision: 3,
        })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        const createAudit = await repository.audits.getByOperationId(scope, ordersRead.operationId);
        expect(createAudit.change).toMatchObject({ kind: "api-binding", before: null, after: { id: "orders-read" } });
        const updateAudit = await repository.audits.getByOperationId(scope, updated.operationId);
        expect(updateAudit.change).toMatchObject({
            kind: "api-binding-metadata",
            before: { id: "orders-read", revision: 1 },
            after: { id: "orders-read", revision: 2, purpose: "lookup" },
        });

        const stateBeforeInjectedFailures = await repository.scopeStates.read(scope);
        const originalCollections = repository.collections;
        let injectedError: Error & { code?: number } = Object.assign(new Error("duplicate key"), { code: 11000 });
        const failingApiBindings = Object.freeze({
            ...originalCollections.apiBindings,
            async insertOne(..._args: Parameters<typeof originalCollections.apiBindings.insertOne>) {
                throw injectedError;
            },
        });
        Object.defineProperty(repository, "collections", {
            value: Object.freeze({ ...originalCollections, apiBindings: failingApiBindings }),
            writable: true,
            configurable: true,
        });
        try {
            await expect(api.create(scope, {
                ...backgroundInput,
                id: "injected-duplicate",
                path: "/jobs/injected-duplicate",
            }, { actorId: "admin", idempotencyKey: "api-injected-duplicate" }))
                .rejects.toMatchObject({ code: "API_BINDING_ALREADY_EXISTS" });
            injectedError = new Error(`write failed for ${prefix}_api_bindings without a duplicate key`);
            await expect(api.create(scope, {
                ...backgroundInput,
                id: "injected-write-failure",
                path: "/jobs/injected-write-failure",
            }, { actorId: "admin", idempotencyKey: "api-injected-write-failure" }))
                .rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
        } finally {
            Object.defineProperty(repository, "collections", {
                value: originalCollections,
                writable: true,
                configurable: true,
            });
        }
        expect(await repository.scopeStates.read(scope)).toMatchObject({
            revision: stateBeforeInjectedFailures.revision,
            rbacRevision: stateBeforeInjectedFailures.rbacRevision,
            menuRevision: stateBeforeInjectedFailures.menuRevision,
            auditRevision: stateBeforeInjectedFailures.auditRevision,
            menuNodeCount: stateBeforeInjectedFailures.menuNodeCount,
            apiBindingCount: stateBeforeInjectedFailures.apiBindingCount,
            replaceManifestBytes: stateBeforeInjectedFailures.replaceManifestBytes,
        });
        await expect(queries.getApiBinding(scope, "injected-write-failure"))
            .rejects.toMatchObject({ code: "API_BINDING_NOT_FOUND" });
        expect((await repository.scopeStates.read(scope)).apiBindingCount).toBe(3);
        expect((await repository.scopeStates.read(otherScope)).apiBindingCount).toBe(1);
    }, TEST_TIMEOUT);

    it("round-trips orthogonal route authorization and owner availability modes", async () => {
        const prefix = `pc_b4_api_modes_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-api-modes" });
        const menus = new MenuNodeMutationService(repository, schemes);
        const api = new ApiBindingMutationService(repository, schemes);
        const queries = new MenuQueryService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 43), "api-modes-cursor"),
        );
        for (const id of ["owner-any", "owner-all"] as const) {
            await menus.create(scope, {
                id,
                type: "page",
                title: id,
                path: `/${id}`,
                name: id,
                component: id,
                permission: { action: "read", resource: `ui:page:${id}` },
            }, { actorId: "admin", idempotencyKey: `create-${id}` });
        }

        const permissions = [
            { action: "invoke" as const, resource: "api:GET:/capability/first" },
            { action: "invoke" as const, resource: "api:GET:/capability/second" },
        ];
        for (const [id, mode] of [["loose", "any"], ["strict", "all"]] as const) {
            await api.create(scope, {
                id,
                method: "GET",
                path: `/api/${id}`,
                purpose: "entry",
                authorization: { mode, permissions },
                owners: [
                    { type: "page", id: "owner-any", required: true, availabilityGroup: "routes", availabilityMode: "any" },
                    { type: "page", id: "owner-all", required: true, availabilityGroup: "routes", availabilityMode: "all" },
                ],
            }, { actorId: "admin", idempotencyKey: `create-${id}` });
        }

        const bindings = (await queries.listApiBindings(scope)).items;
        expect(bindings.map((binding) => ({ id: binding.id, mode: binding.authorization.mode }))).toEqual([
            { id: "loose", mode: "any" },
            { id: "strict", mode: "all" },
        ]);
        const permissionResults = new Map([
            ["api:GET:/capability/first", true],
            ["api:GET:/capability/second", false],
        ]);
        const decisions = await Promise.all(bindings.map(async (binding) => ({
            binding,
            allowed: await evaluateApiBindingAvailability(
                binding,
                async (permission) => permissionResults.get(permission.resource)!,
            ),
        })));
        expect(decisions.map((decision) => ({ id: decision.binding.id, allowed: decision.allowed }))).toEqual([
            { id: "loose", allowed: true },
            { id: "strict", allowed: false },
        ]);
        expect(evaluateOwnerApiAvailability({ type: "page", id: "owner-any" }, decisions)).toMatchObject({
            enabled: true,
            risks: [{ bindingId: "loose", allowed: true }, { bindingId: "strict", allowed: false }],
        });
        expect(evaluateOwnerApiAvailability({ type: "page", id: "owner-all" }, decisions)).toMatchObject({
            enabled: false,
            risks: [{ bindingId: "loose", allowed: true }, { bindingId: "strict", allowed: false }],
        });
    }, TEST_TIMEOUT);

    it("previews and commits API binding availability against owner nodes and role sources", async () => {
        const prefix = `pc_b4_api_status_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-api-status" });
        const scopeKey = createScopeKey(scope);
        const menus = new MenuNodeMutationService(repository, schemes);
        const api = new ApiBindingMutationService(repository, schemes);
        const impact = new ApiBindingImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 47), "api-status-preview"),
        );
        const roles = new RoleMutationService(repository, schemes);
        const userRoles = new UserRoleMutationService(repository, schemes);

        await menus.create(scope, {
            id: "api-status-page",
            type: "page",
            title: "API status page",
            path: "/api-status",
            name: "api-status-page",
            component: "ApiStatusPage",
            permission: { action: "read", resource: "ui:page:api-status" },
        }, { actorId: "admin", idempotencyKey: "api-status-create-page" });
        await api.create(scope, {
            id: "api-status-binding",
            method: "GET",
            path: "/api/status",
            purpose: "entry",
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: "api:GET:/api/status" }],
            },
            owners: [{ type: "page", id: "api-status-page", required: true }],
            canonicalOwner: { type: "page", id: "api-status-page" },
        }, { actorId: "admin", idempotencyKey: "api-status-create-binding" });
        for (const roleId of ["api-status-allow", "api-status-deny"]) {
            await roles.create(scope, { id: roleId, label: roleId }, {
                actorId: "admin",
                idempotencyKey: `api-status-create-${roleId}`,
            });
            await userRoles.assign(scope, `user-${roleId}`, roleId, {
                actorId: "admin",
                idempotencyKey: `api-status-assign-${roleId}`,
            });
        }
        const now = Date.now();
        const seededRules = (["allow", "deny"] as const).map((effect) => {
            const roleId = `api-status-${effect}`;
            const semanticKey = createSemanticKey(effect, "invoke", "api:GET:/api/status");
            const grantId = `grant-api-status-${effect}`;
            const source = {
                sourceId: createMenuSourceId({
                    grantId,
                    semanticKey,
                    contribution: "api",
                    assetId: "api-status-page",
                    apiBindingId: "api-status-binding",
                }),
                kind: "menu" as const,
                grantId,
                grantRevision: 1,
                effect,
                contribution: "api" as const,
                assetId: "api-status-page",
                apiBindingId: "api-status-binding",
            };
            return {
                scopeKey,
                scope,
                roleId,
                effect,
                action: "invoke",
                resource: "api:GET:/api/status",
                semanticKey,
                sources: [source],
                revision: 1,
                createdAt: now,
                updatedAt: now,
            };
        });
        await repository.collections.roleRules.insertMany(seededRules.map((rule) => ({ ...rule })));

        const removalImpact = await impact.getRemovalImpact(scope, "api-status-binding");
        expect(removalImpact.data).toMatchObject({
            bindingId: "api-status-binding",
            ownerRelations: { total: 1 },
            roleSources: { total: 2 },
            removableWithoutRewrite: false,
        });
        expect(removalImpact.detailBudget.returned).toBe(3);

        const disabledPreview = await impact.previewSetStatus(scope, "api-status-binding", "disabled", { actorId: "admin" });
        if (!disabledPreview.executable) throw new Error("expected API disable preview to be executable");
        expect(disabledPreview.plan).toMatchObject({
            bindingId: "api-status-binding",
            before: "enabled",
            after: "disabled",
            affectedSources: { total: 2 },
            affectedRoles: { total: 2 },
            affectedUsers: { total: 2 },
        });
        expect(disabledPreview.capacity).toMatchObject({
            proof: "exact",
            disposition: "safe",
            accessDirection: "mixed",
            affectedUsers: { total: 2 },
        });
        expect(disabledPreview.expected.expectedRevisions).toHaveProperty("rbac");
        await expect(impact.setStatus(scope, "api-status-binding", "deprecated", {
            ...disabledPreview.expected,
            previewToken: disabledPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-status-wrong-status",
        })).rejects.toMatchObject({ code: "PREVIEW_STALE" });

        const disabled = await impact.setStatus(scope, "api-status-binding", "disabled", {
            ...disabledPreview.expected,
            previewToken: disabledPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-status-disable",
        });
        expect(disabled).toMatchObject({ changed: true, replayed: false, data: { status: "disabled", revision: 2 } });
        expect(disabled.revisions.rbac).toBe(disabledPreview.revisions.rbac);
        expect((await impact.setStatus(scope, "api-status-binding", "disabled", {
            ...disabledPreview.expected,
            previewToken: disabledPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-status-disable",
        })).replayed).toBe(true);

        const noOpPreview = await impact.previewSetStatus(scope, "api-status-binding", "disabled", { actorId: "admin" });
        if (!noOpPreview.executable) throw new Error("expected API status no-op preview to be executable");
        expect(noOpPreview).toMatchObject({
            summary: { unchanged: 1 },
            capacity: { accessDirection: "none", disposition: "safe" },
        });
        const noOp = await impact.setStatus(scope, "api-status-binding", "disabled", {
            ...noOpPreview.expected,
            previewToken: noOpPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-status-noop",
        });
        expect(noOp).toMatchObject({ changed: false, data: { status: "disabled", revision: 2 } });
        expect(await repository.collections.roleRules.count(
            { scopeKey, "sources.apiBindingId": "api-status-binding" },
            { cache: 0 },
        )).toBe(2);
        const audit = await repository.audits.getByOperationId(scope, disabled.operationId);
        expect(audit).toMatchObject({ operation: "apiBindings.setStatus", action: "update", changed: true });
    }, TEST_TIMEOUT);

    it("rewrites and removes API-owned role sources through explicit exact previews", async () => {
        const prefix = `pc_b4_api_impact_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-api-impact" });
        const scopeKey = createScopeKey(scope);
        const menus = new MenuNodeMutationService(repository, schemes);
        const api = new ApiBindingMutationService(repository, schemes);
        const tokens = new SignedTokenCodec(Buffer.alloc(32, 49), "api-impact-preview");
        const impact = new ApiBindingImpactMutationService(repository, schemes, tokens);
        const roles = new RoleMutationService(repository, schemes);
        const userRoles = new UserRoleMutationService(repository, schemes);

        for (const [id, path] of [["api-impact-page-a", "/impact-a"], ["api-impact-page-b", "/impact-b"]] as const) {
            await menus.create(scope, {
                id,
                type: "page",
                title: id,
                path,
                name: id,
                component: "ApiImpactPage",
                permission: { action: "read", resource: `ui:page:${id}` },
            }, { actorId: "admin", idempotencyKey: `api-impact-create-${id}` });
        }
        await api.create(scope, {
            id: "api-impact-binding",
            method: "GET",
            path: "/api/impact/old",
            purpose: "entry",
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: "api:GET:/api/impact/old" }],
            },
            owners: [
                { type: "page", id: "api-impact-page-a", required: true },
                { type: "page", id: "api-impact-page-b", required: true },
            ],
            canonicalOwner: { type: "page", id: "api-impact-page-a" },
        }, { actorId: "admin", idempotencyKey: "api-impact-create-binding" });
        await api.create(scope, {
            id: "api-impact-occupied",
            method: "GET",
            path: "/api/impact/occupied",
            purpose: "lookup",
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: "api:GET:/api/impact/occupied" }],
            },
            owners: [{ type: "page", id: "api-impact-page-b", required: true }],
        }, { actorId: "admin", idempotencyKey: "api-impact-create-occupied" });
        await roles.create(scope, { id: "api-impact-role", label: "API impact role" }, {
            actorId: "admin",
            idempotencyKey: "api-impact-create-role",
        });
        await userRoles.assign(scope, "api-impact-user", "api-impact-role", {
            actorId: "admin",
            idempotencyKey: "api-impact-assign-user",
        });

        const now = Date.now();
        const grantId = "grant-api-impact";
        const oldSemanticKey = createSemanticKey("allow", "invoke", "api:GET:/api/impact/old");
        const oldSource = {
            sourceId: createMenuSourceId({
                grantId,
                semanticKey: oldSemanticKey,
                contribution: "api",
                assetId: "api-impact-page-a",
                apiBindingId: "api-impact-binding",
            }),
            kind: "menu" as const,
            grantId,
            grantRevision: 1,
            effect: "allow" as const,
            contribution: "api" as const,
            assetId: "api-impact-page-a",
            apiBindingId: "api-impact-binding",
        };
        const rule = materializeRoleRuleDocument({
            scopeKey,
            scope,
            roleId: "api-impact-role",
            effect: "allow",
            action: "invoke",
            resource: "api:GET:/api/impact/old",
            semanticKey: oldSemanticKey,
            sources: [oldSource],
            revision: 1,
            createdAt: now,
            updatedAt: now,
        }, scope, scopeKey, schemes);
        const intent = {
            anchorId: "api-impact-page-a",
            include: { descendants: false, buttons: false, apis: "all" as const, dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        const grant = {
            scopeKey,
            scope,
            roleId: "api-impact-role",
            grantId,
            effect: "allow" as const,
            intent,
            snapshot: createRoleMenuGrantSnapshot(intent, [{ rule, source: oldSource }]),
            grantRevision: 1,
            createdAt: now,
            updatedAt: now,
        };
        const aggregate = createRoleMenuAggregateFields([grant], [rule]);
        await repository.collections.roleRules.insertOne({ ...rule, sources: rule.sources.map((source) => ({ ...source })) });
        await repository.collections.roleMenuGrants.insertOne({ ...grant, intent: { ...intent }, snapshot: { ...grant.snapshot } });
        expect(await repository.collections.roles.updateOne(
            { scopeKey, roleId: "api-impact-role", revision: 1 },
            { $set: aggregate },
            { cache: { invalidate: false }, collation: SIMPLE_COLLATION },
        )).toMatchObject({ matchedCount: 1, modifiedCount: 1 });

        const metadataRequest = { patch: { purpose: "detail" as const } };
        const metadataPreview = await impact.previewUpdate(scope, "api-impact-binding", metadataRequest, { actorId: "admin" });
        if (!metadataPreview.executable) throw new Error("expected metadata-only API preview to be executable");
        expect(metadataPreview).toMatchObject({
            capacity: null,
            plan: { sourceImpacts: { total: 0 }, after: { purpose: "detail" } },
        });
        expect(metadataPreview.expected.expectedRevisions).not.toHaveProperty("rbac");
        const metadata = await impact.executeUpdate(scope, "api-impact-binding", metadataRequest, {
            ...metadataPreview.expected,
            previewToken: metadataPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-impact-metadata",
        });
        expect(metadata).toMatchObject({ changed: true, data: { purpose: "detail", revision: 2 } });
        expect(await repository.collections.roleRules.count({ scopeKey, semanticKey: oldSemanticKey }, { cache: 0 })).toBe(1);

        const occupiedPreview = await impact.previewUpdate(scope, "api-impact-binding", {
            patch: { path: "/api/impact/occupied" },
        }, { actorId: "admin" });
        expect(occupiedPreview).toMatchObject({
            executable: false,
            previewToken: null,
        });
        expect(occupiedPreview.conflicts.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "API_BINDING_ALREADY_EXISTS" }),
            expect.objectContaining({ code: "SOURCE_REWRITE_REQUIRED" }),
        ]));

        const rejectRequest = {
            patch: {
                method: "POST",
                path: "/api/impact/new",
                authorization: {
                    mode: "all" as const,
                    permissions: [{ action: "invoke" as const, resource: "api:POST:/api/impact/new" }],
                },
            },
        };
        const unresolved = await impact.previewUpdate(scope, "api-impact-binding", rejectRequest, { actorId: "admin" });
        expect(unresolved).toMatchObject({
            executable: false,
            previewToken: null,
            conflicts: { items: [{ code: "SOURCE_REWRITE_REQUIRED" }] },
            plan: { sourceImpacts: { total: 1 } },
        });
        const impactItem = unresolved.plan.sourceImpacts.items[0]!;
        expect(impactItem.replacementCandidates).toMatchObject({ total: 1, truncated: false });
        const replacementSemanticKey = impactItem.replacementCandidates.items[0]!.semanticKey;
        const rewriteRequest = {
            ...rejectRequest,
            sourceRewrite: {
                mode: "apply" as const,
                resolutions: {
                    [impactItem.sourceId]: { action: "replace" as const, replacementSemanticKey },
                },
            },
        };
        const rewritePreview = await impact.previewUpdate(scope, "api-impact-binding", rewriteRequest, { actorId: "admin" });
        if (!rewritePreview.executable) throw new Error("expected API source rewrite preview to be executable");
        expect(rewritePreview.capacity).toMatchObject({
            proof: "exact",
            disposition: "safe",
            accessDirection: "mixed",
            affectedUsers: { total: 1 },
        });
        expect(rewritePreview.expected.expectedRevisions).toHaveProperty("rbac");
        const rewritten = await impact.executeUpdate(scope, "api-impact-binding", rewriteRequest, {
            ...rewritePreview.expected,
            previewToken: rewritePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-impact-rewrite",
        });
        expect(rewritten).toMatchObject({
            changed: true,
            data: { method: "POST", path: "/api/impact/new", revision: 3 },
        });
        const rewrittenRule = await repository.collections.roleRules.findOne(
            { scopeKey, roleId: "api-impact-role", semanticKey: replacementSemanticKey },
            { cache: 0 },
        );
        expect(rewrittenRule).toMatchObject({
            action: "invoke",
            resource: "api:POST:/api/impact/new",
            sources: [{ apiBindingId: "api-impact-binding", assetId: "api-impact-page-a", grantRevision: 2 }],
        });
        expect(await repository.collections.roleRules.count({ scopeKey, semanticKey: oldSemanticKey }, { cache: 0 })).toBe(0);

        const metadataOnlyReplacePreview = await impact.previewReplace(scope, {
            bindings: [
                {
                    id: "api-impact-binding",
                    method: "POST",
                    path: "/api/impact/new",
                    purpose: "detail",
                    description: "metadata-only replacement",
                    authorization: {
                        mode: "all",
                        permissions: [{ action: "invoke", resource: "api:POST:/api/impact/new" }],
                    },
                    owners: [
                        { type: "page", id: "api-impact-page-a", required: true },
                        { type: "page", id: "api-impact-page-b", required: true },
                    ],
                    canonicalOwner: { type: "page", id: "api-impact-page-a" },
                },
                {
                    id: "api-impact-occupied",
                    method: "GET",
                    path: "/api/impact/occupied",
                    purpose: "lookup",
                    authorization: {
                        mode: "all",
                        permissions: [{ action: "invoke", resource: "api:GET:/api/impact/occupied" }],
                    },
                    owners: [{ type: "page", id: "api-impact-page-b", required: true }],
                },
            ],
        }, { actorId: "admin" });
        if (!metadataOnlyReplacePreview.executable) throw new Error("expected metadata-only full replacement to be executable");
        expect(metadataOnlyReplacePreview).toMatchObject({
            capacity: null,
            plan: { operations: { total: 1 }, sourceImpacts: { total: 0 } },
        });
        expect(metadataOnlyReplacePreview.expected.expectedRevisions).not.toHaveProperty("rbac");

        const replacementBoundaryBinding = {
            id: "api-impact-binding",
            method: "PUT" as const,
            path: "/api/impact/boundary",
            purpose: "detail" as const,
            authorization: {
                mode: "all" as const,
                permissions: [{ action: "invoke" as const, resource: "api:PUT:/api/impact/boundary" }],
            },
            owners: [
                { type: "page" as const, id: "api-impact-page-a", required: true },
                { type: "page" as const, id: "api-impact-page-b", required: true },
            ],
            canonicalOwner: { type: "page" as const, id: "api-impact-page-a" },
        };
        const unchangedOccupiedBinding = {
            id: "api-impact-occupied",
            method: "GET" as const,
            path: "/api/impact/occupied",
            purpose: "lookup" as const,
            authorization: {
                mode: "all" as const,
                permissions: [{ action: "invoke" as const, resource: "api:GET:/api/impact/occupied" }],
            },
            owners: [{ type: "page" as const, id: "api-impact-page-b", required: true }],
        };
        const boundaryInsertBindings = Array.from({ length: 999 }, (_, index) => {
            const suffix = String(index).padStart(3, "0");
            return {
                id: `api-impact-boundary-${suffix}`,
                method: "GET" as const,
                path: `/api/impact/boundary/${suffix}`,
                purpose: "entry" as const,
                authorization: {
                    mode: "all" as const,
                    permissions: [{ action: "invoke" as const, resource: `api:GET:/api/impact/boundary/${suffix}` }],
                },
                owners: [],
            };
        });
        const boundaryReject = await impact.previewReplace(scope, {
            bindings: [replacementBoundaryBinding, unchangedOccupiedBinding, ...boundaryInsertBindings.slice(0, 998)],
        }, { actorId: "admin" });
        expect(boundaryReject).toMatchObject({
            executable: false,
            plan: { operations: { total: 999 }, sourceImpacts: { total: 1 } },
        });
        expect(boundaryReject.conflicts.items).toEqual([
            expect.objectContaining({ code: "SOURCE_REWRITE_REQUIRED" }),
        ]);
        const boundaryImpact = boundaryReject.plan.sourceImpacts.items[0]!;
        const boundaryInput = {
            bindings: [replacementBoundaryBinding, unchangedOccupiedBinding, ...boundaryInsertBindings.slice(0, 998)],
            sourceRewrite: {
                mode: "apply" as const,
                resolutions: {
                    [boundaryImpact.sourceId]: {
                        action: "replace" as const,
                        replacementSemanticKey: boundaryImpact.replacementCandidates.items[0]!.semanticKey,
                    },
                },
            },
        };
        const exactCombinedBoundary = await impact.previewReplace(scope, boundaryInput, { actorId: "admin" });
        if (!exactCombinedBoundary.executable) throw new Error("expected 999 binding mutations plus one source mutation to be executable");
        expect(exactCombinedBoundary.summary).toMatchObject({ inserted: 998, updated: 2, conflicted: 0 });

        const oneOverCombinedBoundary = await impact.previewReplace(scope, {
            ...boundaryInput,
            bindings: [replacementBoundaryBinding, unchangedOccupiedBinding, ...boundaryInsertBindings],
        }, { actorId: "admin" });
        expect(oneOverCombinedBoundary).toMatchObject({ executable: false, previewToken: null, expected: null });
        expect(oneOverCombinedBoundary.conflicts.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "LIMIT_EXCEEDED", id: "api-binding-replace-total-capacity" }),
        ]));
        expect(await repository.collections.apiBindings.count({ scopeKey }, { cache: 0 })).toBe(2);

        const replaceTarget = {
            bindings: [
                {
                    id: "api-impact-binding",
                    method: "GET",
                    path: "/api/impact/occupied",
                    purpose: "detail" as const,
                    authorization: {
                        mode: "all" as const,
                        permissions: [{ action: "invoke" as const, resource: "api:GET:/api/impact/occupied" }],
                    },
                    owners: [
                        { type: "page" as const, id: "api-impact-page-a", required: true },
                        { type: "page" as const, id: "api-impact-page-b", required: true },
                    ],
                    canonicalOwner: { type: "page" as const, id: "api-impact-page-a" },
                    status: "disabled" as const,
                },
                {
                    id: "api-impact-occupied",
                    method: "POST",
                    path: "/api/impact/new",
                    purpose: "lookup" as const,
                    authorization: {
                        mode: "all" as const,
                        permissions: [{ action: "invoke" as const, resource: "api:POST:/api/impact/new" }],
                    },
                    owners: [{ type: "page" as const, id: "api-impact-page-b", required: true }],
                    status: "enabled" as const,
                },
            ],
        };
        const replaceReject = await impact.previewReplace(scope, replaceTarget, { actorId: "admin" });
        expect(replaceReject).toMatchObject({
            executable: false,
            previewToken: null,
            plan: { operations: { total: 2 }, sourceImpacts: { total: 1 } },
            conflicts: { items: [{ code: "SOURCE_REWRITE_REQUIRED" }] },
        });
        const replaceImpact = replaceReject.plan.sourceImpacts.items[0]!;
        const replaceSemanticKey = replaceImpact.replacementCandidates.items[0]!.semanticKey;
        const replaceInput = {
            ...replaceTarget,
            sourceRewrite: {
                mode: "apply" as const,
                resolutions: {
                    [replaceImpact.sourceId]: { action: "replace" as const, replacementSemanticKey: replaceSemanticKey },
                },
            },
        };
        const replacePreview = await impact.previewReplace(scope, replaceInput, { actorId: "admin" });
        if (!replacePreview.executable) throw new Error("expected API full replacement preview to be executable");
        expect(replacePreview.capacity).toMatchObject({
            proof: "exact",
            disposition: "safe",
            accessDirection: "restrict",
            affectedUsers: { total: 1 },
        });
        expect(replacePreview.expected.expectedRevisions).toHaveProperty("rbac");
        const replaceStateBeforeFailure = await repository.scopeStates.read(scope);
        const replaceOriginalCollections = repository.collections;
        let failReplaceSourceUpdate = true;
        const failingReplaceRoleMenuGrants = Object.freeze({
            ...replaceOriginalCollections.roleMenuGrants,
            async updateOne(...args: Parameters<typeof replaceOriginalCollections.roleMenuGrants.updateOne>) {
                if (failReplaceSourceUpdate) {
                    failReplaceSourceUpdate = false;
                    throw Object.assign(
                        new Error("E11000 injected API replacement source rewrite duplicate"),
                        { code: 11_000 },
                    );
                }
                return replaceOriginalCollections.roleMenuGrants.updateOne(...args);
            },
        });
        Object.defineProperty(repository, "collections", {
            value: Object.freeze({ ...replaceOriginalCollections, roleMenuGrants: failingReplaceRoleMenuGrants }),
            writable: true,
            configurable: true,
        });
        let replaceFailure: unknown;
        try {
            await impact.replace(scope, replaceInput, {
                ...replacePreview.expected,
                previewToken: replacePreview.previewToken,
                actorId: "admin",
                idempotencyKey: "api-impact-replace-fault",
            });
        } catch (error) {
            replaceFailure = error;
        } finally {
            Object.defineProperty(repository, "collections", {
                value: replaceOriginalCollections,
                writable: true,
                configurable: true,
            });
        }
        expect(replaceFailure).toBeDefined();
        expect(replaceFailure).not.toMatchObject({ code: "API_BINDING_ALREADY_EXISTS" });
        expect(await repository.scopeStates.read(scope)).toMatchObject({
            revision: replaceStateBeforeFailure.revision,
            rbacRevision: replaceStateBeforeFailure.rbacRevision,
            menuRevision: replaceStateBeforeFailure.menuRevision,
            auditRevision: replaceStateBeforeFailure.auditRevision,
            apiBindingCount: replaceStateBeforeFailure.apiBindingCount,
        });
        const readerAfterReplaceFailure = new MenuScopeReader(repository, schemes, replaceStateBeforeFailure);
        expect(await readerAfterReplaceFailure.requireBinding("api-impact-binding")).toMatchObject({
            method: "POST",
            path: "/api/impact/new",
            status: "enabled",
            revision: 3,
        });
        expect(await readerAfterReplaceFailure.requireBinding("api-impact-occupied")).toMatchObject({
            method: "GET",
            path: "/api/impact/occupied",
            revision: 1,
        });
        expect(await repository.collections.roleRules.count(
            { scopeKey, semanticKey: replacementSemanticKey },
            { cache: 0 },
        )).toBe(1);

        const replaced = await impact.replace(scope, replaceInput, {
            ...replacePreview.expected,
            previewToken: replacePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-impact-replace",
        });
        expect(replaced).toMatchObject({ changed: true, replayed: false, data: { updated: 3, conflicted: 0 } });
        expect((await impact.replace(scope, replaceInput, {
            ...replacePreview.expected,
            previewToken: replacePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-impact-replace",
        })).replayed).toBe(true);
        const postReplaceState = await repository.scopeStates.read(scope);
        const postReplaceReader = new MenuScopeReader(repository, schemes, postReplaceState);
        expect(await postReplaceReader.requireBinding("api-impact-binding")).toMatchObject({
            method: "GET",
            path: "/api/impact/occupied",
            status: "disabled",
            revision: 4,
        });
        expect(await postReplaceReader.requireBinding("api-impact-occupied")).toMatchObject({
            method: "POST",
            path: "/api/impact/new",
            revision: 2,
        });
        expect(await repository.collections.roleRules.count(
            { scopeKey, semanticKey: replacementSemanticKey },
            { cache: 0 },
        )).toBe(0);
        expect(await repository.collections.roleRules.findOne(
            { scopeKey, semanticKey: replaceSemanticKey },
            { cache: 0 },
        )).toMatchObject({
            resource: "api:GET:/api/impact/occupied",
            sources: [{ grantRevision: 3, apiBindingId: "api-impact-binding" }],
        });

        const replaceNoOpPreview = await impact.previewReplace(scope, replaceTarget, { actorId: "admin" });
        if (!replaceNoOpPreview.executable) throw new Error("expected API full replacement no-op preview to be executable");
        expect(replaceNoOpPreview).toMatchObject({
            capacity: null,
            plan: { operations: { total: 0 }, unchanged: { total: 2 } },
            summary: { unchanged: 2 },
        });
        const replaceNoOp = await impact.replace(scope, replaceTarget, {
            ...replaceNoOpPreview.expected,
            previewToken: replaceNoOpPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-impact-replace-noop",
        });
        expect(replaceNoOp).toMatchObject({ changed: false, data: { unchanged: 2 } });

        const duplicateIdPreview = await impact.previewReplace(scope, {
            bindings: [replaceTarget.bindings[0]!, replaceTarget.bindings[0]!, replaceTarget.bindings[1]!],
        }, { actorId: "admin" });
        expect(duplicateIdPreview).toMatchObject({ executable: false, previewToken: null });
        expect(duplicateIdPreview.conflicts.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "API_BINDING_ALREADY_EXISTS" }),
        ]));
        const duplicateEndpointPreview = await impact.previewReplace(scope, {
            bindings: [
                replaceTarget.bindings[0]!,
                {
                    ...replaceTarget.bindings[1]!,
                    method: "GET",
                    path: "/api/impact/occupied",
                    authorization: {
                        mode: "all" as const,
                        permissions: [{ action: "invoke" as const, resource: "api:GET:/api/impact/occupied" }],
                    },
                },
            ],
        }, { actorId: "admin" });
        expect(duplicateEndpointPreview).toMatchObject({ executable: false, previewToken: null });
        expect(duplicateEndpointPreview.conflicts.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "API_BINDING_ALREADY_EXISTS" }),
        ]));

        const removalImpact = await impact.getRemovalImpact(scope, "api-impact-binding");
        expect(removalImpact.data).toMatchObject({ roleSources: { total: 1 }, removableWithoutRewrite: false });
        const removalReject = await impact.previewRemove(scope, "api-impact-binding", {}, { actorId: "admin" });
        expect(removalReject).toMatchObject({
            executable: false,
            previewToken: null,
            conflicts: { items: [{ code: "SOURCE_REWRITE_REQUIRED" }] },
        });
        const removalSourceId = removalReject.plan.sourceImpacts.items[0]!.sourceId;
        const removeInput = {
            sourceRewrite: {
                mode: "apply" as const,
                resolutions: { [removalSourceId]: { action: "revoke" as const } },
            },
        };
        const removalPreview = await impact.previewRemove(scope, "api-impact-binding", removeInput, { actorId: "admin" });
        if (!removalPreview.executable) throw new Error("expected API removal preview to be executable");
        const removed = await impact.remove(scope, "api-impact-binding", removeInput, {
            ...removalPreview.expected,
            previewToken: removalPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-impact-remove",
        });
        expect(removed).toMatchObject({
            changed: true,
            replayed: false,
            data: { deleted: 2, conflicted: 0 },
        });
        expect((await impact.remove(scope, "api-impact-binding", removeInput, {
            ...removalPreview.expected,
            previewToken: removalPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-impact-remove",
        })).replayed).toBe(true);
        expect(await repository.collections.apiBindings.count({ scopeKey, bindingId: "api-impact-binding" }, { cache: 0 })).toBe(0);
        expect(await repository.collections.roleRules.count({ scopeKey, roleId: "api-impact-role" }, { cache: 0 })).toBe(0);
        expect(await repository.collections.roleMenuGrants.count({ scopeKey, roleId: "api-impact-role" }, { cache: 0 })).toBe(0);
        expect(await repository.collections.roles.findOne(
            { scopeKey, roleId: "api-impact-role" },
            { cache: 0, projection: { _id: 0, menuGrantCount: 1, menuSourceCount: 1 } },
        )).toMatchObject({ menuGrantCount: 0, menuSourceCount: 0 });
        const removeAudit = await repository.audits.getByOperationId(scope, removed.operationId);
        expect(removeAudit).toMatchObject({ operation: "apiBindings.remove", action: "remove", changed: true });
    }, TEST_TIMEOUT);

    it("accepts exactly 1000 API replacement mutations and rejects one over without writes", async () => {
        const prefix = `pc_b4_api_replace_limit_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        }, 1);
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-api-replace-limit" });
        const impact = new ApiBindingImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 29), "api-replace-limit"),
        );
        const bindings = Array.from({ length: 1_001 }, (_, index) => {
            const suffix = String(index).padStart(4, "0");
            return {
                id: `api-limit-${suffix}`,
                method: "GET" as const,
                path: `/api/limit/${suffix}`,
                purpose: "entry" as const,
                authorization: {
                    mode: "all" as const,
                    permissions: [{ action: "invoke" as const, resource: `api:GET:/api/limit/${suffix}` }],
                },
                owners: [],
            };
        });

        const exact = await impact.previewReplace(scope, { bindings: bindings.slice(0, 1_000) }, { actorId: "admin" });
        if (!exact.executable) throw new Error("expected exactly 1000 API replacement mutations to be executable");
        expect(exact).toMatchObject({
            summary: { inserted: 1_000, conflicted: 0 },
            plan: { operations: { total: 1_000, truncated: true }, unchanged: { total: 0 } },
        });
        expect(exact.expected.expectedRevisions).not.toHaveProperty("rbac");

        const oneOver = await impact.previewReplace(scope, { bindings }, { actorId: "admin" });
        expect(oneOver).toMatchObject({
            executable: false,
            previewToken: null,
            expected: null,
            summary: { inserted: 1_001, conflicted: 1 },
        });
        expect(oneOver.conflicts.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "LIMIT_EXCEEDED", id: "api-binding-replace-capacity" }),
        ]));
        const state = await repository.scopeStates.read(scope);
        expect(await repository.collections.apiBindings.count({ scopeKey: state.scopeKey }, { cache: 0 })).toBe(0);
    }, TEST_TIMEOUT);

    it("moves and reorders exact sibling sets with actor-bound previews and stale-plan rollback", async () => {
        const prefix = `pc_b4_menu_move_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-move" });
        const mutations = new MenuNodeMutationService(repository, schemes);
        const impact = new MenuNodeImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 19), "menu-move-preview"),
        );

        for (const id of ["root-a", "root-b"] as const) {
            await mutations.create(scope, { id, type: "directory", title: id }, {
                actorId: "admin",
                idempotencyKey: `create-${id}`,
            });
        }
        for (const [id, parentId] of [["a-1", "root-a"], ["a-2", "root-a"], ["b-1", "root-b"]] as const) {
            await mutations.create(scope, {
                id,
                parentId,
                type: "page",
                title: id,
                path: `/${id}`,
                name: id,
                component: `${id}-component`,
                permission: { action: "read", resource: `ui:page:${id}` },
            }, { actorId: "admin", idempotencyKey: `create-${id}` });
        }

        const moveInput = { nodeId: "a-2", parentId: "root-b", beforeId: "b-1" } as const;
        const movePreview = await impact.previewMove(scope, moveInput, { actorId: "admin" });
        if (!movePreview.executable) throw new Error("expected the menu move preview to be executable");
        expect(movePreview.plan).toMatchObject({
            nodeId: "a-2",
            fromParentId: "root-a",
            toParentId: "root-b",
            descendantCount: 0,
        });
        await expect(impact.move(scope, moveInput, {
            ...movePreview.expected,
            previewToken: movePreview.previewToken,
            actorId: "other-admin",
            idempotencyKey: "move-a-2-wrong-actor",
        })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
        await expect(impact.move(scope, { nodeId: "a-2", parentId: "root-b", afterId: "b-1" }, {
            ...movePreview.expected,
            previewToken: movePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "move-a-2-wrong-input",
        })).rejects.toMatchObject({ code: "PREVIEW_STALE" });

        const moved = await impact.move(scope, moveInput, {
            ...movePreview.expected,
            previewToken: movePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "move-a-2",
        });
        expect(moved).toMatchObject({
            changed: true,
            replayed: false,
            data: { id: "a-2", parentId: "root-b", order: 0, revision: 2 },
        });
        const moveReplay = await impact.move(scope, moveInput, {
            ...movePreview.expected,
            previewToken: movePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "move-a-2",
        });
        expect(moveReplay).toMatchObject({ replayed: true, operationId: moved.operationId });
        await expect(impact.move(scope, moveInput, {
            ...movePreview.expected,
            previewToken: movePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "move-a-2-stale",
        })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

        let inventory = await (await new MenuReadStore(repository, schemes).open(scope)).readCompleteInventory();
        expect(inventory.nodes
            .filter((node) => node.parentId === "root-a")
            .sort((left, right) => left.order - right.order)
            .map((node) => [node.nodeId, node.order])).toEqual([["a-1", 0]]);
        expect(inventory.nodes
            .filter((node) => node.parentId === "root-b")
            .sort((left, right) => left.order - right.order)
            .map((node) => [node.nodeId, node.order])).toEqual([["a-2", 0], ["b-1", 1]]);

        await expect(impact.previewReorder(scope, {
            parentId: "root-b",
            orderedNodeIds: ["a-2"],
        }, { actorId: "admin" })).rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        const reorderInput = { parentId: "root-b", orderedNodeIds: ["b-1", "a-2"] } as const;
        const reorderPreview = await impact.previewReorder(scope, reorderInput, { actorId: "admin" });
        if (!reorderPreview.executable) throw new Error("expected the menu reorder preview to be executable");
        const reordered = await impact.reorder(scope, reorderInput, {
            ...reorderPreview.expected,
            previewToken: reorderPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "reorder-root-b",
        });
        expect(reordered).toMatchObject({ changed: true, data: { updated: 2, conflicted: 0 } });
        expect((await impact.reorder(scope, reorderInput, {
            ...reorderPreview.expected,
            previewToken: reorderPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "reorder-root-b",
        })).replayed).toBe(true);

        const staleMoveInput = { nodeId: "a-1", parentId: "root-b" } as const;
        const staleMovePreview = await impact.previewMove(scope, staleMoveInput, { actorId: "admin" });
        if (!staleMovePreview.executable) throw new Error("expected the stale-plan setup preview to be executable");
        await mutations.create(scope, {
            id: "a-3",
            parentId: "root-a",
            type: "page",
            title: "a-3",
            path: "/a-3",
            name: "a-3",
            component: "a-3-component",
            permission: { action: "read", resource: "ui:page:a-3" },
        }, { actorId: "admin", idempotencyKey: "create-a-3" });
        await expect(impact.move(scope, staleMoveInput, {
            ...staleMovePreview.expected,
            previewToken: staleMovePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "stale-move-a-1",
        })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
        inventory = await (await new MenuReadStore(repository, schemes).open(scope)).readCompleteInventory();
        expect(inventory.nodes.find((node) => node.nodeId === "a-1")).toMatchObject({ parentId: "root-a", order: 0 });
        expect(inventory.nodes
            .filter((node) => node.parentId === "root-b")
            .sort((left, right) => left.order - right.order)
            .map((node) => [node.nodeId, node.order])).toEqual([["b-1", 0], ["a-2", 1]]);
    }, TEST_TIMEOUT);

    it("previews and commits node availability against menu sources, inheritance, and manual-source union", async () => {
        const prefix = `pc_b4_menu_status_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-status" });
        const scopeKey = createScopeKey(scope);
        const menuMutations = new MenuNodeMutationService(repository, schemes);
        const statusMutations = new MenuNodeImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 29), "menu-status-preview"),
        );
        const roleMutations = new RoleMutationService(repository, schemes);
        const userRoles = new UserRoleMutationService(repository, schemes);

        await menuMutations.create(scope, {
            id: "status-page",
            type: "page",
            title: "Status page",
            path: "/status",
            name: "status-page",
            component: "StatusPage",
            permission: { action: "read", resource: "ui:page:status" },
        }, { actorId: "admin", idempotencyKey: "create-status-page" });
        await roleMutations.create(scope, { id: "status-parent", label: "Status parent" }, {
            actorId: "admin",
            idempotencyKey: "create-status-parent",
        });
        await roleMutations.create(scope, {
            id: "status-child",
            label: "Status child",
            parentId: "status-parent",
        }, { actorId: "admin", idempotencyKey: "create-status-child" });
        await userRoles.assign(scope, "u-parent", "status-parent", {
            actorId: "admin",
            idempotencyKey: "assign-status-parent",
        });
        await userRoles.assign(scope, "u-child", "status-child", {
            actorId: "admin",
            idempotencyKey: "assign-status-child",
        });

        const now = Date.now();
        const menuRule = (
            roleId: string,
            effect: "allow" | "deny",
            action: string,
            resource: string,
            grantId: string,
            retainManual = false,
        ) => {
            const semanticKey = createSemanticKey(effect, action, resource);
            const menuSource = {
                sourceId: createMenuSourceId({
                    grantId,
                    semanticKey,
                    contribution: "node",
                    assetId: "status-page",
                }),
                kind: "menu" as const,
                grantId,
                grantRevision: 1,
                effect,
                contribution: "node" as const,
                assetId: "status-page",
            };
            return {
                scopeKey,
                scope,
                roleId,
                effect,
                action,
                resource,
                semanticKey,
                sources: retainManual
                    ? [menuSource, { sourceId: `manual:${semanticKey}`, kind: "manual" as const }]
                    : [menuSource],
                revision: 1,
                createdAt: now,
                updatedAt: now,
            };
        };
        const seededRules = [
            menuRule("status-parent", "allow", "read", "ui:page:status", "grant-status-allow"),
            menuRule("status-child", "deny", "read", "ui:page:status", "grant-status-deny"),
            menuRule("status-child", "allow", "read", "ui:page:manual-preserved", "grant-status-manual", true),
        ];
        await repository.collections.roleRules.insertMany(seededRules.map((rule) => ({ ...rule })));
        const sourceIdentitySnapshot = seededRules.map((rule) => ({
            semanticKey: rule.semanticKey,
            sourceIds: rule.sources.map((source) => source.sourceId).sort(compareUtf8),
        })).sort((left, right) => compareUtf8(left.semanticKey, right.semanticKey));

        const disabledPreview = await statusMutations.previewSetStatus(
            scope,
            "status-page",
            "disabled",
            { actorId: "admin" },
        );
        if (!disabledPreview.executable) throw new Error("expected disabled status preview to be executable");
        expect(disabledPreview.plan).toMatchObject({
            nodeId: "status-page",
            before: "enabled",
            after: "disabled",
            affectedSources: { total: 3 },
            affectedRoles: { total: 2 },
            affectedUsers: { total: 2 },
        });
        expect(disabledPreview.capacity).toMatchObject({
            proof: "exact",
            disposition: "safe",
            accessDirection: "mixed",
            affectedUsers: { total: 2 },
        });
        expect(disabledPreview.detailBudget.returned).toBeLessThanOrEqual(100);

        await expect(statusMutations.setStatus(scope, "status-page", "deprecated", {
            ...disabledPreview.expected,
            previewToken: disabledPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "status-wrong-input",
        })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
        await expect(statusMutations.setStatus(scope, "status-page", "disabled", {
            ...disabledPreview.expected,
            previewToken: disabledPreview.previewToken,
            actorId: "admin",
            acknowledgeCapacityRisk: true,
            idempotencyKey: "status-unexpected-ack",
        })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        expect((await repository.scopeStates.read(scope)).menuRevision).toBe(disabledPreview.revisions.menu);

        const disabled = await statusMutations.setStatus(scope, "status-page", "disabled", {
            ...disabledPreview.expected,
            previewToken: disabledPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "disable-status-page",
        });
        expect(disabled).toMatchObject({ changed: true, replayed: false, data: { status: "disabled", revision: 2 } });
        expect(disabled.revisions.rbac).toBe(disabledPreview.revisions.rbac);
        expect((await statusMutations.setStatus(scope, "status-page", "disabled", {
            ...disabledPreview.expected,
            previewToken: disabledPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "disable-status-page",
        })).replayed).toBe(true);

        const deprecatedPreview = await statusMutations.previewSetStatus(
            scope,
            "status-page",
            "deprecated",
            { actorId: "admin" },
        );
        if (!deprecatedPreview.executable) throw new Error("expected inactive-to-inactive preview to be executable");
        expect(deprecatedPreview.plan).toMatchObject({
            before: "disabled",
            after: "deprecated",
            affectedSources: { total: 0 },
            affectedRoles: { total: 0 },
            affectedUsers: { total: 0 },
        });
        expect(deprecatedPreview.capacity).toMatchObject({ accessDirection: "none", proof: "exact", disposition: "safe" });
        const deprecated = await statusMutations.setStatus(scope, "status-page", "deprecated", {
            ...deprecatedPreview.expected,
            previewToken: deprecatedPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "deprecate-status-page",
        });
        expect(deprecated.data).toMatchObject({ status: "deprecated", revision: 3 });

        const enabledPreview = await statusMutations.previewSetStatus(
            scope,
            "status-page",
            "enabled",
            { actorId: "admin" },
        );
        if (!enabledPreview.executable) throw new Error("expected re-enable preview to be executable");
        expect(enabledPreview.plan).toMatchObject({ affectedSources: { total: 3 }, affectedUsers: { total: 2 } });
        expect(enabledPreview.capacity).toMatchObject({ accessDirection: "mixed", proof: "exact", disposition: "safe" });
        const enabled = await statusMutations.setStatus(scope, "status-page", "enabled", {
            ...enabledPreview.expected,
            previewToken: enabledPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "enable-status-page",
        });
        expect(enabled.data).toMatchObject({ status: "enabled", revision: 4 });
        expect(enabled.revisions.rbac).toBe(disabledPreview.revisions.rbac);

        const persistedRules = await repository.collections.roleRules.find(
            { scopeKey },
            { cache: 0, collation: SIMPLE_COLLATION },
        ).sort({ semanticKey: 1 }).toArray();
        expect(persistedRules.map((rule) => materializeRoleRuleDocument(rule, scope, scopeKey, schemes)).map((rule) => ({
            semanticKey: rule.semanticKey,
            sourceIds: rule.sources.map((source) => source.sourceId).sort(compareUtf8),
        }))).toEqual(sourceIdentitySnapshot);
        const state = await repository.scopeStates.read(scope);
        const inventory = await (await new MenuReadStore(repository, schemes).open(scope)).readCompleteInventory();
        expect(inventory.nodes.find((node) => node.nodeId === "status-page")).toMatchObject({ status: "enabled", revision: 4 });
        expect(inventory.manifestBytes).toBe(state.replaceManifestBytes);
    }, TEST_TIMEOUT);

    it("requires acknowledgement for a partial high-fanout access expansion and writes one status entity", async () => {
        const prefix = `pc_b4_menu_status_fanout_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-status-fanout" });
        const scopeKey = createScopeKey(scope);
        const menuMutations = new MenuNodeMutationService(repository, schemes);
        const roleMutations = new RoleMutationService(repository, schemes);
        const statusMutations = new MenuNodeImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 31), "menu-status-fanout"),
        );
        await menuMutations.create(scope, {
            id: "fanout-page",
            type: "page",
            title: "Fanout page",
            path: "/fanout",
            name: "fanout-page",
            component: "FanoutPage",
            permission: { action: "read", resource: "ui:page:fanout" },
        }, { actorId: "admin", idempotencyKey: "create-fanout-page" });
        await roleMutations.create(scope, { id: "fanout-deny", label: "Fanout deny" }, {
            actorId: "admin",
            idempotencyKey: "create-fanout-role",
        });

        const now = Date.now();
        const semanticKey = createSemanticKey("deny", "read", "ui:page:fanout");
        const grantId = "grant-fanout-deny";
        await repository.collections.roleRules.insertOne({
            scopeKey,
            scope,
            roleId: "fanout-deny",
            effect: "deny",
            action: "read",
            resource: "ui:page:fanout",
            semanticKey,
            sources: [{
                sourceId: createMenuSourceId({
                    grantId,
                    semanticKey,
                    contribution: "node",
                    assetId: "fanout-page",
                }),
                kind: "menu",
                grantId,
                grantRevision: 1,
                effect: "deny",
                contribution: "node",
                assetId: "fanout-page",
            }],
            revision: 1,
            createdAt: now,
            updatedAt: now,
        });
        await repository.collections.userRoleSets.insertMany(Array.from({ length: 1_001 }, (_, index) => ({
            scopeKey,
            scope,
            userId: `u-fanout-${String(index).padStart(4, "0")}`,
            roleIds: ["fanout-deny"],
            revision: 1,
            createdAt: now,
            updatedAt: now,
        })));

        const preview = await statusMutations.previewSetStatus(scope, "fanout-page", "disabled", { actorId: "admin" });
        if (!preview.executable) throw new Error("expected partial fanout preview to remain executable with acknowledgement");
        expect(preview.plan).toMatchObject({ affectedSources: { total: 1 }, affectedUsers: { total: 1_001 } });
        expect(preview.capacity).toMatchObject({
            accessDirection: "expand",
            proof: "partial",
            disposition: "ack-required",
            evaluatedUsers: 1_000,
            unverifiedUsers: 1,
            affectedUsers: { total: 1_001 },
        });
        expect(preview.warnings).toMatchObject({ total: 1, items: [{ code: "CAPACITY_RISK_ACK_REQUIRED" }] });

        await expect(statusMutations.setStatus(scope, "fanout-page", "disabled", {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "fanout-disable-without-ack",
        })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        const changed = await statusMutations.setStatus(scope, "fanout-page", "disabled", {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            acknowledgeCapacityRisk: true,
            idempotencyKey: "fanout-disable-with-ack",
        });
        expect(changed).toMatchObject({ changed: true, data: { status: "disabled", revision: 2 } });
        expect(changed.revisions.rbac).toBe(preview.revisions.rbac);
        const audit = await repository.audits.getByOperationId(scope, changed.operationId);
        expect(audit.cacheTargets).toEqual([`scope:${scopeKey}`]);
        expect(audit.capacity).toMatchObject({
            accessDirection: "expand",
            proof: "partial",
            disposition: "ack-required",
            affectedUsers: { total: 1_001 },
        });
        expect(await repository.collections.roleRules.count(
            { scopeKey },
            { cache: 0, collation: SIMPLE_COLLATION },
        )).toBe(1);
    }, TEST_TIMEOUT);

    it("returns a non-executable reorder preview before a 1001-write transaction", async () => {
        const prefix = `pc_b4_menu_reorder_limit_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-reorder-limit" });
        const scopeKey = createScopeKey(scope);
        const now = Date.now();
        const documents = Array.from({ length: 1_001 }, (_, order) => menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput({
                id: `root-${String(order).padStart(4, "0")}`,
                type: "directory",
                title: `Root ${order}`,
            }, schemes),
            order,
            1,
            now,
        ));
        const replaceManifestBytes = canonicalByteLength({
            schemaVersion: 2,
            mode: "replace",
            nodes: documents.map(menuNodeManifestItemFromDocument),
            apiBindings: [],
        });
        await repository.collections.scopeState.insertOne({
            scopeKey,
            scope,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
            revision: 1,
            rbacRevision: 0,
            menuRevision: 1,
            auditRevision: 1,
            menuConfigCount: 0,
            menuConfigBytes: 0,
            responseFieldCount: 0,
            responseFieldOwnerCount: 0,
            menuNodeCount: documents.length,
            apiBindingCount: 0,
            replaceManifestBytes,
            createdAt: now,
            updatedAt: now,
        });
        await repository.collections.menuNodes.insertMany(documents.map((document) => ({ ...document })));
        const impact = new MenuNodeImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 23), "menu-reorder-limit"),
        );
        const orderedNodeIds = documents.map((document) => document.nodeId);
        const preview = await impact.previewReorder(scope, {
            parentId: null,
            orderedNodeIds: [orderedNodeIds.at(-1)!, ...orderedNodeIds.slice(0, -1)],
        }, { actorId: "admin" });
        expect(preview).toMatchObject({
            executable: false,
            previewToken: null,
            expected: null,
            summary: { updated: 1_001, conflicted: 1 },
            conflicts: { total: 1, items: [{ code: "LIMIT_EXCEEDED" }] },
        });
        const state = await repository.scopeStates.read(scope);
        expect(state).toMatchObject({ revision: 1, menuRevision: 1, auditRevision: 1, menuNodeCount: 1_001 });
    }, TEST_TIMEOUT);

    it("removes a menu subtree with explicit source decisions and rolls every dependency back on failure", async () => {
        const prefix = `pc_b4_menu_remove_${randomUUID().replaceAll("-", "")}`;
        const schemes = new ResourceSchemeRegistry();
        const schemeContractDigest = schemes.schemeContractDigest;
        const repository = new PermissionRepository(context.monsqlize, prefix, {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-remove" });
        const scopeKey = createScopeKey(scope);
        const tokens = new SignedTokenCodec(Buffer.alloc(32, 37), "menu-remove-preview");
        const menuMutations = new MenuNodeMutationService(repository, schemes);
        const impact = new MenuNodeImpactMutationService(repository, schemes, tokens);
        const apiMutations = new ApiBindingMutationService(repository, schemes);
        const roleMutations = new RoleMutationService(repository, schemes);
        const userRoles = new UserRoleMutationService(repository, schemes);

        await menuMutations.create(scope, {
            id: "remove-root",
            type: "directory",
            title: "Remove root",
        }, { actorId: "admin", idempotencyKey: "remove-create-root" });
        await menuMutations.create(scope, {
            id: "keep-page",
            type: "page",
            title: "Keep page",
            path: "/keep",
            name: "keep-page",
            component: "KeepPage",
            permission: { action: "read", resource: "ui:page:keep" },
        }, { actorId: "admin", idempotencyKey: "remove-create-keep" });
        await menuMutations.create(scope, {
            id: "after-root",
            type: "directory",
            title: "After root",
        }, { actorId: "admin", idempotencyKey: "remove-create-after" });
        await menuMutations.create(scope, {
            id: "remove-page",
            parentId: "remove-root",
            type: "page",
            title: "Remove page",
            path: "/remove",
            name: "remove-page",
            component: "RemovePage",
            permission: { action: "read", resource: "ui:page:remove" },
        }, { actorId: "admin", idempotencyKey: "remove-create-page" });
        await menuMutations.create(scope, {
            id: "remove-button",
            parentId: "remove-page",
            type: "button",
            title: "Remove button",
            code: "remove",
            permission: { action: "execute", resource: "ui:button:remove" },
        }, { actorId: "admin", idempotencyKey: "remove-create-button" });
        await apiMutations.create(scope, {
            id: "remove-api",
            method: "GET",
            path: "/api/remove",
            purpose: "entry",
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: "api:GET:/api/remove" }],
            },
            owners: [
                { type: "page", id: "keep-page", required: true },
                { type: "page", id: "remove-page", required: true },
            ],
            canonicalOwner: { type: "page", id: "remove-page" },
        }, { actorId: "admin", idempotencyKey: "remove-create-api" });
        await roleMutations.create(scope, { id: "remove-role", label: "Remove role" }, {
            actorId: "admin",
            idempotencyKey: "remove-create-role",
        });
        await roleMutations.create(scope, {
            id: "remove-child",
            label: "Remove child",
            parentId: "remove-role",
        }, { actorId: "admin", idempotencyKey: "remove-create-child" });
        await userRoles.assign(scope, "u-remove", "remove-child", {
            actorId: "admin",
            idempotencyKey: "remove-assign-user",
        });

        const now = Date.now();
        await repository.collections.userRoleSets.insertMany(Array.from({ length: 100 }, (_, index) => ({
            scopeKey,
            scope,
            userId: `u-remove-capacity-${String(index).padStart(3, "0")}`,
            roleIds: ["remove-child"],
            revision: 1,
            createdAt: now,
            updatedAt: now,
        })));
        const allowGrantId = "grant-remove-allow";
        const denyGrantId = "grant-remove-deny";
        const removePageKey = createSemanticKey("allow", "read", "ui:page:remove");
        const keepPageKey = createSemanticKey("allow", "read", "ui:page:keep");
        const removeButtonKey = createSemanticKey("allow", "execute", "ui:button:remove");
        const removeApiKey = createSemanticKey("deny", "invoke", "api:GET:/api/remove");
        const removePageSource = {
            sourceId: createMenuSourceId({
                grantId: allowGrantId,
                semanticKey: removePageKey,
                contribution: "node",
                assetId: "remove-page",
            }),
            kind: "menu" as const,
            grantId: allowGrantId,
            grantRevision: 1,
            effect: "allow" as const,
            contribution: "node" as const,
            assetId: "remove-page",
        };
        const keepPageSource = {
            sourceId: createMenuSourceId({
                grantId: allowGrantId,
                semanticKey: keepPageKey,
                contribution: "node",
                assetId: "keep-page",
            }),
            kind: "menu" as const,
            grantId: allowGrantId,
            grantRevision: 1,
            effect: "allow" as const,
            contribution: "node" as const,
            assetId: "keep-page",
        };
        const removeButtonSource = {
            sourceId: createMenuSourceId({
                grantId: allowGrantId,
                semanticKey: removeButtonKey,
                contribution: "node",
                assetId: "remove-button",
            }),
            kind: "menu" as const,
            grantId: allowGrantId,
            grantRevision: 1,
            effect: "allow" as const,
            contribution: "node" as const,
            assetId: "remove-button",
        };
        const removeApiSource = {
            sourceId: createMenuSourceId({
                grantId: denyGrantId,
                semanticKey: removeApiKey,
                contribution: "api",
                assetId: "remove-page",
                apiBindingId: "remove-api",
            }),
            kind: "menu" as const,
            grantId: denyGrantId,
            grantRevision: 1,
            effect: "deny" as const,
            contribution: "api" as const,
            assetId: "remove-page",
            apiBindingId: "remove-api",
        };
        const rawRules = [
            {
                scopeKey,
                scope,
                roleId: "remove-role",
                effect: "allow",
                action: "read",
                resource: "ui:page:remove",
                semanticKey: removePageKey,
                sources: [
                    removePageSource,
                    { sourceId: `manual:${removePageKey}`, kind: "manual" as const },
                ].sort((left, right) => compareUtf8(left.sourceId, right.sourceId)),
                revision: 1,
                createdAt: now,
                updatedAt: now,
            },
            {
                scopeKey,
                scope,
                roleId: "remove-role",
                effect: "allow",
                action: "read",
                resource: "ui:page:keep",
                semanticKey: keepPageKey,
                sources: [keepPageSource],
                revision: 1,
                createdAt: now,
                updatedAt: now,
            },
            {
                scopeKey,
                scope,
                roleId: "remove-role",
                effect: "allow",
                action: "execute",
                resource: "ui:button:remove",
                semanticKey: removeButtonKey,
                sources: [removeButtonSource],
                revision: 1,
                createdAt: now,
                updatedAt: now,
            },
            {
                scopeKey,
                scope,
                roleId: "remove-role",
                effect: "deny",
                action: "invoke",
                resource: "api:GET:/api/remove",
                semanticKey: removeApiKey,
                sources: [removeApiSource],
                revision: 1,
                createdAt: now,
                updatedAt: now,
            },
        ];
        const rules = rawRules.map((rule) => materializeRoleRuleDocument(rule, scope, scopeKey, schemes));
        const allowIntent = {
            anchorId: "remove-root",
            include: { descendants: true, buttons: true, apis: "none" as const, dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        const denyIntent = {
            anchorId: "remove-page",
            include: { descendants: false, buttons: false, apis: "all" as const, dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        const contributionsFor = (grantId: string) => rules.flatMap((rule) =>
            rule.sources.flatMap((source) => source.kind === "menu" && source.grantId === grantId
                ? [{ rule, source }]
                : []));
        const grants = [
            {
                scopeKey,
                scope,
                roleId: "remove-role",
                grantId: allowGrantId,
                effect: "allow" as const,
                intent: allowIntent,
                snapshot: createRoleMenuGrantSnapshot(allowIntent, contributionsFor(allowGrantId)),
                grantRevision: 1,
                createdAt: now,
                updatedAt: now,
            },
            {
                scopeKey,
                scope,
                roleId: "remove-role",
                grantId: denyGrantId,
                effect: "deny" as const,
                intent: denyIntent,
                snapshot: createRoleMenuGrantSnapshot(denyIntent, contributionsFor(denyGrantId)),
                grantRevision: 1,
                createdAt: now,
                updatedAt: now,
            },
        ];
        const aggregate = createRoleMenuAggregateFields(grants, rules);
        await repository.collections.roleRules.insertMany(rules.map((rule) => ({
            ...rule,
            sources: rule.sources.map((source) => ({ ...source })),
        })));
        await repository.collections.roleMenuGrants.insertMany(grants.map((grant) => ({
            ...grant,
            intent: { ...grant.intent },
            snapshot: { ...grant.snapshot },
        })));
        const aggregateWrite = await repository.collections.roles.updateOne(
            { scopeKey, roleId: "remove-role", revision: 1 },
            { $set: aggregate },
            { cache: { invalidate: false }, collation: SIMPLE_COLLATION },
        );
        expect(aggregateWrite).toMatchObject({ matchedCount: 1, modifiedCount: 1 });

        const removalImpact = await impact.getRemovalImpact(scope, "remove-root");
        expect(removalImpact.data).toMatchObject({
            nodeId: "remove-root",
            descendants: { total: 2 },
            apiBindings: { total: 1 },
            roleSources: { total: 3 },
            removableWithoutCascade: false,
        });
        expect(removalImpact.detailBudget.returned).toBeLessThanOrEqual(100);

        const nonCascade = await impact.previewRemove(scope, "remove-root", { cascade: false }, { actorId: "admin" });
        expect(nonCascade).toMatchObject({
            executable: false,
            previewToken: null,
            conflicts: { items: [{ code: "MENU_DEPENDENCY_EXISTS" }] },
        });
        const unresolved = await impact.previewRemove(scope, "remove-root", { cascade: true }, { actorId: "admin" });
        expect(unresolved).toMatchObject({
            executable: false,
            previewToken: null,
            plan: {
                rootNodeId: "remove-root",
                cascade: true,
                nodes: { total: 3 },
                detachedApiBindings: { total: 1 },
                sourceImpacts: { total: 3 },
            },
            conflicts: { total: 3 },
        });
        const resolutions: Record<string, { action: "revoke" }> = {};
        for (const sourceImpact of unresolved.plan.sourceImpacts.items) {
            resolutions[sourceImpact.sourceId] = { action: "revoke" };
        }
        const removeInput = { cascade: true, sourceRewrite: { mode: "apply" as const, resolutions } };
        const preview = await impact.previewRemove(scope, "remove-root", removeInput, { actorId: "admin" });
        if (!preview.executable) throw new Error("expected the fully resolved removal preview to be executable");
        expect(preview.plan.sourceImpacts).toMatchObject({ total: 3, truncated: false });
        expect(preview.plan.sourceImpacts.items).toHaveLength(3);
        expect(preview).toMatchObject({
            summary: { updated: 4, deleted: 6, conflicted: 0 },
            capacity: {
                accessDirection: "mixed",
                capacityDirection: "non-increasing",
                proof: "exact",
                disposition: "safe",
                affectedUsers: { total: 101, truncated: true },
            },
        });
        expect(preview.detailBudget).toMatchObject({ limit: 100, returned: 100, truncated: true });
        const stateBeforeFailure = await repository.scopeStates.read(scope);

        const originalCollections = repository.collections;
        let failNextRuleUpdate = true;
        const failingRoleRules = Object.freeze({
            ...originalCollections.roleRules,
            async updateOne(...args: Parameters<typeof originalCollections.roleRules.updateOne>) {
                if (failNextRuleUpdate) {
                    failNextRuleUpdate = false;
                    throw new Error("injected source rewrite failure");
                }
                return originalCollections.roleRules.updateOne(...args);
            },
        });
        Object.defineProperty(repository, "collections", {
            value: Object.freeze({ ...originalCollections, roleRules: failingRoleRules }),
            writable: true,
            configurable: true,
        });
        try {
            await expect(impact.remove(scope, "remove-root", removeInput, {
                ...preview.expected,
                previewToken: preview.previewToken,
                actorId: "admin",
                idempotencyKey: "remove-fault",
            })).rejects.toBeDefined();
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
            auditRevision: stateBeforeFailure.auditRevision,
            menuNodeCount: stateBeforeFailure.menuNodeCount,
            apiBindingCount: stateBeforeFailure.apiBindingCount,
        });
        expect((await impact.getRemovalImpact(scope, "remove-root")).data).toMatchObject({
            descendants: { total: 2 },
            apiBindings: { total: 1 },
            roleSources: { total: 3 },
        });

        await expect(impact.remove(scope, "remove-root", { ...removeInput, cascade: false }, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "remove-wrong-input",
        })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
        const removed = await impact.remove(scope, "remove-root", removeInput, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "remove-success",
        });
        expect(removed).toMatchObject({
            changed: true,
            replayed: false,
            data: { updated: 4, deleted: 6, conflicted: 0 },
        });
        expect(removed.revisions).toMatchObject({
            global: stateBeforeFailure.revision + 1,
            rbac: stateBeforeFailure.rbacRevision + 1,
            menu: stateBeforeFailure.menuRevision + 1,
            audit: stateBeforeFailure.auditRevision + 1,
        });
        expect((await impact.remove(scope, "remove-root", removeInput, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "remove-success",
        })).replayed).toBe(true);

        const finalState = await repository.scopeStates.read(scope);
        const menuReader = new MenuScopeReader(repository, schemes, finalState);
        const finalInventory = await menuReader.readCompleteInventory();
        expect(finalInventory.nodes.map((node) => [node.nodeId, node.parentId, node.order])).toEqual([
            ["after-root", null, 1],
            ["keep-page", null, 0],
        ]);
        expect(finalInventory.bindings).toHaveLength(1);
        expect(finalInventory.bindings[0]).toMatchObject({
            bindingId: "remove-api",
            owners: [{ type: "page", id: "keep-page", required: true }],
            revision: 2,
        });
        expect(finalInventory.bindings[0]!.canonicalOwner).toBeUndefined();

        const rbacReader = new RbacScopeReader(repository, schemes, finalState);
        const finalRole = await rbacReader.requireRole("remove-role");
        expect(finalRole).toMatchObject({ revision: 2, menuGrantCount: 1, menuSourceCount: 1 });
        const finalRules = await rbacReader.readRulesForRole("remove-role");
        expect(finalRules).toHaveLength(2);
        expect(finalRules.find((rule) => rule.semanticKey === removePageKey)?.sources).toEqual([
            { sourceId: `manual:${removePageKey}`, kind: "manual" },
        ]);
        const survivingRule = finalRules.find((rule) => rule.semanticKey === keepPageKey)!;
        expect(survivingRule.sources).toMatchObject([{
            sourceId: keepPageSource.sourceId,
            kind: "menu",
            grantId: allowGrantId,
            grantRevision: 2,
            assetId: "keep-page",
        }]);
        const finalGrants = await menuReader.readGrantsForRole("remove-role");
        expect(finalGrants).toHaveLength(1);
        expect(finalGrants[0]).toMatchObject({
            grantId: allowGrantId,
            grantRevision: 2,
            snapshot: {
                contributingAssetCount: 1,
                contributingAssetIds: ["keep-page"],
                contributingBindingCount: 0,
                contributingBindingIds: [],
            },
        });
        const audit = await repository.audits.getByOperationId(scope, removed.operationId);
        expect(audit.change).toMatchObject({
            kind: "menu-remove",
            plan: { sourceRewrite: { sourceMutationCount: 4 } },
        });
        await expect(impact.getRemovalImpact(scope, "remove-root")).rejects.toMatchObject({ code: "MENU_NOT_FOUND" });

        const isolatedImpact = await impact.getRemovalImpact(scope, "after-root");
        expect(isolatedImpact.data).toMatchObject({
            descendants: { total: 0 },
            apiBindings: { total: 0 },
            roleSources: { total: 0 },
            removableWithoutCascade: true,
        });
        const stateBeforeIsolatedRemoval = await repository.scopeStates.read(scope);
        const isolatedPreview = await impact.previewRemove(scope, "after-root", { cascade: false }, { actorId: "admin" });
        if (!isolatedPreview.executable) throw new Error("expected an isolated menu removal preview to be executable");
        expect(isolatedPreview.capacity).toBeNull();
        expect(isolatedPreview.expected.expectedRevisions).not.toHaveProperty("rbac");
        const isolatedRemoval = await impact.remove(scope, "after-root", { cascade: false }, {
            ...isolatedPreview.expected,
            previewToken: isolatedPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "remove-isolated",
        });
        expect(isolatedRemoval.data).toMatchObject({ updated: 0, deleted: 1, conflicted: 0 });
        expect(isolatedRemoval.revisions).toMatchObject({
            rbac: stateBeforeIsolatedRemoval.rbacRevision,
            menu: stateBeforeIsolatedRemoval.menuRevision + 1,
        });
    }, TEST_TIMEOUT);
});
