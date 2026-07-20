import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import {
    ApiBindingImpactMutationService,
    ApiBindingMutationService,
    MenuNodeImpactMutationService,
    MenuNodeMutationService,
} from "../../src/menu";
import { PermissionRepository } from "../../src/persistence/repository";
import { PERSISTED_SCHEMA_VERSION } from "../../src/persistence/documents";
import { normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;

function repositoryFixture(context: RealMongoContext, label: string) {
    const schemes = new ResourceSchemeRegistry();
    const schemeContractDigest = schemes.schemeContractDigest;
    const repository = new PermissionRepository(
        context.monsqlize,
        `pc_menu_boundary_${label}_${randomUUID().replaceAll("-", "")}`,
        {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        },
    );
    return { repository, schemes };
}

async function withMenuNodes<T>(
    repository: PermissionRepository,
    overrides: Partial<PermissionRepository["collections"]["menuNodes"]>,
    work: () => Promise<T>,
) {
    const original = repository.collections;
    Object.defineProperty(repository, "collections", {
        value: Object.freeze({
            ...original,
            menuNodes: Object.freeze({ ...original.menuNodes, ...overrides }),
        }),
        writable: true,
        configurable: true,
    });
    try {
        return await work();
    } finally {
        Object.defineProperty(repository, "collections", {
            value: original,
            writable: true,
            configurable: true,
        });
    }
}

async function withApiBindings<T>(
    repository: PermissionRepository,
    overrides: Partial<PermissionRepository["collections"]["apiBindings"]>,
    work: () => Promise<T>,
) {
    const original = repository.collections;
    Object.defineProperty(repository, "collections", {
        value: Object.freeze({
            ...original,
            apiBindings: Object.freeze({ ...original.apiBindings, ...overrides }),
        }),
        writable: true,
        configurable: true,
    });
    try {
        return await work();
    } finally {
        Object.defineProperty(repository, "collections", {
            value: original,
            writable: true,
            configurable: true,
        });
    }
}

function page(id: string, parentId: string | null = null) {
    return {
        id,
        parentId,
        type: "page" as const,
        title: id,
        path: `/${id}`,
        name: id,
        component: `${id}-component`,
        permission: { action: "read" as const, resource: `ui:page:${id}` },
    };
}

describe("menu mutation failure-closed boundaries on MonSQLize 3.1", () => {
    let context: RealMongoContext;

    beforeAll(async () => {
        context = await startRealMongo();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    it("classifies identity, hierarchy, revision, deprecation, and nullable-patch failures", async () => {
        const { repository, schemes } = repositoryFixture(context, "crud");
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-boundary-crud" });
        const mutations = new MenuNodeMutationService(repository, schemes);
        const impacts = new MenuNodeImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 51), "menu-boundary-status"),
        );

        await mutations.create(scope, { id: "root", type: "directory", title: "Root" }, {
            actorId: "admin",
            idempotencyKey: "create-root",
        });
        await mutations.create(scope, {
            id: "menu-parent",
            parentId: "root",
            type: "menu",
            title: "Menu parent",
            path: "/menu-parent",
            name: "menu-parent",
            permission: { action: "read", resource: "ui:menu:menu-parent" },
        }, { actorId: "admin", idempotencyKey: "create-menu-parent" });
        const createdPage = await mutations.create(scope, { ...page("orders", "root"), icon: "shopping-cart" }, {
            actorId: "admin",
            idempotencyKey: "create-orders",
        });

        await expect(mutations.create(scope, { id: "root", type: "directory", title: "Duplicate" }, {
            actorId: "admin",
            idempotencyKey: "duplicate-root-id",
        })).rejects.toMatchObject({ code: "MENU_ALREADY_EXISTS" });
        await expect(mutations.create(scope, page("orphan", "missing"), {
            actorId: "admin",
            idempotencyKey: "missing-parent",
        })).rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        await expect(mutations.create(scope, {
            id: "directory-below-menu",
            parentId: "menu-parent",
            type: "directory",
            title: "Invalid directory",
        }, { actorId: "admin", idempotencyKey: "directory-below-menu" }))
            .rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        await expect(mutations.create(scope, {
            id: "menu-below-page",
            parentId: "orders",
            type: "menu",
            title: "Invalid menu",
            path: "/menu-below-page",
            name: "menu-below-page",
            permission: { action: "read", resource: "ui:menu:menu-below-page" },
        }, { actorId: "admin", idempotencyKey: "menu-below-page" }))
            .rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });

        await expect(mutations.update(scope, "orders", { title: "Stale" }, {
            actorId: "admin",
            idempotencyKey: "stale-update",
            expectedRevision: createdPage.data.revision - 1,
        })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
        const withoutIcon = await mutations.update(scope, "orders", { icon: null }, {
            actorId: "admin",
            idempotencyKey: "remove-icon",
            expectedRevision: createdPage.data.revision,
        });
        expect(withoutIcon).toMatchObject({ changed: true, data: { id: "orders", revision: 2 } });
        expect(withoutIcon.data).not.toHaveProperty("icon");

        const deprecatedPreview = await impacts.previewSetStatus(scope, "orders", "deprecated", { actorId: "admin" });
        if (!deprecatedPreview.executable) throw new Error("expected deprecation preview to be executable");
        const deprecated = await impacts.setStatus(scope, "orders", "deprecated", {
            ...deprecatedPreview.expected,
            previewToken: deprecatedPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "deprecate-orders",
        });
        await expect(mutations.update(scope, "orders", { title: "Cannot update" }, {
            actorId: "admin",
            idempotencyKey: "update-deprecated",
            expectedRevision: deprecated.data.revision,
        })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        const noOpPreview = await impacts.previewSetStatus(scope, "orders", "deprecated", { actorId: "admin" });
        if (!noOpPreview.executable) throw new Error("expected no-op status preview to be executable");
        await expect(impacts.setStatus(scope, "orders", "deprecated", {
            ...noOpPreview.expected,
            previewToken: noOpPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "deprecate-orders-noop",
        })).resolves.toMatchObject({ changed: false, data: { status: "deprecated", revision: deprecated.data.revision } });
    }, TEST_TIMEOUT);

    it("rolls back injected insert and update storage anomalies with stable public errors", async () => {
        const { repository, schemes } = repositoryFixture(context, "faults");
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-boundary-faults" });
        const mutations = new MenuNodeMutationService(repository, schemes);
        await mutations.create(scope, { id: "root", type: "directory", title: "Root" }, {
            actorId: "admin",
            idempotencyKey: "create-root",
        });
        const originalNodes = repository.collections.menuNodes;

        await expect(withMenuNodes(repository, {
            async count() {
                return -1;
            },
        }, () => mutations.create(scope, page("invalid-count", "root"), {
            actorId: "admin",
            idempotencyKey: "invalid-sibling-count",
        }))).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        await expect(withMenuNodes(repository, {
            async insertOne(...args) {
                const result = await originalNodes.insertOne(...args);
                return { ...result, acknowledged: false };
            },
        }, () => mutations.create(scope, page("unacknowledged", "root"), {
            actorId: "admin",
            idempotencyKey: "unacknowledged-insert",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        await expect(withMenuNodes(repository, {
            async insertOne() {
                throw Object.assign(new Error("E11000 pc_menu_nodes identity duplicate"), { code: 11_000 });
            },
        }, () => mutations.create(scope, page("duplicate-key", "root"), {
            actorId: "admin",
            idempotencyKey: "duplicate-key-insert",
        }))).rejects.toMatchObject({ code: "MENU_ALREADY_EXISTS" });

        await expect(withMenuNodes(repository, {
            async findOne(...args) {
                const row = await originalNodes.findOne(...args);
                const filter = args[0] as Readonly<Record<string, unknown>>;
                return filter.nodeId === "bad-post-image" && row !== null
                    ? { ...row, updatedAt: Number(row.updatedAt) + 1 }
                    : row;
            },
        }, () => mutations.create(scope, page("bad-post-image", "root"), {
            actorId: "admin",
            idempotencyKey: "bad-insert-post-image",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        const target = await mutations.create(scope, page("update-target", "root"), {
            actorId: "admin",
            idempotencyKey: "create-update-target",
        });
        await expect(withMenuNodes(repository, {
            async updateOne() {
                return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
            },
        }, () => mutations.update(scope, "update-target", { title: "Conflict" }, {
            actorId: "admin",
            idempotencyKey: "injected-update-conflict",
            expectedRevision: target.data.revision,
        }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

        await expect(withMenuNodes(repository, {
            async updateOne(...args) {
                const result = await originalNodes.updateOne(...args);
                return { ...result, modifiedCount: 0 };
            },
        }, () => mutations.update(scope, "update-target", { title: "No modification" }, {
            actorId: "admin",
            idempotencyKey: "injected-update-no-modification",
            expectedRevision: target.data.revision,
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        await expect(withMenuNodes(repository, {
            async updateOne() {
                throw Object.assign(new Error("E11000 pc_menu_nodes path duplicate"), { code: 11_000 });
            },
        }, () => mutations.update(scope, "update-target", { title: "Duplicate update" }, {
            actorId: "admin",
            idempotencyKey: "injected-update-duplicate",
            expectedRevision: target.data.revision,
        }))).rejects.toMatchObject({ code: "MENU_ALREADY_EXISTS" });

        let targetReads = 0;
        await expect(withMenuNodes(repository, {
            async findOne(...args) {
                const row = await originalNodes.findOne(...args);
                const filter = args[0] as Readonly<Record<string, unknown>>;
                if (filter.nodeId === "update-target" && row !== null) {
                    targetReads += 1;
                    if (targetReads > 1) return { ...row, updatedAt: Number(row.updatedAt) + 1 };
                }
                return row;
            },
        }, () => mutations.update(scope, "update-target", { title: "Expected title" }, {
            actorId: "admin",
            idempotencyKey: "bad-update-post-image",
            expectedRevision: target.data.revision,
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        expect(await repository.collections.menuNodes.count({
            scopeKey: (await repository.scopeStates.read(scope)).scopeKey,
            nodeId: { $in: ["invalid-count", "unacknowledged", "duplicate-key", "bad-post-image"] },
        }, { cache: 0 })).toBe(0);
        await expect(mutations.update(scope, "update-target", { title: "update-target" }, {
            actorId: "admin",
            idempotencyKey: "verify-update-target",
            expectedRevision: target.data.revision,
        })).resolves.toMatchObject({ changed: false, data: { title: "update-target", revision: target.data.revision } });
    }, TEST_TIMEOUT);

    it("validates move and reorder topology and commits exact no-op plans", async () => {
        const { repository, schemes } = repositoryFixture(context, "structure");
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-menu-boundary-structure" });
        const mutations = new MenuNodeMutationService(repository, schemes);
        const impacts = new MenuNodeImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 61), "menu-boundary-structure"),
        );

        for (const id of ["root-a", "root-b"] as const) {
            await mutations.create(scope, { id, type: "directory", title: id }, {
                actorId: "admin",
                idempotencyKey: `create-${id}`,
            });
        }
        await mutations.create(scope, {
            id: "menu-parent",
            parentId: "root-b",
            type: "menu",
            title: "Menu parent",
            path: "/menu-parent",
            name: "menu-parent",
            permission: { action: "read", resource: "ui:menu:menu-parent" },
        }, { actorId: "admin", idempotencyKey: "create-menu-parent" });
        await mutations.create(scope, { id: "branch", parentId: "root-a", type: "directory", title: "Branch" }, {
            actorId: "admin",
            idempotencyKey: "create-branch",
        });
        await mutations.create(scope, { id: "branch-child", parentId: "branch", type: "directory", title: "Branch child" }, {
            actorId: "admin",
            idempotencyKey: "create-branch-child",
        });
        await mutations.create(scope, page("orders", "root-a"), {
            actorId: "admin",
            idempotencyKey: "create-orders",
        });
        await mutations.create(scope, {
            id: "save",
            parentId: "orders",
            type: "button",
            title: "Save",
            code: "orders.save",
            permission: { action: "invoke", resource: "ui:button:orders.save" },
        }, { actorId: "admin", idempotencyKey: "create-save" });

        await expect(impacts.previewMove(scope, { nodeId: "missing", parentId: null }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "MENU_NOT_FOUND" });
        await expect(impacts.previewMove(scope, { nodeId: "orders", parentId: "missing" }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        await expect(impacts.previewMove(scope, { nodeId: "save", parentId: null }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        await expect(impacts.previewMove(scope, { nodeId: "root-a", parentId: "menu-parent" }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        await expect(impacts.previewMove(scope, { nodeId: "branch", parentId: "branch-child" }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        await expect(impacts.previewMove(scope, {
            nodeId: "orders",
            parentId: "root-b",
            beforeId: "missing-anchor",
        }, { actorId: "admin" })).rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });

        const noOpMoveInput = { nodeId: "orders", parentId: "root-a" } as const;
        const noOpMovePreview = await impacts.previewMove(scope, noOpMoveInput, { actorId: "admin" });
        if (!noOpMovePreview.executable) throw new Error("expected no-op move preview to be executable");
        await expect(impacts.move(scope, noOpMoveInput, {
            ...noOpMovePreview.expected,
            previewToken: noOpMovePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "move-orders-noop",
        })).resolves.toMatchObject({ changed: false, data: { id: "orders", parentId: "root-a" } });

        await expect(impacts.previewReorder(scope, { parentId: "missing", orderedNodeIds: [] }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "MENU_HIERARCHY_INVALID" });
        const noOpReorderInput = { parentId: "root-a", orderedNodeIds: ["branch", "orders"] } as const;
        const noOpReorderPreview = await impacts.previewReorder(scope, noOpReorderInput, { actorId: "admin" });
        if (!noOpReorderPreview.executable) throw new Error("expected no-op reorder preview to be executable");
        await expect(impacts.reorder(scope, noOpReorderInput, {
            ...noOpReorderPreview.expected,
            previewToken: noOpReorderPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "reorder-root-a-noop",
        })).resolves.toMatchObject({ changed: false, data: { unchanged: 2, updated: 0 } });

        const rootReorderInput = { parentId: null, orderedNodeIds: ["root-a", "root-b"] } as const;
        const rootReorderPreview = await impacts.previewReorder(scope, rootReorderInput, { actorId: "admin" });
        if (!rootReorderPreview.executable) throw new Error("expected root reorder preview to be executable");
        await expect(impacts.reorder(scope, rootReorderInput, {
            ...rootReorderPreview.expected,
            previewToken: rootReorderPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "reorder-roots-noop",
        })).resolves.toMatchObject({ changed: false, data: { unchanged: 2, updated: 0 } });

        const deprecatePreview = await impacts.previewSetStatus(scope, "orders", "deprecated", { actorId: "admin" });
        if (!deprecatePreview.executable) throw new Error("expected deprecation preview to be executable");
        await impacts.setStatus(scope, "orders", "deprecated", {
            ...deprecatePreview.expected,
            previewToken: deprecatePreview.previewToken,
            actorId: "admin",
            idempotencyKey: "deprecate-orders",
        });
        await expect(impacts.previewMove(scope, { nodeId: "orders", parentId: "root-b" }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }, TEST_TIMEOUT);

    it("fails API impact updates closed across no-op, duplicate, write, post-image, and deprecated paths", async () => {
        const { repository, schemes } = repositoryFixture(context, "api-impact");
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-api-impact-boundaries" });
        const mutations = new ApiBindingMutationService(repository, schemes);
        const impacts = new ApiBindingImpactMutationService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 71), "api-impact-boundaries"),
        );
        const created = await mutations.create(scope, {
            id: "orders-api",
            method: "GET",
            path: "/api/orders",
            purpose: "entry",
            authorization: {
                mode: "all",
                permissions: [{ action: "read", resource: "api:GET:/api/orders" }],
            },
        }, { actorId: "admin", idempotencyKey: "create-orders-api" });
        expect(created.data).toMatchObject({ id: "orders-api", revision: 1 });

        await expect(impacts.previewUpdate(scope, "missing", { patch: { purpose: "lookup" } }, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "API_BINDING_NOT_FOUND" });

        const noOpRequest = { patch: { purpose: "entry" as const } };
        const noOpPreview = await impacts.previewUpdate(scope, "orders-api", noOpRequest, { actorId: "admin" });
        if (!noOpPreview.executable) throw new Error("expected API no-op preview to be executable");
        await expect(impacts.executeUpdate(scope, "orders-api", noOpRequest, {
            ...noOpPreview.expected,
            previewToken: noOpPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-update-noop",
        })).resolves.toMatchObject({ changed: false, data: { id: "orders-api", revision: 1 } });

        const changedRequest = { patch: { description: "Lists orders" } };
        const preview = await impacts.previewUpdate(scope, "orders-api", changedRequest, { actorId: "admin" });
        if (!preview.executable) throw new Error("expected API update preview to be executable");
        const originalBindings = repository.collections.apiBindings;

        await expect(withApiBindings(repository, {
            async updateOne() {
                return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
            },
        }, () => impacts.executeUpdate(scope, "orders-api", changedRequest, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-update-conflict",
        }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

        await expect(withApiBindings(repository, {
            async updateOne(...args) {
                const result = await originalBindings.updateOne(...args);
                return { ...result, modifiedCount: 0 };
            },
        }, () => impacts.executeUpdate(scope, "orders-api", changedRequest, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-update-no-modification",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        await expect(withApiBindings(repository, {
            async updateOne() {
                throw Object.assign(new Error("E11000 pc_api_bindings endpoint duplicate"), { code: 11_000 });
            },
        }, () => impacts.executeUpdate(scope, "orders-api", changedRequest, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-update-duplicate",
        }))).rejects.toMatchObject({ code: "API_BINDING_ALREADY_EXISTS" });

        await expect(withApiBindings(repository, {
            async findOne(...args) {
                const row = await originalBindings.findOne(...args);
                const filter = args[0] as Readonly<Record<string, unknown>>;
                if (filter.bindingId === "orders-api" && row !== null) {
                    return { ...row, updatedAt: Number(row.updatedAt) + 1 };
                }
                return row;
            },
        }, () => impacts.executeUpdate(scope, "orders-api", changedRequest, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-update-post-image",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        const enabledPreview = await impacts.previewSetStatus(scope, "orders-api", "enabled", { actorId: "admin" });
        if (!enabledPreview.executable) throw new Error("expected API status no-op preview to be executable");
        await expect(impacts.setStatus(scope, "orders-api", "enabled", {
            ...enabledPreview.expected,
            previewToken: enabledPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-status-noop",
        })).resolves.toMatchObject({ changed: false, data: { status: "enabled", revision: 1 } });

        const deprecatedPreview = await impacts.previewSetStatus(scope, "orders-api", "deprecated", { actorId: "admin" });
        if (!deprecatedPreview.executable) throw new Error("expected API deprecation preview to be executable");
        const deprecated = await impacts.setStatus(scope, "orders-api", "deprecated", {
            ...deprecatedPreview.expected,
            previewToken: deprecatedPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "api-deprecate",
        });
        expect(deprecated.data).toMatchObject({ status: "deprecated", revision: 2 });
        await expect(impacts.previewUpdate(scope, "orders-api", changedRequest, { actorId: "admin" }))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }, TEST_TIMEOUT);
});
