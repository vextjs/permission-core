import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PermissionScope, StaleReference, StructuralStaleResolution } from "../../src/types";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import {
    StructuralStaleReferenceService,
    MenuReadStore,
    apiBindingDocumentFromInput,
    collectStructuralStaleReferences,
    menuNodeDocumentFromInput,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
} from "../../src/menu";
import { calculateReplaceManifestBytes } from "../../src/menu/aggregate";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../../src/persistence/documents";
import { PermissionRepository } from "../../src/persistence/repository";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 300_000;

function createRepository(
    context: RealMongoContext,
    prefix: string,
    schemes: ResourceSchemeRegistry,
) {
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

async function seedScope(
    repository: PermissionRepository,
    scope: Readonly<PermissionScope>,
    nodes: readonly Readonly<InternalMenuNodeDocument>[],
    bindings: readonly Readonly<InternalApiBindingDocument>[],
) {
    const scopeKey = createScopeKey(scope);
    const state = await repository.scopeStates.read(scope);
    const itemBytes = [...nodes, ...bindings]
        .reduce((total, document) => total + document.manifestItemBytes, 0);
    const replaceManifestBytes = calculateReplaceManifestBytes({
        menuNodeCount: nodes.length,
        apiBindingCount: bindings.length,
        itemBytes,
    });
    await repository.collections.scopeState.insertOne({
        scopeKey,
        scope,
        schemaVersion: 2,
        schemeContractDigest: state.schemeContractDigest,
        schemaContractKey: state.schemaContractKey,
        revision: 1,
        rbacRevision: 0,
        menuRevision: 1,
        auditRevision: 1,
        menuNodeCount: nodes.length,
        apiBindingCount: bindings.length,
        replaceManifestBytes,
        createdAt: 1,
        updatedAt: 1,
    }, { cache: { invalidate: false } });
    if (nodes.length > 0) {
        await repository.collections.menuNodes.insertMany(
            nodes.map((node) => ({ ...node })),
            { cache: { invalidate: false } },
        );
    }
    if (bindings.length > 0) {
        await repository.collections.apiBindings.insertMany(
            bindings.map((binding) => ({ ...binding })),
            { cache: { invalidate: false } },
        );
    }
}

function mixedFixture(
    schemes: ResourceSchemeRegistry,
    scope: Readonly<PermissionScope>,
) {
    const scopeKey = createScopeKey(scope);
    const node = (
        input: Parameters<typeof normalizeMenuNodeCreateInput>[0],
        order = 0,
    ) => menuNodeDocumentFromInput(
        scopeKey,
        scope,
        normalizeMenuNodeCreateInput(input, schemes),
        order,
        1,
        1,
    );
    const nodes = [
        node({ id: "root", type: "directory", title: "Root" }),
        node({
            id: "target-page",
            parentId: "root",
            type: "page",
            title: "Target",
            path: "/target",
            name: "target",
            component: "TargetPage",
            permission: { action: "read", resource: "ui:page:target" },
        }, 0),
        node({
            id: "wrong-button",
            parentId: "root",
            type: "button",
            title: "Wrong",
            code: "wrong.button",
            permission: { action: "read", resource: "ui:button:wrong.button" },
        }, 1),
        node({
            id: "owner-menu",
            parentId: "root",
            type: "menu",
            title: "Owner menu",
            path: "/owner-menu",
            name: "owner-menu",
            permission: { action: "read", resource: "ui:page:owner-menu" },
        }, 2),
        node({
            id: "owner-page",
            parentId: "root",
            type: "page",
            title: "Owner page",
            path: "/owner-page",
            name: "owner-page",
            component: "OwnerPage",
            permission: { action: "read", resource: "ui:page:owner-page" },
        }, 3),
        node({ id: "orphan", parentId: "missing-parent", type: "directory", title: "Orphan" }),
        node({ id: "cycle-a", parentId: "cycle-b", type: "directory", title: "Cycle A" }),
        node({ id: "cycle-b", parentId: "cycle-a", type: "directory", title: "Cycle B" }),
    ];
    const bindings = [apiBindingDocumentFromInput(
        scopeKey,
        scope,
        normalizeApiBindingCreateInput({
            id: "stale-api",
            method: "GET",
            path: "/orders",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/orders" }] },
            owners: [
                { type: "menu", id: "missing-owner", required: true },
                { type: "menu", id: "owner-menu", required: true },
                { type: "page", id: "owner-menu", required: true },
            ],
            canonicalOwner: { type: "page", id: "owner-menu" },
        }, schemes),
        1,
        1,
    )];
    return { nodes, bindings };
}

function compactionFixture(
    schemes: ResourceSchemeRegistry,
    scope: Readonly<PermissionScope>,
    siblingCount: number,
) {
    const scopeKey = createScopeKey(scope);
    const node = (
        input: Parameters<typeof normalizeMenuNodeCreateInput>[0],
        order = 0,
    ) => menuNodeDocumentFromInput(
        scopeKey,
        scope,
        normalizeMenuNodeCreateInput(input, schemes),
        order,
        1,
        1,
    );
    return [
        node({ id: "root", type: "directory", title: "Root" }),
        node({ id: "bad-parent", parentId: "root", type: "directory", title: "Bad parent" }, 0),
        node({
            id: "target-page",
            parentId: "root",
            type: "page",
            title: "Target",
            path: "/target",
            name: "target",
            component: "TargetPage",
            permission: { action: "read", resource: "ui:page:target" },
        }, 1),
        node({
            id: "stale-button",
            parentId: "bad-parent",
            type: "button",
            title: "Stale button",
            code: "stale.button",
            permission: { action: "read", resource: "ui:button:stale.button" },
        }, 0),
        ...Array.from({ length: siblingCount }, (_, index) => node({
            id: `sibling-${String(siblingCount - index - 1).padStart(4, "0")}`,
            parentId: "bad-parent",
            type: "directory",
            title: `Sibling ${index}`,
        }, index + 1)),
    ];
}

async function readAllStale(
    service: StructuralStaleReferenceService,
    scope: PermissionScope,
    first = 200,
) {
    const references: StaleReference[] = [];
    let after: string | undefined;
    while (true) {
        const page = await service.findStaleReferences(scope, {
            first,
            ...(after === undefined ? {} : { after }),
        });
        references.push(...page.items);
        if (!page.pageInfo.hasNext) break;
        after = page.pageInfo.endCursor!;
    }
    return references;
}

function mixedResolutions(references: readonly StaleReference[]) {
    const resolutions: Record<string, StructuralStaleResolution> = {};
    for (const reference of references) {
        if (reference.reason === "parent-missing") {
            resolutions[reference.id] = { action: "rebind", replacementId: "root" };
        } else if (reference.reason === "parent-type-mismatch") {
            resolutions[reference.id] = { action: "rebind", replacementId: "target-page" };
        } else if (reference.reason === "parent-cycle") {
            resolutions[reference.id] = { action: "remove" };
        } else if (reference.reason === "api-owner-missing") {
            resolutions[reference.id] = { action: "remove" };
        } else if (reference.reason === "api-owner-type-mismatch") {
            resolutions[reference.id] = { action: "rebind", replacementId: "owner-page" };
        } else {
            throw new Error(`unexpected stale reason ${reference.reason}`);
        }
    }
    return resolutions;
}

describe("v2 structural stale repair on MonSQLize 3.1", () => {
    let context: RealMongoContext;

    beforeAll(async () => {
        context = await startRealMongo();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    it("pages, repairs, and invalidates cursors without touching RBAC state", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(context, `pc_b4_stale_mixed_${randomUUID().replaceAll("-", "")}`, schemes);
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-stale-mixed" });
        const fixture = mixedFixture(schemes, scope);
        await seedScope(repository, scope, fixture.nodes, fixture.bindings);
        const service = new StructuralStaleReferenceService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 61), "menu-stale-mixed"),
        );

        const firstPage = await service.findStaleReferences(scope, { first: 2 });
        expect(firstPage).toMatchObject({
            items: [{ type: "api-owner" }, { type: "api-owner" }],
            pageInfo: { hasNext: true },
        });
        const references = await readAllStale(service, scope, 2);
        expect(references).toHaveLength(6);
        expect(references.map((reference) => reference.reason)).toEqual(expect.arrayContaining([
            "parent-missing",
            "parent-type-mismatch",
            "parent-cycle",
            "api-owner-missing",
            "api-owner-type-mismatch",
        ]));
        const input = {
            referenceIds: references.map((reference) => reference.id),
            resolutions: mixedResolutions(references),
        };
        const preview = await service.previewRepairStaleReferences(scope, input, { actorId: "admin" });
        expect(preview).toMatchObject({
            executable: true,
            plan: {
                operations: { total: 6, truncated: false },
                sourceImpacts: { total: 0, truncated: false },
            },
            summary: { updated: 6, conflicted: 0 },
            conflicts: { total: 0 },
        });
        if (!preview.executable) throw new Error("expected mixed structural repair to be executable");
        const stateBefore = await repository.scopeStates.read(scope);
        const repaired = await service.repairStaleReferences(scope, input, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "mixed-stale-repair",
        });
        expect(repaired).toMatchObject({ changed: true, data: { updated: 6, conflicted: 0 } });
        const replayed = await service.repairStaleReferences(scope, input, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "mixed-stale-repair",
        });
        expect(replayed).toMatchObject({
            replayed: true,
            operationId: repaired.operationId,
            auditId: repaired.auditId,
            revision: repaired.revision,
            revisions: repaired.revisions,
            data: repaired.data,
        });
        const stateAfter = await repository.scopeStates.read(scope);
        expect(stateAfter).toMatchObject({
            revision: stateBefore.revision + 1,
            rbacRevision: stateBefore.rbacRevision,
            menuRevision: stateBefore.menuRevision + 1,
            auditRevision: stateBefore.auditRevision + 2,
            menuNodeCount: stateBefore.menuNodeCount,
            apiBindingCount: stateBefore.apiBindingCount,
        });
        expect(await readAllStale(service, scope)).toEqual([]);
        await expect(service.findStaleReferences(scope, {
            first: 2,
            after: firstPage.pageInfo.endCursor!,
        })).rejects.toMatchObject({ code: "CURSOR_STALE" });
        const reader = await new MenuReadStore(repository, schemes).open(scope);
        expect(await reader.requireNode("orphan")).toMatchObject({ parentId: "root" });
        expect(await reader.requireNode("wrong-button")).toMatchObject({ parentId: "target-page", order: 0 });
        expect(await reader.requireBinding("stale-api")).toMatchObject({
            owners: expect.arrayContaining([
                expect.objectContaining({ type: "menu", id: "owner-menu" }),
                expect.objectContaining({ type: "page", id: "owner-page" }),
            ]),
            canonicalOwner: { type: "page", id: "owner-page" },
        });
        expect(await repository.collections.roleRules.count({ scopeKey: stateAfter.scopeKey }, { cache: 0 })).toBe(0);
        expect(await repository.collections.roleMenuGrants.count({ scopeKey: stateAfter.scopeKey }, { cache: 0 })).toBe(0);
    }, TEST_TIMEOUT);

    it("requires complete candidate-safe decisions at the exact 100/101 boundary", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(context, `pc_b4_stale_boundary_${randomUUID().replaceAll("-", "")}`, schemes);
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-stale-boundary" });
        const scopeKey = createScopeKey(scope);
        const nodes = Array.from({ length: 101 }, (_, index) => menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput({
                id: `orphan-${String(index).padStart(3, "0")}`,
                parentId: "missing-parent",
                type: "directory",
                title: `Orphan ${index}`,
            }, schemes),
            index,
            1,
            1,
        ));
        await seedScope(repository, scope, nodes, []);
        const service = new StructuralStaleReferenceService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 62), "menu-stale-boundary"),
        );
        const references = await readAllStale(service, scope);
        expect(references).toHaveLength(101);
        const allInput = {
            referenceIds: references.map((reference) => reference.id),
            resolutions: Object.fromEntries(references.map((reference) => [reference.id, { action: "remove" as const }])),
        };
        const over = await service.previewRepairStaleReferences(scope, allInput, { actorId: "admin" });
        expect(over).toMatchObject({
            executable: false,
            previewToken: null,
            expected: null,
            plan: { operations: { total: 101, truncated: true } },
            conflicts: { items: [{ code: "LIMIT_EXCEEDED" }] },
        });

        const selected = references.slice(0, 100);
        const exactInput = {
            referenceIds: selected.map((reference) => reference.id),
            resolutions: Object.fromEntries(selected.map((reference) => [reference.id, { action: "remove" as const }])),
        };
        const exact = await service.previewRepairStaleReferences(scope, exactInput, { actorId: "admin" });
        expect(exact).toMatchObject({
            executable: true,
            plan: { operations: { total: 100, truncated: false } },
            summary: { updated: 100, conflicted: 0 },
        });
        if (!exact.executable) throw new Error("expected exact decision boundary to be executable");
        await service.repairStaleReferences(scope, exactInput, {
            ...exact.expected,
            previewToken: exact.previewToken,
            actorId: "admin",
        });
        expect(await readAllStale(service, scope)).toHaveLength(1);
    }, TEST_TIMEOUT);

    it("previews one selected repair across a maximum-size corrupt ancestry chain", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(context, `pc_b4_stale_depth_${randomUUID().replaceAll("-", "")}`, schemes);
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-stale-depth-preview" });
        const scopeKey = createScopeKey(scope);
        const nodes = Array.from({ length: 10_000 }, (_, index) => menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput({
                id: `deep-${String(index).padStart(5, "0")}`,
                ...(index === 0 ? {} : { parentId: `deep-${String(index - 1).padStart(5, "0")}` }),
                type: "directory",
                title: `Deep ${index}`,
            }, schemes),
            0,
            1,
            1,
        ));
        const references = collectStructuralStaleReferences({ nodes, bindings: [] });
        const selected = references.find((record) => record.reference.assetId === "deep-09999");
        const subtreeRoot = references.find((record) => record.reference.assetId === "deep-00064");
        if (selected === undefined) throw new Error("expected the terminal depth reference");
        if (subtreeRoot === undefined) throw new Error("expected the first over-depth reference");
        await seedScope(repository, scope, nodes, []);
        const service = new StructuralStaleReferenceService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 66), "menu-stale-depth-preview"),
        );
        const input = {
            referenceIds: [selected.reference.id],
            resolutions: { [selected.reference.id]: { action: "remove" as const } },
        };

        const preview = await service.previewRepairStaleReferences(scope, input, { actorId: "admin" });

        expect(preview).toMatchObject({
            executable: true,
            plan: { operations: { total: 1, truncated: false } },
            summary: { updated: 1, conflicted: 0 },
            conflicts: { total: 0 },
        });
        const subtreePreview = await service.previewRepairStaleReferences(scope, {
            referenceIds: [subtreeRoot.reference.id],
            resolutions: { [subtreeRoot.reference.id]: { action: "remove" } },
        }, { actorId: "admin" });
        expect(subtreePreview).toMatchObject({
            executable: false,
            previewToken: null,
            conflicts: { items: [{ code: "STALE_REPLACEMENT_INVALID" }] },
        });
    }, TEST_TIMEOUT);

    it("preserves sibling order at the exact 1000-write boundary and blocks 1001 writes", async () => {
        for (const boundary of [
            { siblingCount: 998, executable: true },
            { siblingCount: 999, executable: false },
        ] as const) {
            const schemes = new ResourceSchemeRegistry();
            const repository = createRepository(
                context,
                `pc_b4_stale_compact_${boundary.siblingCount}_${randomUUID().replaceAll("-", "")}`,
                schemes,
            );
            await repository.ensureIndexes();
            const scope = normalizeScope({ tenantId: `tenant-stale-compact-${boundary.siblingCount}` });
            const nodes = compactionFixture(schemes, scope, boundary.siblingCount);
            await seedScope(repository, scope, nodes, []);
            const service = new StructuralStaleReferenceService(
                repository,
                schemes,
                new SignedTokenCodec(Buffer.alloc(32, 65), `menu-stale-compact-${boundary.siblingCount}`),
            );
            const references = await readAllStale(service, scope);
            expect(references).toHaveLength(1);
            const input = {
                referenceIds: [references[0]!.id],
                resolutions: {
                    [references[0]!.id]: { action: "rebind" as const, replacementId: "target-page" },
                },
            };
            const preview = await service.previewRepairStaleReferences(scope, input, { actorId: "admin" });
            expect(preview.executable).toBe(boundary.executable);
            if (!boundary.executable) {
                expect(preview).toMatchObject({
                    previewToken: null,
                    expected: null,
                    conflicts: { items: [{ code: "LIMIT_EXCEEDED" }] },
                });
                const reader = await new MenuReadStore(repository, schemes).open(scope);
                expect(await reader.requireNode("stale-button")).toMatchObject({ parentId: "bad-parent", order: 0, revision: 1 });
                continue;
            }
            if (!preview.executable) throw new Error("expected exact physical-write boundary to be executable");
            const result = await service.repairStaleReferences(scope, input, {
                ...preview.expected,
                previewToken: preview.previewToken,
                actorId: "admin",
            });
            expect(result).toMatchObject({ changed: true, data: { updated: 1, conflicted: 0 } });
            const reader = await new MenuReadStore(repository, schemes).open(scope);
            expect(await reader.requireNode("stale-button")).toMatchObject({ parentId: "target-page", order: 0, revision: 2 });
            const siblings = (await reader.readAllNodes())
                .filter((node) => node.parentId === "bad-parent")
                .sort((left, right) => left.order - right.order)
                .map((node) => node.nodeId);
            expect(siblings).toEqual(Array.from(
                { length: boundary.siblingCount },
                (_, index) => `sibling-${String(boundary.siblingCount - index - 1).padStart(4, "0")}`,
            ));
        }
    }, TEST_TIMEOUT);

    it("rechecks cross-binding owner availability groups before accepting a rebind", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(context, `pc_b4_stale_groups_${randomUUID().replaceAll("-", "")}`, schemes);
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-stale-groups" });
        const scopeKey = createScopeKey(scope);
        const node = (
            input: Parameters<typeof normalizeMenuNodeCreateInput>[0],
            order = 0,
        ) => menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput(input, schemes),
            order,
            1,
            1,
        );
        const nodes = [
            node({ id: "root", type: "directory", title: "Root" }),
            node({
                id: "actual-menu",
                parentId: "root",
                type: "menu",
                title: "Actual",
                path: "/actual",
                name: "actual",
                permission: { action: "read", resource: "ui:page:actual" },
            }, 0),
            node({
                id: "target-menu",
                parentId: "root",
                type: "menu",
                title: "Target",
                path: "/target-menu",
                name: "target-menu",
                permission: { action: "read", resource: "ui:page:target-menu" },
            }, 1),
        ];
        const binding = (
            id: string,
            path: string,
            owner: Parameters<typeof normalizeApiBindingCreateInput>[0]["owners"],
            canonicalOwner?: Parameters<typeof normalizeApiBindingCreateInput>[0]["canonicalOwner"],
        ) => apiBindingDocumentFromInput(
            scopeKey,
            scope,
            normalizeApiBindingCreateInput({
                id,
                method: "GET",
                path,
                purpose: "entry",
                authorization: { mode: "all", permissions: [{ action: "read", resource: `api:GET:${path}` }] },
                owners: owner,
                ...(canonicalOwner === undefined ? {} : { canonicalOwner }),
            }, schemes),
            1,
            1,
        );
        const bindings = [
            binding(
                "stale-group-api",
                "/group-stale",
                [{
                    type: "menu",
                    id: "missing-menu",
                    required: true,
                    availabilityGroup: "navigation",
                    availabilityMode: "any",
                }],
                { type: "menu", id: "missing-menu" },
            ),
            binding("valid-group-api", "/group-valid", [{
                type: "menu",
                id: "target-menu",
                required: true,
                availabilityGroup: "navigation",
                availabilityMode: "all",
            }]),
        ];
        await seedScope(repository, scope, nodes, bindings);
        const service = new StructuralStaleReferenceService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 64), "menu-stale-groups"),
        );
        const [reference] = await readAllStale(service, scope);
        const conflictingInput = {
            referenceIds: [reference!.id],
            resolutions: { [reference!.id]: { action: "rebind" as const, replacementId: "target-menu" } },
        };
        const conflict = await service.previewRepairStaleReferences(scope, conflictingInput, { actorId: "admin" });
        expect(conflict).toMatchObject({
            executable: false,
            conflicts: { items: [{ code: "STALE_REPLACEMENT_INVALID" }] },
        });

        const validInput = {
            referenceIds: [reference!.id],
            resolutions: { [reference!.id]: { action: "rebind" as const, replacementId: "actual-menu" } },
        };
        const preview = await service.previewRepairStaleReferences(scope, validInput, { actorId: "admin" });
        if (!preview.executable) throw new Error("expected non-conflicting availability group rebind to be executable");
        await service.repairStaleReferences(scope, validInput, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
        });
        expect(await readAllStale(service, scope)).toEqual([]);
        const reader = await new MenuReadStore(repository, schemes).open(scope);
        expect(await reader.requireBinding("stale-group-api")).toMatchObject({
            owners: [expect.objectContaining({ id: "actual-menu", availabilityMode: "any" })],
            canonicalOwner: { type: "menu", id: "actual-menu" },
        });
    }, TEST_TIMEOUT);

    it("rejects arbitrary replacements and rolls mixed writes back on a late API failure", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(context, `pc_b4_stale_rollback_${randomUUID().replaceAll("-", "")}`, schemes);
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-stale-rollback" });
        const fixture = mixedFixture(schemes, scope);
        await seedScope(repository, scope, fixture.nodes, fixture.bindings);
        const service = new StructuralStaleReferenceService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 63), "menu-stale-rollback"),
        );
        const references = await readAllStale(service, scope);
        const orphan = references.find((reference) => reference.reason === "parent-missing")!;
        const missingOwner = references.find((reference) => reference.reason === "api-owner-missing")!;
        const invalidInput = {
            referenceIds: [orphan.id, missingOwner.id],
            resolutions: {
                [orphan.id]: { action: "rebind" as const, replacementId: "wrong-button" },
                [missingOwner.id]: { action: "rebind" as const, replacementId: "owner-menu" },
            },
        };
        const invalid = await service.previewRepairStaleReferences(scope, invalidInput, { actorId: "admin" });
        expect(invalid).toMatchObject({
            executable: false,
            previewToken: null,
            conflicts: { total: 2 },
        });
        const cycleInput = {
            referenceIds: [orphan.id],
            resolutions: { [orphan.id]: { action: "rebind" as const, replacementId: "cycle-a" } },
        };
        const cycle = await service.previewRepairStaleReferences(scope, cycleInput, { actorId: "admin" });
        expect(cycle).toMatchObject({
            executable: false,
            previewToken: null,
            conflicts: { items: [{ code: "STALE_REPLACEMENT_INVALID" }] },
        });

        const input = {
            referenceIds: [orphan.id, missingOwner.id],
            resolutions: {
                [orphan.id]: { action: "rebind" as const, replacementId: "root" },
                [missingOwner.id]: { action: "remove" as const },
            },
        };
        const preview = await service.previewRepairStaleReferences(scope, input, { actorId: "admin" });
        if (!preview.executable) throw new Error("expected rollback fixture to be executable");
        const stateBefore = await repository.scopeStates.read(scope);
        const originalCollections = repository.collections;
        let failNextBindingUpdate = true;
        const failingApiBindings = Object.freeze({
            ...originalCollections.apiBindings,
            async updateOne(...args: Parameters<typeof originalCollections.apiBindings.updateOne>) {
                if (failNextBindingUpdate) {
                    failNextBindingUpdate = false;
                    throw new Error("injected structural stale API failure");
                }
                return originalCollections.apiBindings.updateOne(...args);
            },
        });
        Object.defineProperty(repository, "collections", {
            value: Object.freeze({ ...originalCollections, apiBindings: failingApiBindings }),
            writable: true,
            configurable: true,
        });
        try {
            await expect(service.repairStaleReferences(scope, input, {
                ...preview.expected,
                previewToken: preview.previewToken,
                actorId: "admin",
                idempotencyKey: "stale-rollback",
            })).rejects.toBeDefined();
        } finally {
            Object.defineProperty(repository, "collections", {
                value: originalCollections,
                writable: true,
                configurable: true,
            });
        }
        expect(await repository.scopeStates.read(scope)).toMatchObject({
            revision: stateBefore.revision,
            rbacRevision: stateBefore.rbacRevision,
            menuRevision: stateBefore.menuRevision,
            auditRevision: stateBefore.auditRevision,
            replaceManifestBytes: stateBefore.replaceManifestBytes,
        });
        const readerAfterFailure = await new MenuReadStore(repository, schemes).open(scope);
        expect(await readerAfterFailure.requireNode("orphan")).toMatchObject({ parentId: "missing-parent", revision: 1 });
        expect(await readerAfterFailure.requireBinding("stale-api")).toMatchObject({
            owners: expect.arrayContaining([expect.objectContaining({ type: "menu", id: "missing-owner" })]),
            revision: 1,
        });

        const retried = await service.repairStaleReferences(scope, input, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "stale-rollback",
        });
        expect(retried).toMatchObject({ changed: true, data: { updated: 2, conflicted: 0 } });
        expect(await readAllStale(service, scope)).toHaveLength(4);
    }, TEST_TIMEOUT);
});
