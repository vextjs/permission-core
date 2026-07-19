import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
    MenuManifestExportRecord,
    MenuManifestInput,
    PermissionScope,
} from "../../src/types";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import {
    CANONICAL_CONTRACT_VERSION,
    canonicalByteLength,
    digestCanonical,
} from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import {
    ApiBindingMutationService,
    MenuManifestService,
    MenuNodeMutationService,
    MenuReadStore,
    apiBindingDocumentFromInput,
    menuNodeDocumentFromInput,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
} from "../../src/menu";
import { calculateReplaceManifestBytes } from "../../src/menu/aggregate";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../../src/persistence/documents";
import { SIMPLE_COLLATION } from "../../src/persistence/indexes";
import type { InternalPermissionCollection } from "../../src/persistence/native-collection";
import { PermissionRepository } from "../../src/persistence/repository";
import {
    EMPTY_REPLACE_MANIFEST_BYTES,
    MAX_API_BINDING_COUNT,
    MAX_MENU_NODE_COUNT,
    MAX_REPLACE_MANIFEST_BYTES,
} from "../../src/persistence/scope-state";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 300_000;

function createRepository(
    context: RealMongoContext,
    prefix: string,
    schemes: ResourceSchemeRegistry,
    findMaxLimit?: number,
) {
    const schemeContractDigest = schemes.schemeContractDigest;
    return new PermissionRepository(context.monsqlize, prefix, {
        schemeContractDigest,
        schemaContractKey: digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: 2,
            schemeContractDigest,
        }),
    }, findMaxLimit);
}

async function insertInChunks(
    collection: InternalPermissionCollection,
    documents: readonly unknown[],
) {
    for (let offset = 0; offset < documents.length; offset += 500) {
        const chunk = documents.slice(offset, offset + 500)
            .map((document) => ({ ...(document as Record<string, unknown>) }));
        const result = await collection.insertMany(chunk, { cache: { invalidate: false } });
        expect(result.insertedCount).toBe(chunk.length);
    }
}

async function seedScope(
    repository: PermissionRepository,
    scope: Readonly<PermissionScope>,
    input: {
        nodes: readonly Readonly<InternalMenuNodeDocument>[];
        bindings: readonly Readonly<InternalApiBindingDocument>[];
        revision?: number;
    },
) {
    const scopeKey = createScopeKey(scope);
    const revision = input.revision ?? 1;
    const itemBytes = [...input.nodes, ...input.bindings]
        .reduce((total, document) => total + document.manifestItemBytes, 0);
    const virtualState = await repository.scopeStates.read(scope);
    const replaceManifestBytes = calculateReplaceManifestBytes({
        menuNodeCount: input.nodes.length,
        apiBindingCount: input.bindings.length,
        itemBytes,
    });
    await repository.collections.scopeState.insertOne({
        scopeKey,
        scope,
        schemaVersion: 2,
        schemeContractDigest: virtualState.schemeContractDigest,
        schemaContractKey: virtualState.schemaContractKey,
        revision,
        rbacRevision: 0,
        menuRevision: revision,
        auditRevision: revision,
        menuNodeCount: input.nodes.length,
        apiBindingCount: input.bindings.length,
        replaceManifestBytes,
        createdAt: 1,
        updatedAt: 1,
    }, { cache: { invalidate: false } });
    await insertInChunks(repository.collections.menuNodes, input.nodes);
    await insertInChunks(repository.collections.apiBindings, input.bindings);
    return { scopeKey, replaceManifestBytes };
}

async function readAllManifestRecords(
    service: MenuManifestService,
    scope: PermissionScope,
    first = 200,
) {
    const records: MenuManifestExportRecord[] = [];
    let after: string | undefined;
    while (true) {
        const page = await service.exportPage(scope, {
            first,
            ...(after === undefined ? {} : { after }),
        });
        expect(page.items.length).toBeLessThanOrEqual(first);
        records.push(...page.items);
        if (!page.pageInfo.hasNext) break;
        expect(page.pageInfo.endCursor).not.toBeNull();
        after = page.pageInfo.endCursor!;
    }
    return records;
}

describe("v2 menu aggregate invariants on MonSQLize 3.1", () => {
    let context: RealMongoContext;

    beforeAll(async () => {
        context = await startRealMongo();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    it("accepts exact 10k/20k inventories, rejects one-over, and round-trips 30k records by keyset page", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_aggregate_counts_${randomUUID().replaceAll("-", "")}`,
            schemes,
            199,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-aggregate-counts" });
        const scopeKey = createScopeKey(scope);
        const nodes: InternalMenuNodeDocument[] = [];
        for (let rootIndex = 0; rootIndex < 10; rootIndex += 1) {
            const rootId = `root-${String(rootIndex).padStart(2, "0")}`;
            nodes.push(menuNodeDocumentFromInput(
                scopeKey,
                scope,
                normalizeMenuNodeCreateInput({ id: rootId, type: "directory", title: rootId }, schemes),
                rootIndex,
                1,
                1,
            ));
            const childCount = rootIndex === 0 ? 998 : 999;
            for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
                const childId = `child-${String(rootIndex).padStart(2, "0")}-${String(childIndex).padStart(3, "0")}`;
                nodes.push(menuNodeDocumentFromInput(
                    scopeKey,
                    scope,
                    normalizeMenuNodeCreateInput({
                        id: childId,
                        parentId: rootId,
                        type: "directory",
                        title: childId,
                    }, schemes),
                    childIndex,
                    1,
                    1,
                ));
            }
        }
        expect(nodes).toHaveLength(MAX_MENU_NODE_COUNT - 1);

        const bindings = Array.from({ length: MAX_API_BINDING_COUNT - 1 }, (_, index) => {
            const suffix = String(index).padStart(5, "0");
            const path = `/aggregate/${suffix}`;
            return apiBindingDocumentFromInput(
                scopeKey,
                scope,
                normalizeApiBindingCreateInput({
                    id: `binding-${suffix}`,
                    method: "GET",
                    path,
                    purpose: "lookup",
                    authorization: {
                        mode: "all",
                        permissions: [{ action: "read", resource: `api:GET:${path}` }],
                    },
                }, schemes),
                1,
                1,
            );
        });
        const seeded = await seedScope(repository, scope, { nodes, bindings });
        expect(seeded.replaceManifestBytes).toBeLessThan(MAX_REPLACE_MANIFEST_BYTES);

        const menuMutations = new MenuNodeMutationService(repository, schemes);
        const apiMutations = new ApiBindingMutationService(repository, schemes);
        await menuMutations.create(scope, {
            id: "child-00-final",
            parentId: "root-00",
            type: "directory",
            title: "Final child",
        }, { actorId: "admin", idempotencyKey: "aggregate-final-node" });
        await expect(menuMutations.create(scope, {
            id: "child-00-one-over",
            parentId: "root-00",
            type: "directory",
            title: "One over child",
        }, { actorId: "admin", idempotencyKey: "aggregate-one-over-node" })).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: { limitName: "menuNodeCount", current: MAX_MENU_NODE_COUNT + 1 },
        });

        const finalPath = "/aggregate/final";
        await apiMutations.create(scope, {
            id: "binding-final",
            method: "GET",
            path: finalPath,
            purpose: "lookup",
            authorization: {
                mode: "all",
                permissions: [{ action: "read", resource: `api:GET:${finalPath}` }],
            },
        }, { actorId: "admin", idempotencyKey: "aggregate-final-binding" });
        await expect(apiMutations.create(scope, {
            id: "binding-one-over",
            method: "GET",
            path: "/aggregate/one-over",
            purpose: "lookup",
            authorization: {
                mode: "all",
                permissions: [{ action: "read", resource: "api:GET:/aggregate/one-over" }],
            },
        }, { actorId: "admin", idempotencyKey: "aggregate-one-over-binding" })).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: { limitName: "apiBindingCount", current: MAX_API_BINDING_COUNT + 1 },
        });

        const state = await repository.scopeStates.read(scope);
        expect(state).toMatchObject({
            menuNodeCount: MAX_MENU_NODE_COUNT,
            apiBindingCount: MAX_API_BINDING_COUNT,
        });
        expect(await repository.collections.menuNodes.count({ scopeKey }, { cache: 0, collation: SIMPLE_COLLATION }))
            .toBe(MAX_MENU_NODE_COUNT);
        expect(await repository.collections.apiBindings.count({ scopeKey }, { cache: 0, collation: SIMPLE_COLLATION }))
            .toBe(MAX_API_BINDING_COUNT);

        const manifest = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 57), "aggregate-counts"),
        );
        const records = await readAllManifestRecords(manifest, scope);
        expect(records).toHaveLength(MAX_MENU_NODE_COUNT + MAX_API_BINDING_COUNT);
        expect(records.slice(0, MAX_API_BINDING_COUNT).every((record) => record.kind === "api-binding")).toBe(true);
        expect(records.slice(MAX_API_BINDING_COUNT).every((record) => record.kind === "node")).toBe(true);
        const input = {
            schemaVersion: 2,
            mode: "replace",
            nodes: records.flatMap((record) => record.kind === "node" ? [record.value] : []),
            apiBindings: records.flatMap((record) => record.kind === "api-binding" ? [record.value] : []),
        } satisfies MenuManifestInput;
        const preview = await manifest.preview(scope, input, { actorId: "admin" });
        expect(preview).toMatchObject({
            executable: true,
            summary: {
                inserted: 0,
                updated: 0,
                deleted: 0,
                unchanged: MAX_MENU_NODE_COUNT + MAX_API_BINDING_COUNT,
                conflicted: 0,
            },
        });
    }, TEST_TIMEOUT);

    it("round-trips an exact 12 MiB manifest while full export remains capped at 8 MiB", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_aggregate_bytes_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-aggregate-bytes" });
        const scopeKey = createScopeKey(scope);
        const fixedNodes = Array.from({ length: 382 }, (_, index) => {
            const id = `large-${String(index).padStart(3, "0")}`;
            return menuNodeDocumentFromInput(
                scopeKey,
                scope,
                normalizeMenuNodeCreateInput({
                    id,
                    type: "directory",
                    title: id,
                    meta: { padding: "x".repeat(32_740) },
                }, schemes),
                index,
                1,
                1,
            );
        });
        const targetId = "large-target";
        const targetBase = menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput({
                id: targetId,
                type: "directory",
                title: targetId,
                meta: { padding: "" },
            }, schemes),
            fixedNodes.length,
            1,
            1,
        );
        const fixedBytes = fixedNodes.reduce((total, document) => total + document.manifestItemBytes, 0);
        const nodeCount = fixedNodes.length + 1;
        const targetItemBytes = MAX_REPLACE_MANIFEST_BYTES
            - EMPTY_REPLACE_MANIFEST_BYTES
            - (nodeCount - 1)
            - fixedBytes
            - 1;
        const targetPaddingLength = targetItemBytes - targetBase.manifestItemBytes;
        expect(targetPaddingLength).toBeGreaterThan(0);
        expect(targetPaddingLength).toBeLessThan(32_750);
        const targetPadding = "x".repeat(targetPaddingLength);
        const target = menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput({
                id: targetId,
                type: "directory",
                title: targetId,
                meta: { padding: targetPadding },
            }, schemes),
            fixedNodes.length,
            1,
            1,
        );
        expect(target.manifestItemBytes).toBe(targetItemBytes);
        const seeded = await seedScope(repository, scope, { nodes: [...fixedNodes, target], bindings: [] });
        expect(seeded.replaceManifestBytes).toBe(MAX_REPLACE_MANIFEST_BYTES - 1);

        const mutations = new MenuNodeMutationService(repository, schemes);
        await mutations.update(scope, targetId, { meta: { padding: `${targetPadding}x` } }, {
            actorId: "admin",
            idempotencyKey: "aggregate-exact-bytes",
            expectedRevision: 1,
        });
        const exactState = await repository.scopeStates.read(scope);
        expect(exactState.replaceManifestBytes).toBe(MAX_REPLACE_MANIFEST_BYTES);
        const auditCount = await repository.collections.auditEntries.count(
            { scopeKey },
            { cache: 0, collation: SIMPLE_COLLATION },
        );
        await expect(mutations.update(scope, targetId, { meta: { padding: `${targetPadding}xx` } }, {
            actorId: "admin",
            idempotencyKey: "aggregate-one-over-byte",
            expectedRevision: 2,
        })).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: {
                limitName: "replaceManifestBytes",
                current: MAX_REPLACE_MANIFEST_BYTES + 1,
            },
        });
        expect((await repository.scopeStates.read(scope)).replaceManifestBytes).toBe(MAX_REPLACE_MANIFEST_BYTES);
        expect(await repository.collections.auditEntries.count(
            { scopeKey },
            { cache: 0, collation: SIMPLE_COLLATION },
        )).toBe(auditCount);

        const manifest = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 61), "aggregate-bytes"),
        );
        await expect(manifest.export(scope)).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: { limitName: "public-response-bytes" },
        });
        const records = await readAllManifestRecords(manifest, scope, 50);
        const input = {
            schemaVersion: 2,
            mode: "replace",
            nodes: records.flatMap((record) => record.kind === "node" ? [record.value] : []),
            apiBindings: [],
        } satisfies MenuManifestInput;
        expect(canonicalByteLength(input)).toBe(MAX_REPLACE_MANIFEST_BYTES);
        const preview = await manifest.preview(scope, input, { actorId: "admin" });
        expect(preview).toMatchObject({
            executable: true,
            summary: { inserted: 0, updated: 0, deleted: 0, unchanged: nodeCount, conflicted: 0 },
        });
    }, TEST_TIMEOUT);

    it("detects a corrupted aggregate byte counter when paged reconstruction reaches its terminal page", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_aggregate_corrupt_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-aggregate-corrupt" });
        const scopeKey = createScopeKey(scope);
        const nodes = ["corrupt-a", "corrupt-b"].map((id, order) => menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput({ id, type: "directory", title: id }, schemes),
            order,
            1,
            1,
        ));
        await seedScope(repository, scope, { nodes, bindings: [] });
        await repository.collections.scopeState.updateOne(
            { scopeKey },
            { $inc: { replaceManifestBytes: 1 } },
            { cache: { invalidate: false }, collation: SIMPLE_COLLATION },
        );
        const manifest = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 63), "aggregate-corrupt"),
        );
        const first = await manifest.exportPage(scope, { first: 1 });
        expect(first.pageInfo).toMatchObject({ hasNext: true });
        await expect(manifest.exportPage(scope, { first: 1, after: first.pageInfo.endCursor! }))
            .rejects.toMatchObject({
                code: "PERSISTED_STATE_INVALID",
                details: { reason: "scope replaceManifestBytes does not match the paged manifest inventory" },
            });
    }, TEST_TIMEOUT);

    it("allows at most one initial aggregate CAS to commit and preserves counters across a concurrent retry", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b4_aggregate_concurrent_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-aggregate-concurrent" });
        const scopeKey = createScopeKey(scope);
        await repository.collections.scopeState.insertOne({
            scopeKey,
            scope,
            schemaVersion: 2,
            schemeContractDigest: schemes.schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: 2,
                schemeContractDigest: schemes.schemeContractDigest,
            }),
            revision: 0,
            rbacRevision: 0,
            menuRevision: 0,
            auditRevision: 0,
            menuNodeCount: 0,
            apiBindingCount: 0,
            replaceManifestBytes: EMPTY_REPLACE_MANIFEST_BYTES,
            createdAt: 1,
            updatedAt: 1,
        }, { cache: { invalidate: false } });

        const originalRead = repository.scopeStates.read.bind(repository.scopeStates);
        let initialReads = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        repository.scopeStates.read = (async (...args: Parameters<typeof originalRead>) => {
            const value = await originalRead(...args);
            if (args[1] !== undefined && value.menuRevision === 0 && initialReads < 2) {
                initialReads += 1;
                if (initialReads === 2) release();
                await gate;
            }
            return value;
        }) as typeof repository.scopeStates.read;

        const originalAdvance = repository.scopeStates.advance.bind(repository.scopeStates);
        const attempts: Array<{
            expected: Parameters<typeof originalAdvance>[1];
            expectedAggregate: Parameters<typeof originalAdvance>[6];
            committed?: boolean;
        }> = [];
        repository.scopeStates.advance = (async (...args: Parameters<typeof originalAdvance>) => {
            const attempt = {
                expected: args[1],
                expectedAggregate: args[6],
                committed: undefined as boolean | undefined,
            };
            attempts.push(attempt);
            try {
                const result = await originalAdvance(...args);
                attempt.committed = true;
                return result;
            } catch (error) {
                attempt.committed = false;
                throw error;
            }
        }) as typeof repository.scopeStates.advance;

        const service = new MenuNodeMutationService(repository, schemes);
        const results = await Promise.allSettled([
            service.create(scope, { id: "concurrent-a", type: "directory", title: "A" }, {
                actorId: "admin",
                idempotencyKey: "aggregate-concurrent-a",
            }),
            service.create(scope, { id: "concurrent-b", type: "directory", title: "B" }, {
                actorId: "admin",
                idempotencyKey: "aggregate-concurrent-b",
            }),
        ]);
        expect(initialReads).toBe(2);
        expect(results.some((result) => result.status === "fulfilled")).toBe(true);
        for (const result of results) {
            if (result.status === "rejected") {
                expect(result.reason).toMatchObject({ code: expect.stringMatching(/^(?:REVISION_CONFLICT|TRANSACTION_FAILED)$/u) });
            }
        }
        const initialAttempts = attempts.filter((attempt) =>
            attempt.expected.global === 0
            && attempt.expected.menu === 0
            && attempt.expectedAggregate?.menuNodeCount === 0
            && attempt.expectedAggregate.apiBindingCount === 0
            && attempt.expectedAggregate.replaceManifestBytes === EMPTY_REPLACE_MANIFEST_BYTES);
        expect(initialAttempts.length).toBeGreaterThanOrEqual(2);
        expect(initialAttempts.filter((attempt) => attempt.committed)).toHaveLength(1);

        const inventory = await (await new MenuReadStore(repository, schemes).open(scope)).readCompleteInventory();
        const finalState = await repository.scopeStates.read(scope);
        expect(inventory.nodes.length).toBeGreaterThanOrEqual(1);
        expect(inventory.nodes.length).toBeLessThanOrEqual(2);
        expect(finalState.menuNodeCount).toBe(inventory.nodes.length);
        expect(finalState.replaceManifestBytes).toBe(calculateReplaceManifestBytes({
            menuNodeCount: inventory.nodes.length,
            apiBindingCount: 0,
            itemBytes: inventory.nodes.reduce((total, document) => total + document.manifestItemBytes, 0),
        }));
    }, TEST_TIMEOUT);
});
