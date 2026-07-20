import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "monsqlize";
import { PermissionCore } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import {
    CANONICAL_CONTRACT_VERSION,
    digestCanonical,
} from "../../src/internal/canonical";
import {
    INTERNAL_COLLECTION_SUFFIXES,
    PERSISTED_SCHEMA_VERSION,
    type InternalRevisionVector,
    type InternalScopeRevisionVector,
} from "../../src/persistence/documents";
import {
    INTERNAL_INDEX_CATALOG,
    SIMPLE_COLLATION,
    verifyIndexDefinitions,
} from "../../src/persistence/indexes";
import { PermissionRepository } from "../../src/persistence/repository";
import type { ScopeStateView } from "../../src/persistence/scope-state";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;
let prefixSequence = 0;

function nextPrefix(label: string) {
    prefixSequence += 1;
    return `pc_b2_${label}_${prefixSequence}`;
}

function createContract() {
    const schemes = new ResourceSchemeRegistry();
    const schemeContractDigest = schemes.schemeContractDigest;
    return {
        schemeContractDigest,
        schemaContractKey: digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest,
        }),
    };
}

function revisionVector(state: ScopeStateView): InternalScopeRevisionVector {
    return {
        global: state.revision,
        rbac: state.rbacRevision,
        menu: state.menuRevision,
        audit: state.auditRevision,
    };
}

function auditRevisionVector(
    state: ScopeStateView,
    entities: InternalRevisionVector["entities"] = [],
): InternalRevisionVector {
    return { ...revisionVector(state), entities };
}

async function performRoleMutation(
    repository: PermissionRepository,
    scope: { tenantId: string },
    roleId: string,
    now: number,
    transaction: Transaction,
    actorId = "admin",
    idempotencyKey = `key-${roleId}`,
) {
    const state = await repository.scopeStates.ensureForMutation(scope, transaction.session, now);
    const before = revisionVector(state);
    await repository.collections.roles.insertOne({
        scopeKey: state.scopeKey,
        scope: state.scope,
        roleId,
        label: roleId,
        status: "enabled",
        parentId: null,
        revision: 1,
        menuGrantCount: 0,
        menuGrantDigest: digestCanonical([]),
        menuSourceCount: 0,
        menuSourceDigest: digestCanonical([]),
        createdAt: now,
        updatedAt: now,
    }, {
        session: transaction.session,
        cache: { invalidate: false },
    });
    const postState = await repository.scopeStates.advance(
        scope,
        before,
        { global: 1, rbac: 1, menu: 0, audit: 1 },
        {},
        transaction.session,
        now,
    );
    await repository.audits.append({
        auditId: `audit-${roleId}`,
        operationId: `operation-${roleId}`,
        scope,
        actorId,
        operation: "roles.create",
        action: "create",
        resource: `role:${roleId}`,
        idempotencyKey,
        idempotencyRequestHash: digestCanonical({ roleId }),
        change: { kind: "entity", after: { roleId } },
        revisionsBefore: {
            ...before,
            entities: [{ kind: "role", id: roleId, revision: 0 }],
        },
        revisionsAfter: auditRevisionVector(postState, [{ kind: "role", id: roleId, revision: 1 }]),
        changed: true,
        cacheTargets: [`scope:${state.scopeKey}:rbac`],
        replayResult: { changed: true, roleId },
        cacheOutcome: "pending",
        now,
    }, transaction.session);
    return postState;
}

function expectIndexedPlan(plan: unknown, indexName: string) {
    const serialized = JSON.stringify(plan);
    expect(serialized).toContain(indexName);
    expect(serialized).not.toContain('"stage":"COLLSCAN"');
    expect(serialized).not.toContain('"stage":"SORT"');
}

describe("MonSQLize 3.1 persistence integration", () => {
    let context: RealMongoContext;

    beforeAll(async () => {
        context = await startRealMongo();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    it("creates and verifies every named index and keeps the host connection owned by the host", async () => {
        const prefix = nextPrefix("indexes");
        const core = new PermissionCore({ monsqlize: context.monsqlize, collectionPrefix: prefix });
        const peer = new PermissionCore({ monsqlize: context.monsqlize, collectionPrefix: prefix });
        const [health, peerHealth] = await Promise.all([core.init(), peer.init()]);

        expect(health.status).toBe("up");
        expect(peerHealth.status).toBe("up");
        expect(peerHealth.coreNamespaceHash).toBe(health.coreNamespaceHash);
        for (const [key, suffix] of Object.entries(INTERNAL_COLLECTION_SUFFIXES)) {
            const collectionName = `${prefix}${suffix}`;
            const indexes = await context.monsqlize.collection(collectionName).listIndexes();
            verifyIndexDefinitions(
                collectionName,
                INTERNAL_INDEX_CATALOG[key as keyof typeof INTERNAL_INDEX_CATALOG],
                indexes,
            );
        }
        expect((await core.init()).lifecycle).toBe("ready");
        await Promise.all([core.close(), peer.close()]);
        await expect(context.monsqlize.health()).resolves.toMatchObject({ status: "up", connected: true });
    }, TEST_TIMEOUT);

    it("fails fast on a same-name heterogeneous production index", async () => {
        const prefix = nextPrefix("conflict");
        await context.monsqlize.collection(`${prefix}_roles`).createIndexes([{
            name: "pc_roles_scope_role_uq",
            key: { scopeKey: 1, wrongRoleId: 1 },
            unique: true,
            collation: SIMPLE_COLLATION,
        }]);
        const core = new PermissionCore({ monsqlize: context.monsqlize, collectionPrefix: prefix });

        await expect(core.init()).rejects.toMatchObject({
            code: "INDEX_CONFLICT",
            details: { kind: "database-failure", stage: "index" },
        });
        await core.close();
    }, TEST_TIMEOUT);

    it("fails closed on raw version, contract, and unexpected scope-state fields", async () => {
        const prefix = nextPrefix("scope-contract");
        const contract = createContract();
        const repository = new PermissionRepository(context.monsqlize, prefix, contract);
        await repository.ensureIndexes();
        const foreignSchemeContractDigest = digestCanonical("foreign-scheme-contract");
        const foreignSchemaContractKey = digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest: foreignSchemeContractDigest,
        });

        const cases = [
            {
                scope: { tenantId: "legacy-schema-2" },
                patch: { schemaVersion: 2 },
                code: "SCHEMA_VERSION_MISMATCH",
            },
            {
                scope: { tenantId: "wrong-contract" },
                patch: { schemaContractKey: "A" },
                code: "SCHEMA_CONTRACT_MISMATCH",
            },
            {
                scope: { tenantId: "different-valid-contract" },
                patch: {
                    schemeContractDigest: foreignSchemeContractDigest,
                    schemaContractKey: foreignSchemaContractKey,
                },
                code: "SCHEMA_CONTRACT_MISMATCH",
            },
            {
                scope: { tenantId: "unexpected-field" },
                patch: { foreignWriterField: true },
                code: "PERSISTED_STATE_INVALID",
            },
            {
                scope: { tenantId: "invalid-revision-vector" },
                patch: { revision: 0, rbacRevision: 1 },
                code: "PERSISTED_STATE_INVALID",
            },
            {
                scope: { tenantId: "invalid-manifest-aggregate" },
                patch: { replaceManifestBytes: 1 },
                code: "PERSISTED_STATE_INVALID",
            },
        ] as const;
        for (const item of cases) {
            const virtual = await repository.scopeStates.read(item.scope);
            await repository.collections.scopeState.insertOne({
                scopeKey: virtual.scopeKey,
                scope: virtual.scope,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest: contract.schemeContractDigest,
                schemaContractKey: contract.schemaContractKey,
                revision: 0,
                rbacRevision: 0,
                menuRevision: 0,
                auditRevision: 0,
                menuConfigCount: 0,
                menuConfigBytes: 0,
                menuNodeCount: 0,
                apiBindingCount: 0,
                responseFieldCount: 0,
                responseFieldOwnerCount: 0,
                replaceManifestBytes: virtual.replaceManifestBytes,
                createdAt: 1,
                updatedAt: 1,
                ...item.patch,
            });
            await expect(repository.scopeStates.read(item.scope)).rejects.toMatchObject({ code: item.code });
        }
    }, TEST_TIMEOUT);

    it("keeps virgin reads write-free and rolls back scope, role, revisions, and audit together", async () => {
        const prefix = nextPrefix("atomic");
        const repository = new PermissionRepository(context.monsqlize, prefix, createContract());
        await repository.ensureIndexes();
        const scope = { tenantId: "tenant-atomic" };
        const now = await repository.getDatabaseTime();

        const virgin = await repository.scopeStates.read(scope);
        expect(virgin).toMatchObject({ persisted: false, revision: 0, auditRevision: 0 });
        expect(await repository.collections.scopeState.count({}, { cache: 0 })).toBe(0);

        await expect(repository.withTransaction(async (transaction) => {
            await performRoleMutation(repository, scope, "rolled-back", now, transaction);
            throw new Error("force rollback");
        })).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
        expect(await repository.collections.scopeState.count({}, { cache: 0 })).toBe(0);
        expect(await repository.collections.roles.count({}, { cache: 0 })).toBe(0);
        expect(await repository.collections.auditEntries.count({}, { cache: 0 })).toBe(0);

        const committed = await repository.withTransaction((transaction) => (
            performRoleMutation(repository, scope, "committed", now + 1, transaction)
        ));
        expect(committed).toMatchObject({ revision: 1, rbacRevision: 1, auditRevision: 1 });
        const beforeOperationalUpdate = await repository.audits.getByOperationId(scope, "operation-committed");

        await repository.withTransaction(async (transaction) => {
            const state = await repository.scopeStates.read(scope, transaction.session);
            const updated = await repository.audits.recordCacheOutcome(
                scope,
                "operation-committed",
                "pending",
                "completed",
                now + 2,
                transaction.session,
            );
            expect(updated?.operationalState.cacheOutcome).toBe("completed");
            await repository.scopeStates.advance(
                scope,
                revisionVector(state),
                { global: 0, rbac: 0, menu: 0, audit: 1 },
                {},
                transaction.session,
                now + 2,
            );
        });

        const afterOperationalUpdate = await repository.audits.getByOperationId(scope, "operation-committed");
        expect(afterOperationalUpdate.evidenceDigest).toBe(beforeOperationalUpdate.evidenceDigest);
        expect(afterOperationalUpdate.operationalState.cacheOutcome).toBe("completed");
        expect(await repository.scopeStates.read(scope)).toMatchObject({
            revision: 1,
            rbacRevision: 1,
            auditRevision: 2,
        });

        await repository.withTransaction(async (transaction) => {
            const state = await repository.scopeStates.read(scope, transaction.session);
            const postState = await repository.scopeStates.advance(
                scope,
                revisionVector(state),
                { global: 0, rbac: 0, menu: 0, audit: 1 },
                {},
                transaction.session,
                now + 3,
            );
            await repository.audits.append({
                auditId: "audit-committed-noop",
                operationId: "operation-committed-noop",
                scope,
                actorId: "admin",
                operation: "roles.update",
                action: "update",
                idempotencyRequestHash: digestCanonical({ roleId: "committed", label: "committed" }),
                change: { kind: "entity", before: { roleId: "committed" }, after: { roleId: "committed" } },
                revisionsBefore: auditRevisionVector(state, [{ kind: "role", id: "committed", revision: 1 }]),
                revisionsAfter: auditRevisionVector(postState, [{ kind: "role", id: "committed", revision: 1 }]),
                changed: false,
                cacheTargets: [],
                replayResult: { changed: false, roleId: "committed" },
                cacheOutcome: "not-needed",
                now: now + 3,
            }, transaction.session);
        });
        expect(await repository.scopeStates.read(scope)).toMatchObject({
            revision: 1,
            rbacRevision: 1,
            auditRevision: 3,
        });
        expect(await repository.audits.getByOperationId(scope, "operation-committed-noop")).toMatchObject({
            changed: false,
            operationalState: { cacheOutcome: "not-needed" },
            revisionsBefore: { global: 1, rbac: 1, audit: 2 },
            revisionsAfter: { global: 1, rbac: 1, audit: 3 },
        });

        await repository.collections.auditEntries.updateOne(
            { operationId: "operation-committed" },
            { $set: { actorId: "tampered" } },
        );
        await expect(repository.audits.getByOperationId(scope, "operation-committed")).rejects.toMatchObject({
            code: "PERSISTED_STATE_INVALID",
        });
    }, TEST_TIMEOUT);

    it("serializes concurrent first writes and enforces actor-bound replay plus claim ownership", async () => {
        const prefix = nextPrefix("concurrency");
        const repository = new PermissionRepository(context.monsqlize, prefix, createContract());
        await repository.ensureIndexes();
        const scope = { tenantId: "tenant-concurrent" };
        const now = await repository.getDatabaseTime();

        const settled = await Promise.allSettled(["reader-a", "reader-b"].map((roleId) => (
            repository.withTransaction((transaction) => (
                performRoleMutation(repository, scope, roleId, now, transaction)
            ))
        )));
        const fulfilled = settled.filter((result) => result.status === "fulfilled");
        const rejected = settled.filter((result) => result.status === "rejected");
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
        for (const result of rejected) {
            expect(result.reason).toMatchObject({ code: "REVISION_CONFLICT" });
        }
        const finalState = await repository.scopeStates.read(scope);
        expect(finalState.revision).toBe(fulfilled.length);
        expect(await repository.collections.scopeState.count({}, { cache: 0 })).toBe(1);
        expect(await repository.collections.roles.count({}, { cache: 0 })).toBe(fulfilled.length);
        expect(await repository.collections.auditEntries.count({}, { cache: 0 })).toBe(fulfilled.length);

        const firstRoleId = settled.findIndex((result) => result.status === "fulfilled") === 0 ? "reader-a" : "reader-b";
        const restartedRepository = new PermissionRepository(context.monsqlize, prefix, createContract());
        const first = await restartedRepository.audits.findIdempotentReplay(
            scope,
            "admin",
            "roles.create",
            `key-${firstRoleId}`,
            digestCanonical({ roleId: firstRoleId }),
        );
        expect(first?.operationId).toBe(`operation-${firstRoleId}`);
        await expect(restartedRepository.audits.findIdempotentReplay(
            scope,
            "admin",
            "roles.create",
            `key-${firstRoleId}`,
            digestCanonical({ roleId: "different" }),
        )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        expect(await restartedRepository.audits.findIdempotentReplay(
            scope,
            "another-actor",
            "roles.create",
            `key-${firstRoleId}`,
            digestCanonical({ roleId: firstRoleId }),
        )).toBeNull();

        const evidenceBeforeClaim = (await repository.audits.getByOperationId(scope, `operation-${firstRoleId}`)).evidenceDigest;
        const claim = await repository.withTransaction(async (transaction) => {
            const state = await repository.scopeStates.read(scope, transaction.session);
            const claimed = await repository.audits.claimCacheOutcome(
                scope,
                `operation-${firstRoleId}`,
                "reconcile-1",
                now + 10,
                now + 60_000,
                transaction.session,
            );
            if (claimed) {
                await repository.scopeStates.advance(
                    scope,
                    revisionVector(state),
                    { global: 0, rbac: 0, menu: 0, audit: 1 },
                    {},
                    transaction.session,
                    now + 10,
                );
            }
            return claimed;
        });
        expect(claim?.operationalState.cacheReconcileClaim?.operationId).toBe("reconcile-1");
        await expect(repository.withTransaction((transaction) => repository.audits.claimCacheOutcome(
            scope,
            `operation-${firstRoleId}`,
            "reconcile-2",
            now + 11,
            now + 60_001,
            transaction.session,
        ))).resolves.toBeNull();
        await expect(repository.withTransaction((transaction) => repository.audits.completeClaim(
            scope,
            `operation-${firstRoleId}`,
            "wrong-owner",
            "completed",
            now + 12,
            transaction.session,
        ))).resolves.toBeNull();

        await repository.withTransaction(async (transaction) => {
            const state = await repository.scopeStates.read(scope, transaction.session);
            const completed = await repository.audits.completeClaim(
                scope,
                `operation-${firstRoleId}`,
                "reconcile-1",
                "completed",
                now + 13,
                transaction.session,
            );
            expect(completed?.operationalState.cacheOutcome).toBe("completed");
            await repository.scopeStates.advance(
                scope,
                revisionVector(state),
                { global: 0, rbac: 0, menu: 0, audit: 1 },
                {},
                transaction.session,
                now + 13,
            );
        });
        const completed = await repository.audits.getByOperationId(scope, `operation-${firstRoleId}`);
        expect(completed.evidenceDigest).toBe(evidenceBeforeClaim);
        expect(completed.operationalState).toMatchObject({ cacheOutcome: "completed" });
        expect(completed.operationalState.cacheReconcileClaim).toBeUndefined();
    }, TEST_TIMEOUT);

    it("keeps reconcile audits out of the pending queue and preserves immutable evidence", async () => {
        const prefix = nextPrefix("reconcile-state");
        const repository = new PermissionRepository(context.monsqlize, prefix, createContract());
        await repository.ensureIndexes();
        const scope = { tenantId: "tenant-reconcile" };
        const now = await repository.getDatabaseTime();

        await repository.withTransaction((transaction) => (
            performRoleMutation(repository, scope, "reader", now, transaction)
        ));
        const initialRaw = await repository.collections.auditEntries.findOne({ operationId: "operation-reader" });
        expect(initialRaw?.reconcileAvailableAt).toBe(0);
        expect((await repository.audits.listAvailablePending(scope, now, 10)).map((entry) => entry.operationId))
            .toEqual(["operation-reader"]);

        const reconcile = await repository.withTransaction(async (transaction) => {
            const state = await repository.scopeStates.read(scope, transaction.session);
            const claimed = await repository.audits.claimCacheOutcome(
                scope,
                "operation-reader",
                "reconcile-operation-1",
                now + 1,
                now + 60_000,
                transaction.session,
            );
            expect(claimed?.operationalState.cacheReconcileClaim?.operationId).toBe("reconcile-operation-1");
            const postState = await repository.scopeStates.advance(
                scope,
                revisionVector(state),
                { global: 0, rbac: 0, menu: 0, audit: 1 },
                {},
                transaction.session,
                now + 1,
            );
            return repository.audits.append({
                auditId: "reconcile-audit-1",
                operationId: "reconcile-operation-1",
                scope,
                actorId: "admin",
                operation: "audit.reconcileCacheOutcomes",
                action: "reconcile",
                idempotencyKey: "reconcile-key-1",
                idempotencyRequestHash: digestCanonical({ operationIds: ["operation-reader"] }),
                validatedPlanHash: digestCanonical({ operationIds: ["operation-reader"], targets: 1 }),
                change: { kind: "reconcile-plan", operationIds: ["operation-reader"] },
                revisionsBefore: auditRevisionVector(state),
                revisionsAfter: auditRevisionVector(postState),
                changed: true,
                cacheTargets: [`scope:${state.scopeKey}:rbac`],
                replayResult: { state: "claimed" },
                cacheOutcome: "not-needed",
                now: now + 1,
            }, transaction.session);
        });

        expect(reconcile.operationalState.cacheOutcome).toBe("not-needed");
        expect(reconcile.reconcileAvailableAt).toBeUndefined();
        expect(await repository.collections.auditEntries.count({
            "operationalState.cacheOutcome": "pending",
        }, { cache: 0 })).toBe(1);
        expect(await repository.audits.listAvailablePending(scope, now + 2, 10)).toEqual([]);

        const reconcileEvidence = reconcile.evidenceDigest;
        await repository.withTransaction(async (transaction) => {
            const state = await repository.scopeStates.read(scope, transaction.session);
            const completed = await repository.audits.completeClaim(
                scope,
                "operation-reader",
                "reconcile-operation-1",
                "completed",
                now + 3,
                transaction.session,
            );
            expect(completed?.operationalState.cacheOutcome).toBe("completed");
            const recorded = await repository.audits.recordReconcileOperation(
                scope,
                "reconcile-operation-1",
                { state: "completed", result: { selected: 1, completed: 1 } },
                now + 3,
                transaction.session,
            );
            expect(recorded?.operationalState.reconcileOperation).toMatchObject({ state: "completed" });
            await repository.scopeStates.advance(
                scope,
                revisionVector(state),
                { global: 0, rbac: 0, menu: 0, audit: 1 },
                {},
                transaction.session,
                now + 3,
            );
        });

        const completedReconcile = await repository.audits.getByOperationId(scope, "reconcile-operation-1");
        expect(completedReconcile.evidenceDigest).toBe(reconcileEvidence);
        expect(completedReconcile.operationalState).toMatchObject({
            cacheOutcome: "not-needed",
            reconcileOperation: { state: "completed", result: { selected: 1, completed: 1 } },
        });
        expect(await repository.collections.auditEntries.count({
            "operationalState.cacheOutcome": "pending",
        }, { cache: 0 })).toBe(0);
        expect(await repository.scopeStates.read(scope)).toMatchObject({
            revision: 1,
            rbacRevision: 1,
            auditRevision: 3,
        });

        await repository.collections.auditEntries.updateOne({
            operationId: "reconcile-operation-1",
        }, {
            $set: {
                "operationalState.cacheOutcome": "pending",
                reconcileAvailableAt: 0,
            },
        });
        await expect(repository.audits.getByOperationId(scope, "reconcile-operation-1")).rejects.toMatchObject({
            code: "PERSISTED_STATE_INVALID",
        });
    }, TEST_TIMEOUT);

    it("reports DB-truth bounded health counts at the 1000/1001 boundary", async () => {
        const prefix = nextPrefix("health");
        const core = new PermissionCore({ monsqlize: context.monsqlize, collectionPrefix: prefix });
        await core.init();
        const scopeStates = context.monsqlize.collection(`${prefix}_scope_state`);
        const audits = context.monsqlize.collection(`${prefix}_audit_entries`);

        await scopeStates.insertMany([
            { scopeKey: "raw-missing" },
            { scopeKey: "raw-null", schemaContractKey: null },
            { scopeKey: "raw-object", schemaContractKey: { malformed: true } },
            { scopeKey: "raw-array", schemaContractKey: [1, 2] },
        ]);
        expect((await core.health()).schema.indexedContractMismatchScopes).toEqual({
            value: 0,
            cap: 1000,
            truncated: false,
        });

        const mismatchRows = Array.from({ length: 1001 }, (_, index) => ({
            scopeKey: `mismatch-${index.toString().padStart(4, "0")}`,
            schemaContractKey: "A",
        }));
        const pendingRows = Array.from({ length: 1001 }, (_, index) => ({
            scopeKey: "health-scope",
            auditId: `health-audit-${index.toString().padStart(4, "0")}`,
            operationId: `health-operation-${index.toString().padStart(4, "0")}`,
            createdAt: index,
            operationalState: { cacheOutcome: "pending" },
        }));
        await scopeStates.insertMany(mismatchRows.slice(0, 1000));
        await audits.insertMany(pendingRows.slice(0, 1000));
        expect(await core.health()).toMatchObject({
            status: "degraded",
            schema: {
                indexedContractMismatchScopes: { value: 1000, cap: 1000, truncated: false },
            },
            audit: {
                pendingCacheOutcomes: { value: 1000, cap: 1000, truncated: false },
            },
        });
        await scopeStates.insertOne(mismatchRows[1000]);
        await audits.insertOne(pendingRows[1000]);

        const health = await core.health();
        expect(health).toMatchObject({
            status: "degraded",
            schema: {
                indexedContractMismatchScopes: { value: 1000, cap: 1000, truncated: true },
                lastMismatchReason: "scheme-contract",
            },
            audit: {
                pendingCacheOutcomes: { value: 1000, cap: 1000, truncated: true },
            },
        });
        expect(health.schema.lastMismatchScopeHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        await core.close();
    }, TEST_TIMEOUT);

    it("uses the declared health, reconcile, and seven audit-query indexes without COLLSCAN or blocking SORT", async () => {
        const prefix = nextPrefix("explain");
        const repository = new PermissionRepository(context.monsqlize, prefix, createContract());
        await repository.ensureIndexes();
        const audits = repository.collections.auditEntries;
        const scopeStates = repository.collections.scopeState;
        const scopeKey = "explain-scope";
        const actorId = "admin";
        const operation = "roles.create";
        const action = "create";
        const resourceHash = digestCanonical("role:reader");
        const requestIdHash = digestCanonical("request-1");
        const to = Date.now();
        const from = to - 31 * DAY_MS;
        const rows = Array.from({ length: 1200 }, (_, index) => ({
            scopeKey,
            auditId: `audit-${index.toString().padStart(5, "0")}`,
            operationId: `operation-${index.toString().padStart(5, "0")}`,
            actorId,
            operation,
            action,
            resourceHash,
            requestIdHash,
            createdAt: from + Math.floor(((to - from) * index) / 1199),
            reconcileAvailableAt: from,
            operationalState: { cacheOutcome: "pending" },
        }));
        for (let index = 0; index < rows.length; index += 400) {
            await audits.insertMany(rows.slice(index, index + 400));
        }
        await scopeStates.insertMany(Array.from({ length: 10 }, (_, index) => ({
            scopeKey: `bad-contract-${index}`,
            schemaContractKey: "A",
        })));

        const timeRange = { $gte: from, $lte: to };
        const queryPlans = [
            ["pc_audit_scope_created", { scopeKey, createdAt: timeRange }],
            ["pc_audit_scope_actor_created", { scopeKey, actorId, createdAt: timeRange }],
            ["pc_audit_scope_operation_created", { scopeKey, operation, createdAt: timeRange }],
            ["pc_audit_scope_action_created", { scopeKey, action, createdAt: timeRange }],
            ["pc_audit_scope_resource_created", { scopeKey, resourceHash, createdAt: timeRange }],
            ["pc_audit_scope_request_created", { scopeKey, requestIdHash, createdAt: timeRange }],
            ["pc_audit_scope_outcome_created", {
                scopeKey,
                "operationalState.cacheOutcome": "pending",
                createdAt: timeRange,
            }],
        ] as const;
        for (const [indexName, query] of queryPlans) {
            const plan = await audits.explain(query, {
                sort: { createdAt: -1, auditId: -1 },
                limit: 100,
                hint: indexName,
                collation: SIMPLE_COLLATION,
                verbosity: "executionStats",
            });
            expectIndexedPlan(plan, indexName);
        }

        expectIndexedPlan(await audits.explain({
            scopeKey,
            "operationalState.cacheOutcome": "pending",
            reconcileAvailableAt: { $lte: to },
        }, {
            sort: { reconcileAvailableAt: 1, createdAt: 1, auditId: 1 },
            limit: 100,
            hint: "pc_audit_reconcile_queue",
            collation: SIMPLE_COLLATION,
            verbosity: "executionStats",
        }), "pc_audit_reconcile_queue");

        expectIndexedPlan(await audits.explain({
            "operationalState.cacheOutcome": "pending",
        }, {
            limit: 1001,
            hint: "pc_audit_health_outcome",
            collation: SIMPLE_COLLATION,
            verbosity: "executionStats",
        }), "pc_audit_health_outcome");

        expectIndexedPlan(await scopeStates.explain({
            $and: [
                { schemaContractKey: { $type: "string" } },
                {
                    $or: [
                        { schemaContractKey: { $lt: createContract().schemaContractKey } },
                        { schemaContractKey: { $gt: createContract().schemaContractKey } },
                    ],
                },
            ],
        }, {
            limit: 1001,
            hint: "pc_scope_state_contract_scope",
            collation: SIMPLE_COLLATION,
            verbosity: "executionStats",
        }), "pc_scope_state_contract_scope");
    }, TEST_TIMEOUT);
});
