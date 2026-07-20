import { describe, expect, it, vi } from "vitest";
import { PermissionCore, PermissionCoreError } from "../../src";
import { bsonDocumentByteLengthUpperBound } from "../../src/internal/bson-size";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import {
    INTERNAL_BSON_GENERATED_ID_BYTES,
    MAX_AUDIT_CHANGE_BYTES,
    MAX_INTERNAL_DOCUMENT_BYTES,
    PERSISTED_SCHEMA_VERSION,
    assertCanonicalBudget,
    assertInternalDocumentBudget,
} from "../../src/persistence/documents";
import {
    INTERNAL_INDEX_CATALOG,
    verifyIndexDefinitions,
} from "../../src/persistence/indexes";
import { PermissionRepository } from "../../src/persistence/repository";
import {
    EMPTY_REPLACE_MANIFEST_BYTES,
    MAX_MENU_NODE_COUNT,
} from "../../src/persistence/scope-state";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";
import { createMonSQLizeStub } from "./helpers/monsqlize-stub";

describe("private persistence contract", () => {
    it("freezes the complete named simple-collation index catalog", () => {
        const specs = Object.values(INTERNAL_INDEX_CATALOG).flat();
        expect(specs).toHaveLength(42);
        expect(new Set(specs.map((spec) => spec.name)).size).toBe(specs.length);
        expect(specs.every((spec) => Object.isFrozen(spec) && spec.collation.locale === "simple")).toBe(true);
        expect(INTERNAL_INDEX_CATALOG.menuConfigs).toHaveLength(4);
        expect(INTERNAL_INDEX_CATALOG.auditEntries).toHaveLength(12);
    });

    it.each([
        ["key", { name: "target", key: { other: 1 }, collation: { locale: "simple" } }],
        ["unique", { name: "target", key: { scopeKey: 1 }, unique: false, collation: { locale: "simple" } }],
        ["partial", {
            name: "target",
            key: { scopeKey: 1 },
            unique: true,
            partialFilterExpression: { scopeKey: { $type: "number" } },
            collation: { locale: "simple" },
        }],
        ["collation", {
            name: "target",
            key: { scopeKey: 1 },
            unique: true,
            partialFilterExpression: { scopeKey: { $type: "string" } },
            collation: { locale: "en" },
        }],
        ["sparse", {
            name: "target",
            key: { scopeKey: 1 },
            unique: true,
            partialFilterExpression: { scopeKey: { $type: "string" } },
            collation: { locale: "simple" },
            sparse: true,
        }],
        ["ttl", {
            name: "target",
            key: { scopeKey: 1 },
            unique: true,
            partialFilterExpression: { scopeKey: { $type: "string" } },
            collation: { locale: "simple" },
            expireAfterSeconds: 3600,
        }],
        ["hidden", {
            name: "target",
            key: { scopeKey: 1 },
            unique: true,
            partialFilterExpression: { scopeKey: { $type: "string" } },
            collation: { locale: "simple" },
            hidden: true,
        }],
    ])("rejects a same-name %s mismatch", (_case, actual) => {
        const expected = [{
            name: "target",
            key: { scopeKey: 1 } as const,
            unique: true as const,
            partialFilterExpression: { scopeKey: { $type: "string" } },
            collation: { locale: "simple" } as const,
        }];
        expect(() => verifyIndexDefinitions("collection", expected, [actual])).toThrow(expect.objectContaining({
            code: "INDEX_CONFLICT",
            details: { kind: "database-failure", stage: "index" },
        }));
    });

    it("accepts omitted MongoDB collation metadata as effective simple collation", () => {
        const expected = [{
            name: "target",
            key: { scopeKey: 1 } as const,
            unique: true as const,
            collation: { locale: "simple" } as const,
        }];
        expect(() => verifyIndexDefinitions("collection", expected, [{
            name: "target",
            key: { scopeKey: 1 },
            unique: true,
        }])).not.toThrow();
    });

    it("maps canonical one-over to stable byte-limit details", () => {
        expect(() => assertCanonicalBudget("abcd", "tiny", 5)).toThrow(expect.objectContaining({
            code: "LIMIT_EXCEEDED",
            details: {
                kind: "limit-exceeded",
                origin: "persisted-authorization-state",
                limitName: "tiny",
                current: 6,
                max: 5,
                unit: "bytes",
            },
        }));
    });

    it("enforces the 12 MiB BSON boundary including the generated ObjectId", () => {
        expect(bsonDocumentByteLengthUpperBound({ payload: "x" })).toBe(20);
        expect(bsonDocumentByteLengthUpperBound({ value: 1 })).toBe(16);
        expect(bsonDocumentByteLengthUpperBound({ value: 1.5 })).toBe(20);
        const exactPayload = "x".repeat(
            MAX_INTERNAL_DOCUMENT_BYTES - INTERNAL_BSON_GENERATED_ID_BYTES - 19,
        );

        expect(() => assertInternalDocumentBudget({ payload: exactPayload })).not.toThrow();
        expect(() => assertInternalDocumentBudget({ payload: `${exactPayload}x` })).toThrow(expect.objectContaining({
            code: "LIMIT_EXCEEDED",
            details: {
                kind: "limit-exceeded",
                origin: "persisted-authorization-state",
                limitName: "internal-document-bson",
                current: MAX_INTERNAL_DOCUMENT_BYTES + 1,
                max: MAX_INTERNAL_DOCUMENT_BYTES,
                unit: "bytes",
            },
        }));
        expect(() => assertInternalDocumentBudget({ "bad\u0000key": true })).toThrow(expect.objectContaining({
            code: "PERSISTED_STATE_INVALID",
            details: expect.objectContaining({
                kind: "persisted-state-invalid",
                stage: "post-image",
                reason: expect.stringContaining("NUL"),
            }),
        }));
    }, 30_000);

    it("fails fast when snapshot transactions are unavailable", async () => {
        const stub = createMonSQLizeStub();
        stub.spies.withTransaction.mockRejectedValueOnce(Object.assign(
            new Error("Transaction numbers are only allowed on a replica set member or mongos"),
            { code: 20, codeName: "IllegalOperation" },
        ));
        await expect(new PermissionCore({ monsqlize: stub.instance }).init()).rejects.toMatchObject({
            code: "INVALID_CONFIGURATION",
            details: {
                kind: "validation",
                field: "monsqlize.withTransaction",
            },
        });
    });

    it("requires MongoDB server time during initialization", async () => {
        const stub = createMonSQLizeStub();
        stub.admin.serverStatus.mockResolvedValueOnce({ ok: 1 });
        await expect(new PermissionCore({ monsqlize: stub.instance }).init()).rejects.toMatchObject({
            code: "MONSQLIZE_CONTRACT_UNSUPPORTED",
            details: {
                kind: "validation",
                field: "monsqlize.db().admin().serverStatus().localTime",
            },
        });

        const preEpoch = createMonSQLizeStub();
        preEpoch.admin.serverStatus.mockResolvedValueOnce({ ok: 1, localTime: new Date(-1) });
        await expect(new PermissionCore({ monsqlize: preEpoch.instance }).init()).rejects.toMatchObject({
            code: "MONSQLIZE_CONTRACT_UNSUPPORTED",
            details: {
                kind: "validation",
                field: "monsqlize.db().admin().serverStatus().localTime",
            },
        });
    });

    it("maps a nested virgin scope duplicate-key cause to a revision conflict", async () => {
        const stub = createMonSQLizeStub();
        const repository = new PermissionRepository(stub.instance, "pc_nested_conflict", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        const cause = Object.assign(
            new Error("E11000 duplicate key on pc_nested_conflict_scope_state"),
            { code: 11000, keyPattern: { scopeKey: 1 } },
        );
        stub.spies.withTransaction.mockRejectedValueOnce(Object.assign(new Error("transaction wrapper failed"), { cause }));

        await expect(repository.withTransaction(async () => undefined)).rejects.toMatchObject({
            code: "REVISION_CONFLICT",
            details: {
                kind: "revision-conflict",
                owner: "scope.global",
                expected: 0,
                current: 1,
            },
        });
    });

    it("exposes nested transient driver errors to the MonSQLize transaction retry loop", async () => {
        const stub = createMonSQLizeStub();
        const repository = new PermissionRepository(stub.instance, "pc_transient_retry", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        const transient = Object.assign(new Error("write conflict"), {
            code: 112,
            codeName: "WriteConflict",
            hasErrorLabel: (label: string) => label === "TransientTransactionError",
        });
        const wrapped = Object.assign(new Error("collection wrapper"), { cause: transient });
        let hostAttempts = 0;
        const transaction = {
            state: "active",
            abort: vi.fn(async () => undefined),
            session: { id: "retry-session", inTransaction: vi.fn(() => true) },
        };
        stub.spies.withTransaction.mockImplementation(async (callback: (value: unknown) => Promise<unknown>) => {
            while (true) {
                try {
                    return await callback(transaction);
                } catch (error) {
                    hostAttempts += 1;
                    expect(error).toBe(transient);
                    if (hostAttempts > 1) {
                        throw error;
                    }
                }
            }
        });
        let domainAttempts = 0;
        const result = await repository.withTransaction(async () => {
            domainAttempts += 1;
            if (domainAttempts === 1) {
                throw wrapped;
            }
            return "committed";
        });

        expect(result).toBe("committed");
        expect(domainAttempts).toBe(2);
        expect(hostAttempts).toBe(1);
    });

    it("reports exhausted transient driver retries as retryable transaction failures", async () => {
        const stub = createMonSQLizeStub();
        const repository = new PermissionRepository(stub.instance, "pc_retry_exhausted", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        const transient = Object.assign(new Error("write conflict"), {
            code: 112,
            codeName: "WriteConflict",
            hasErrorLabel: (label: string) => label === "TransientTransactionError",
        });

        await expect(repository.withTransaction(async () => {
            throw transient;
        })).rejects.toMatchObject({
            code: "TRANSACTION_FAILED",
            retryable: true,
            details: { kind: "database-failure", stage: "transaction-callback" },
        });
    });

    it("upgrades database failures inside transactions while preserving explicit CAS errors", async () => {
        const stub = createMonSQLizeStub();
        const repository = new PermissionRepository(stub.instance, "pc_transaction_errors", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        const databaseError = new PermissionCoreError("DATABASE_ERROR", "query failed", {
            details: { kind: "database-failure", stage: "read" },
        });
        await expect(repository.withTransaction(async () => {
            throw databaseError;
        })).rejects.toMatchObject({
            code: "TRANSACTION_FAILED",
            retryable: false,
            details: { kind: "database-failure", stage: "transaction-callback" },
        });

        const conflict = new PermissionCoreError("REVISION_CONFLICT", "stale", {
            details: { kind: "revision-conflict", owner: "role:reader", expected: 1, current: 2 },
        });
        await expect(repository.withTransaction(async () => {
            throw conflict;
        })).rejects.toBe(conflict);
    });

    it("distinguishes transaction start and commit failures", async () => {
        const startStub = createMonSQLizeStub();
        const startRepository = new PermissionRepository(startStub.instance, "pc_transaction_start", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        startStub.spies.withTransaction.mockRejectedValueOnce(new Error("session could not start"));
        await expect(startRepository.withTransaction(async () => "unused")).rejects.toMatchObject({
            code: "TRANSACTION_FAILED",
            retryable: false,
            details: { kind: "database-failure", stage: "transaction-start" },
        });

        const commitStub = createMonSQLizeStub();
        const commitRepository = new PermissionRepository(commitStub.instance, "pc_transaction_commit", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        const transaction = {
            state: "active",
            abort: vi.fn(async () => undefined),
            session: { id: "commit-session", inTransaction: vi.fn(() => true) },
        };
        const unknownCommit = Object.assign(new Error("unknown commit outcome"), {
            hasErrorLabel: (label: string) => label === "UnknownTransactionCommitResult",
        });
        commitStub.spies.withTransaction.mockImplementationOnce(async (callback: (value: unknown) => Promise<unknown>) => {
            await callback(transaction);
            throw unknownCommit;
        });
        await expect(commitRepository.withTransaction(async () => "completed"))
            .rejects.toMatchObject({
                code: "TRANSACTION_FAILED",
                retryable: true,
                details: { kind: "database-failure", stage: "transaction-commit" },
            });
    });

    it("requires the native raw collection contract", () => {
        const stub = createMonSQLizeStub();
        const wrapper = stub.spies.collection("pc_raw_roles") as unknown as Record<string, unknown>;
        wrapper.raw = vi.fn(() => ({ ...wrapper, deleteMany: undefined }));
        stub.spies.collection.mockClear();

        expect(() => new PermissionRepository(stub.instance, "pc_raw", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        })).toThrow(expect.objectContaining({
            code: "MONSQLIZE_CONTRACT_UNSUPPORTED",
            details: expect.objectContaining({
                field: "monsqlize.collection.raw().deleteMany",
            }),
        }));
    });

    it("strips wrapper-only options without rewriting native filters, values, or sessions", async () => {
        const stub = createMonSQLizeStub();
        const repository = new PermissionRepository(stub.instance, "pc_native", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        const roles = stub.collections.get("pc_native_roles")!;
        const session = { id: "session" };
        const filter = { scopeKey: "a".repeat(24), roleId: "b".repeat(24) };

        await repository.collections.roles.findOne(filter, {
            session,
            collation: { locale: "simple" },
            cache: 0,
            autoInvalidate: false,
        });
        expect(roles.findOne).toHaveBeenCalledWith(filter, {
            session,
            collation: { locale: "simple" },
        });

        const document = { ...filter, actorId: "c".repeat(24) };
        await repository.collections.roles.insertOne(document, {
            session,
            cache: { invalidate: false },
            autoInvalidate: false,
        });
        expect(roles.insertOne).toHaveBeenCalledWith(document, { session });
    });

    it.each([1, 2, 199, 200])(
        "bounds health and audit queue reads by findMaxLimit=%i",
        async (findMaxLimit) => {
            const stub = createMonSQLizeStub();
            const repository = new PermissionRepository(stub.instance, `pc_budget_${findMaxLimit}`, {
                schemeContractDigest: digestCanonical("scheme"),
                schemaContractKey: digestCanonical("schema"),
            }, findMaxLimit);
            const limits: Record<"scope" | "audit", number[]> = { scope: [], audit: [] };
            const emptyFind = (bucket: number[]) => vi.fn(() => {
                const chain = {
                    sort: vi.fn(() => chain),
                    limit: vi.fn((value: number) => {
                        bucket.push(value);
                        return chain;
                    }),
                    toArray: vi.fn(async () => []),
                };
                return chain;
            });
            const prefix = `pc_budget_${findMaxLimit}`;
            stub.collections.get(`${prefix}_scope_state`)!.find = emptyFind(limits.scope);
            stub.collections.get(`${prefix}_audit_entries`)!.find = emptyFind(limits.audit);

            await repository.readHealth(digestCanonical("schema"));
            expect(limits.scope).toEqual([findMaxLimit]);
            expect(limits.audit).toEqual([findMaxLimit]);

            limits.audit.length = 0;
            await repository.audits.listAvailablePending({ tenantId: "tenant-a" }, 100, 1000);
            expect(limits.audit).toEqual([findMaxLimit]);
            await expect(repository.audits.listAvailablePending({ tenantId: "tenant-a" }, 100, 1001))
                .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        },
    );

    it("maps non-conflicting index driver failures to the index database stage", async () => {
        const stub = createMonSQLizeStub();
        const roles = stub.spies.collection("permission_core_roles") as unknown as {
            createIndexes: { mockRejectedValueOnce(error: unknown): void };
        };
        roles.createIndexes.mockRejectedValueOnce(new Error("index command failed"));
        stub.spies.collection.mockClear();

        await expect(new PermissionCore({ monsqlize: stub.instance }).init()).rejects.toMatchObject({
            code: "DATABASE_ERROR",
            details: { kind: "database-failure", stage: "index" },
        });
    });

    it("binds aggregate counters to the scope CAS and detects counter drift without a revision change", async () => {
        const stub = createMonSQLizeStub();
        const schemeContractDigest = digestCanonical("aggregate-cas-scheme");
        const schemaContractKey = digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest,
        });
        const repository = new PermissionRepository(stub.instance, "pc_aggregate_cas", {
            schemeContractDigest,
            schemaContractKey,
        });
        const scope = normalizeScope({ tenantId: "tenant-aggregate-cas" });
        const scopeKey = createScopeKey(scope);
        const scopeState = stub.collections.get("pc_aggregate_cas_scope_state")!;
        (scopeState.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
            scopeKey,
            scope,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest,
            schemaContractKey,
            revision: 0,
            rbacRevision: 0,
            menuRevision: 0,
            auditRevision: 0,
            menuConfigCount: 0,
            menuConfigBytes: 0,
            menuNodeCount: 1,
            apiBindingCount: 0,
            responseFieldCount: 0,
            responseFieldOwnerCount: 0,
            replaceManifestBytes: EMPTY_REPLACE_MANIFEST_BYTES + 1,
            createdAt: 1,
            updatedAt: 1,
        });
        const session = { inTransaction: () => true } as never;

        await expect(repository.scopeStates.advance(
            scope,
            { global: 0, rbac: 0, menu: 0, audit: 0 },
            { global: 1, rbac: 0, menu: 1, audit: 1 },
            {
                menuNodeCount: 1,
                apiBindingCount: 0,
                replaceManifestBytes: EMPTY_REPLACE_MANIFEST_BYTES + 1,
            },
            session,
            2,
            {
                menuConfigCount: 0,
                menuConfigBytes: 0,
                menuNodeCount: 0,
                apiBindingCount: 0,
                responseFieldCount: 0,
                responseFieldOwnerCount: 0,
                replaceManifestBytes: EMPTY_REPLACE_MANIFEST_BYTES,
            },
        )).rejects.toMatchObject({
            code: "PERSISTED_STATE_INVALID",
            details: { reason: "menuNodeCount changed without a matching scope revision" },
        });
        expect(scopeState.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({
                revision: 0,
                menuRevision: 0,
                menuConfigCount: 0,
                menuConfigBytes: 0,
                menuNodeCount: 0,
                apiBindingCount: 0,
                responseFieldCount: 0,
                responseFieldOwnerCount: 0,
                replaceManifestBytes: EMPTY_REPLACE_MANIFEST_BYTES,
            }),
            expect.anything(),
            expect.anything(),
        );
    });

    it("rejects invalid revision and initial audit-state combinations before database I/O", async () => {
        const stub = createMonSQLizeStub();
        const repository = new PermissionRepository(stub.instance, "pc_contract", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        const auditInsertOne = stub.collections.get("pc_contract_audit_entries")!.insertOne as ReturnType<typeof vi.fn>;
        const scopeStateUpdateOne = stub.collections.get("pc_contract_scope_state")!.updateOne as ReturnType<typeof vi.fn>;
        const session = { inTransaction: () => true } as never;

        await expect(repository.scopeStates.advance(
            { tenantId: "tenant-a" },
            { global: 0, rbac: 0, menu: 0, audit: 0 },
            { global: 1, rbac: 0, menu: 0, audit: 1 },
            {},
            session,
            1,
        )).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.scopeStates.advance(
            { tenantId: "tenant-a" },
            { global: 0, rbac: 0, menu: 0, audit: 0 },
            { global: 1, rbac: 0, menu: 1, audit: 1 },
            { menuNodeCount: MAX_MENU_NODE_COUNT + 1 },
            session,
            1,
        )).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: {
                kind: "limit-exceeded",
                limitName: "menuNodeCount",
                current: MAX_MENU_NODE_COUNT + 1,
                max: MAX_MENU_NODE_COUNT,
                unit: "items",
            },
        });

        const baseAudit = {
            auditId: "audit-1",
            operationId: "operation-1",
            scope: { tenantId: "tenant-a" },
            actorId: "admin",
            operation: "roles.create" as const,
            action: "create" as const,
            idempotencyRequestHash: digestCanonical({ roleId: "reader" }),
            change: { kind: "entity" } as const,
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [{ kind: "role" as const, id: "reader", revision: 0 }],
            },
            revisionsAfter: {
                global: 1,
                rbac: 1,
                menu: 0,
                audit: 1,
                entities: [{ kind: "role" as const, id: "reader", revision: 1 }],
            },
            changed: true,
            cacheTargets: ["scope:one"],
            replayResult: { changed: true } as const,
            cacheOutcome: "pending" as const,
            now: 1,
        };

        await expect(repository.audits.append({
            ...baseAudit,
            changed: false,
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.audits.append({
            ...baseAudit,
            cacheTargets: ["scope:one", "scope:one"],
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.audits.append({
            ...baseAudit,
            cacheTargets: ["scope:\ud800"],
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.audits.append({
            ...baseAudit,
            action: "deny" as never,
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        for (const [field, value] of [
            ["changed", "yes"],
            ["resource", 1],
            ["requestId", { id: "request" }],
            ["reason", ["because"]],
            ["validatedPlanHash", 1],
        ] as const) {
            await expect(repository.audits.append({
                ...baseAudit,
                [field]: value,
            } as never, session)).rejects.toMatchObject({
                code: "INVALID_ARGUMENT",
                details: expect.objectContaining({ kind: "validation", field }),
            });
        }
        await expect(repository.audits.append({
            ...baseAudit,
            revisionsBefore: {
                ...baseAudit.revisionsBefore,
                entities: [
                    { kind: "role", id: "reader-b", revision: 0 },
                    { kind: "role", id: "reader-a", revision: 0 },
                ],
            },
            revisionsAfter: {
                ...baseAudit.revisionsAfter,
                entities: [
                    { kind: "role", id: "reader-b", revision: 1 },
                    { kind: "role", id: "reader-a", revision: 1 },
                ],
            },
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.audits.append({
            ...baseAudit,
            revisionsBefore: {
                ...baseAudit.revisionsBefore,
                entities: [{ kind: "menu-node", id: "orders", revision: 0 }],
            },
            revisionsAfter: {
                ...baseAudit.revisionsAfter,
                entities: [{ kind: "menu-node", id: "orders", revision: 1 }],
            },
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.audits.append({
            ...baseAudit,
            revisionsBefore: { ...baseAudit.revisionsBefore, entities: [] },
            revisionsAfter: { ...baseAudit.revisionsAfter, entities: [] },
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.audits.append({
            ...baseAudit,
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [{ kind: "menu-node", id: "orders", revision: 0 }],
            },
            revisionsAfter: {
                global: 1,
                rbac: 0,
                menu: 1,
                audit: 1,
                entities: [{ kind: "menu-node", id: "orders", revision: 1 }],
            },
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.audits.append({
            ...baseAudit,
            operation: "menus.create",
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [{ kind: "role", id: "reader", revision: 0 }],
            },
            revisionsAfter: {
                global: 1,
                rbac: 1,
                menu: 0,
                audit: 1,
                entities: [{ kind: "role", id: "reader", revision: 1 }],
            },
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        await expect(repository.audits.append({
            ...baseAudit,
            change: "x".repeat(MAX_AUDIT_CHANGE_BYTES - 2),
        }, session)).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: {
                kind: "limit-exceeded",
                limitName: "audit-public-entry",
                max: MAX_AUDIT_CHANGE_BYTES,
            },
        });
        await expect(repository.audits.append({
            ...baseAudit,
            change: { "bad\u0000key": true },
        }, session)).rejects.toMatchObject({
            code: "PERSISTED_STATE_INVALID",
            details: expect.objectContaining({
                kind: "persisted-state-invalid",
                stage: "post-image",
            }),
        });
        expect(auditInsertOne).not.toHaveBeenCalled();

        await expect(repository.audits.append({
            ...baseAudit,
            auditId: "audit-reconcile",
            operationId: "operation-reconcile",
            operation: "audit.reconcileCacheOutcomes",
            action: "reconcile",
            revisionsBefore: { global: 0, rbac: 0, menu: 0, audit: 0, entities: [] },
            revisionsAfter: { global: 0, rbac: 0, menu: 0, audit: 1, entities: [] },
            cacheOutcome: "pending",
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        await repository.audits.append({
            ...baseAudit,
            auditId: "audit-reconcile",
            operationId: "operation-reconcile",
            operation: "audit.reconcileCacheOutcomes",
            action: "reconcile",
            revisionsBefore: { global: 0, rbac: 0, menu: 0, audit: 0, entities: [] },
            revisionsAfter: { global: 0, rbac: 0, menu: 0, audit: 1, entities: [] },
            cacheOutcome: "not-needed",
        }, session);
        expect(auditInsertOne).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: "audit.reconcileCacheOutcomes",
                operationalState: expect.objectContaining({ cacheOutcome: "not-needed" }),
            }),
            expect.anything(),
        );
        expect(auditInsertOne).toHaveBeenLastCalledWith(
            expect.not.objectContaining({ reconcileAvailableAt: expect.anything() }),
            expect.anything(),
        );

        await expect(repository.audits.recordCacheOutcome(
            { tenantId: "tenant-a" },
            "operation-1",
            "completed" as never,
            "degraded",
            2,
            session,
        )).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        expect(scopeStateUpdateOne).not.toHaveBeenCalled();
        expect(auditInsertOne).toHaveBeenCalledTimes(1);
    }, 20_000);

    it("accepts menu-owned audit revisions with an optional RBAC source rewrite", async () => {
        const stub = createMonSQLizeStub();
        const repository = new PermissionRepository(stub.instance, "pc_contract", {
            schemeContractDigest: digestCanonical("scheme"),
            schemaContractKey: digestCanonical("schema"),
        });
        const auditInsertOne = stub.collections.get("pc_contract_audit_entries")!.insertOne as ReturnType<typeof vi.fn>;
        const session = { inTransaction: () => true } as never;
        const baseAudit = {
            scope: { tenantId: "tenant-a" },
            actorId: "admin",
            idempotencyRequestHash: digestCanonical({ nodeId: "orders" }),
            change: { kind: "entity" } as const,
            changed: true,
            cacheTargets: ["scope:one"],
            replayResult: { changed: true } as const,
            cacheOutcome: "pending" as const,
            now: 1,
        };

        await repository.audits.append({
            ...baseAudit,
            auditId: "audit-menu-create",
            operationId: "operation-menu-create",
            operation: "menus.create",
            action: "create",
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [{ kind: "menu-node", id: "orders", revision: 0 }],
            },
            revisionsAfter: {
                global: 1,
                rbac: 0,
                menu: 1,
                audit: 1,
                entities: [{ kind: "menu-node", id: "orders", revision: 1 }],
            },
        }, session);
        await repository.audits.append({
            ...baseAudit,
            auditId: "audit-menu-rewrite",
            operationId: "operation-menu-rewrite",
            operation: "menus.executeUpdate",
            action: "update",
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [
                    { kind: "menu-node", id: "orders", revision: 0 },
                    { kind: "role", id: "reader", revision: 0 },
                ],
            },
            revisionsAfter: {
                global: 1,
                rbac: 1,
                menu: 1,
                audit: 1,
                entities: [
                    { kind: "menu-node", id: "orders", revision: 1 },
                    { kind: "role", id: "reader", revision: 1 },
                ],
            },
        }, session);
        await repository.audits.append({
            ...baseAudit,
            auditId: "audit-menu-remove-rewrite",
            operationId: "operation-menu-remove-rewrite",
            operation: "menus.remove",
            action: "remove",
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [{ kind: "menu-node", id: "orders", revision: 0 }],
            },
            revisionsAfter: {
                global: 1,
                rbac: 1,
                menu: 1,
                audit: 1,
                entities: [{ kind: "menu-node", id: "orders", revision: 1 }],
            },
        }, session);
        await repository.audits.append({
            ...baseAudit,
            auditId: "audit-menu-config-save",
            operationId: "operation-menu-config-save",
            operation: "menus.config.save",
            action: "create",
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [{ kind: "menu-config", id: "orders", revision: 0 }],
            },
            revisionsAfter: {
                global: 1,
                rbac: 0,
                menu: 1,
                audit: 1,
                entities: [{ kind: "menu-config", id: "orders", revision: 1 }],
            },
        }, session);
        await repository.audits.append({
            ...baseAudit,
            auditId: "audit-menu-config-apply-changes",
            operationId: "operation-menu-config-apply-changes",
            operation: "menus.config.applyChanges",
            action: "replace",
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [
                    { kind: "menu-config", id: "orders", revision: 0 },
                    { kind: "role", id: "reader", revision: 0 },
                ],
            },
            revisionsAfter: {
                global: 1,
                rbac: 1,
                menu: 1,
                audit: 1,
                entities: [
                    { kind: "menu-config", id: "orders", revision: 1 },
                    { kind: "role", id: "reader", revision: 1 },
                ],
            },
        }, session);

        await expect(repository.audits.append({
            ...baseAudit,
            auditId: "audit-menu-move-invalid-rbac",
            operationId: "operation-menu-move-invalid-rbac",
            operation: "menus.move",
            action: "move",
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [{ kind: "menu-node", id: "orders", revision: 0 }],
            },
            revisionsAfter: {
                global: 1,
                rbac: 1,
                menu: 1,
                audit: 1,
                entities: [{ kind: "menu-node", id: "orders", revision: 1 }],
            },
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(repository.audits.append({
            ...baseAudit,
            auditId: "audit-menu-create-invalid-rbac-owner",
            operationId: "operation-menu-create-invalid-rbac-owner",
            operation: "menus.create",
            action: "create",
            revisionsBefore: {
                global: 0,
                rbac: 0,
                menu: 0,
                audit: 0,
                entities: [
                    { kind: "menu-node", id: "orders", revision: 0 },
                    { kind: "role", id: "reader", revision: 0 },
                ],
            },
            revisionsAfter: {
                global: 1,
                rbac: 1,
                menu: 1,
                audit: 1,
                entities: [
                    { kind: "menu-node", id: "orders", revision: 1 },
                    { kind: "role", id: "reader", revision: 1 },
                ],
            },
        }, session)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        expect(auditInsertOne).toHaveBeenCalledTimes(5);
    });
});
