import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "monsqlize";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import { PERSISTED_SCHEMA_VERSION, type InternalAuditEntryDocument } from "../../src/persistence/documents";
import type { PermissionRepository } from "../../src/persistence/repository";
import type { ScopeStateView } from "../../src/persistence/scope-state";
import {
    normalizeMutationOptions,
    RbacMutationExecutor,
    type ExecuteMutationInput,
} from "../../src/rbac";

const scope = Object.freeze({ tenantId: "tenant-a" });
const scopeKey = digestCanonical(scope);

function repositoryHarness() {
    let now = 100;
    let state: ScopeStateView = Object.freeze({
        scopeKey,
        scope,
        schemaVersion: PERSISTED_SCHEMA_VERSION,
        schemeContractDigest: digestCanonical([]),
        schemaContractKey: digestCanonical({ schema: 2 }),
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
        replaceManifestBytes: 49,
        createdAt: 1,
        updatedAt: 1,
        persisted: true,
    });
    const operations = new Map<string, InternalAuditEntryDocument>();
    const idempotency = new Map<string, InternalAuditEntryDocument>();
    const transaction = {
        state: "active",
        session: { id: "session", inTransaction: () => true },
        abort: vi.fn(),
    } as unknown as Transaction;
    const ensureForMutation = vi.fn(async () => state);
    const read = vi.fn(async () => state);
    const advance = vi.fn(async (
        _scope: unknown,
        _expected: unknown,
        increments: { global: number; rbac: number; menu: number; audit: number },
        _aggregate: unknown,
        _session: unknown,
        updatedAt: number,
    ) => {
        state = Object.freeze({
            ...state,
            revision: state.revision + increments.global,
            rbacRevision: state.rbacRevision + increments.rbac,
            menuRevision: state.menuRevision + increments.menu,
            auditRevision: state.auditRevision + increments.audit,
            updatedAt,
        });
        return state;
    });
    const append = vi.fn(async (input: Record<string, unknown>) => {
        const document = {
            scopeKey,
            scope,
            auditId: input.auditId,
            operationId: input.operationId,
            actorId: input.actorId,
            operation: input.operation,
            action: input.action,
            reason: input.reason,
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            idempotencyRequestHash: input.idempotencyRequestHash,
            revisionsBefore: input.revisionsBefore,
            revisionsAfter: input.revisionsAfter,
            changed: input.changed,
            cacheTargets: input.cacheTargets,
            replayResult: input.replayResult,
            operationalState: {
                cacheOutcome: input.cacheOutcome,
                updatedAt: input.now,
            },
        } as unknown as InternalAuditEntryDocument;
        operations.set(document.operationId, document);
        if (document.idempotencyKey) {
            idempotency.set(`${document.actorId}:${document.operation}:${document.idempotencyKey}`, document);
        }
        return document;
    });
    const findIdempotentReplay = vi.fn(async (
        _scope: unknown,
        actorId: string,
        operation: string,
        key: string,
        requestHash: string,
    ) => {
        const document = idempotency.get(`${actorId}:${operation}:${key}`) ?? null;
        if (document && document.idempotencyRequestHash !== requestHash) {
            throw new PermissionCoreError("IDEMPOTENCY_CONFLICT", "conflict");
        }
        return document;
    });
    const recordCacheOutcome = vi.fn(async (
        _scope: unknown,
        operationId: string,
        _expected: string,
        outcome: "completed" | "bypassed" | "degraded",
        updatedAt: number,
    ) => {
        const document = operations.get(operationId)!;
        if (document.operationalState.cacheOutcome !== "pending") {
            return null;
        }
        const next = Object.freeze({
            ...document,
            operationalState: Object.freeze({ cacheOutcome: outcome, updatedAt }),
        }) as InternalAuditEntryDocument;
        operations.set(operationId, next);
        if (next.idempotencyKey) {
            idempotency.set(`${next.actorId}:${next.operation}:${next.idempotencyKey}`, next);
        }
        return next;
    });
    const getByOperationId = vi.fn(async (_scope: unknown, operationId: string) => operations.get(operationId)!);
    const repository = {
        getDatabaseTime: vi.fn(async () => ++now),
        withTransaction: vi.fn(async (callback: (value: Transaction) => Promise<unknown>) => callback(transaction)),
        scopeStates: { ensureForMutation, read, advance },
        audits: { append, findIdempotentReplay, recordCacheOutcome, getByOperationId },
    } as unknown as PermissionRepository;
    return {
        repository,
        spies: { ensureForMutation, read, advance, append, findIdempotentReplay, recordCacheOutcome, getByOperationId },
    };
}

function mutationInput(
    work: ExecuteMutationInput<{ value: string }>["work"],
    idempotencyKey?: string,
): ExecuteMutationInput<{ value: string }> {
    return {
        scope,
        operation: "roles.create",
        action: "create",
        resource: "role:operator",
        request: { roleId: "operator" },
        options: normalizeMutationOptions({
            actorId: "admin",
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        }),
        work,
        decodeReplay(value) {
            if (value === null || typeof value !== "object" || Array.isArray(value) || typeof (value as { value?: unknown }).value !== "string") {
                throw new Error("bad replay");
            }
            return Object.freeze({ value: (value as { value: string }).value });
        },
    };
}

describe("RbacMutationExecutor", () => {
    it("commits business, revision, audit, and post-commit bypass in order", async () => {
        const harness = repositoryHarness();
        const invalidator = vi.fn(async () => "bypassed" as const);
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry(), invalidator);
        const work = vi.fn(async () => ({
            changed: true,
            data: { value: "created" },
            primaryRevision: 1,
            entity: { kind: "role" as const, id: "operator", before: 0, after: 1 },
            change: { kind: "role-created" },
            cacheTargets: ["scope:test:rbac"],
        }));

        const result = await executor.execute(mutationInput(work));
        expect(result).toMatchObject({
            committed: true,
            changed: true,
            data: { value: "created" },
            revision: 1,
            revisions: { global: 1, rbac: 1, menu: 0, audit: 1 },
            replayed: false,
            cache: { status: "bypassed" },
        });
        expect(work).toHaveBeenCalledTimes(1);
        expect(invalidator).toHaveBeenCalledWith(["scope:test:rbac"]);
        expect(harness.spies.advance).toHaveBeenCalledTimes(2);
        expect(harness.spies.append).toHaveBeenCalledWith(
            expect.objectContaining({ changed: true, cacheOutcome: "pending" }),
            expect.anything(),
        );
        expect(harness.spies.recordCacheOutcome).toHaveBeenCalledWith(
            scope,
            result.operationId,
            "pending",
            "bypassed",
            expect.any(Number),
            expect.anything(),
        );
    });

    it("records a no-op audit without authorization revision or cache work", async () => {
        const harness = repositoryHarness();
        const invalidator = vi.fn(async () => "completed" as const);
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry(), invalidator);
        const result = await executor.execute(mutationInput(async () => ({
            changed: false,
            data: { value: "same" },
            primaryRevision: 7,
            entity: { kind: "role", id: "operator", before: 7, after: 7 },
            change: { kind: "role-noop" },
            cacheTargets: [],
        })));

        expect(result).toMatchObject({
            changed: false,
            revision: 7,
            revisions: { global: 0, rbac: 0, menu: 0, audit: 1 },
            cache: { status: "not-needed" },
        });
        expect(invalidator).not.toHaveBeenCalled();
        expect(harness.spies.advance).toHaveBeenCalledTimes(1);
        expect(harness.spies.recordCacheOutcome).not.toHaveBeenCalled();
    });

    it("replays the original actor-bound result and rejects key reuse with different input", async () => {
        const harness = repositoryHarness();
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry());
        const work = vi.fn(async () => ({
            changed: true,
            data: { value: "created" },
            primaryRevision: 1,
            entity: { kind: "role" as const, id: "operator", before: 0, after: 1 },
            change: { kind: "role-created" },
            cacheTargets: ["scope:test:rbac"],
        }));
        const input = mutationInput(work, "create-operator");
        const first = await executor.execute(input);
        const replay = await executor.execute(input);
        expect(replay).toMatchObject({
            operationId: first.operationId,
            auditId: first.auditId,
            changed: true,
            replayed: true,
            data: first.data,
        });
        expect(work).toHaveBeenCalledTimes(1);

        await expect(executor.execute({
            ...input,
            request: { roleId: "different" },
        })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });

    it("trims idempotency keys and ignores audit metadata changes in the business request hash", async () => {
        const harness = repositoryHarness();
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry());
        const work = vi.fn(async () => ({
            changed: true,
            data: { value: "created" },
            primaryRevision: 1,
            entity: { kind: "role" as const, id: "operator", before: 0, after: 1 },
            change: { kind: "role-created" },
            cacheTargets: ["scope:test:rbac"],
        }));
        const firstInput = {
            ...mutationInput(work),
            options: normalizeMutationOptions({
                actorId: "admin",
                reason: "first reason",
                requestId: "request-1",
                idempotencyKey: "  create-operator  ",
            }),
        };
        const first = await executor.execute(firstInput);
        const replay = await executor.execute({
            ...firstInput,
            options: normalizeMutationOptions({
                actorId: "admin",
                reason: "retry reason",
                requestId: "request-2",
                idempotencyKey: "create-operator",
            }),
        });

        expect(firstInput.options.idempotencyKey).toBe("create-operator");
        expect(replay).toMatchObject({ operationId: first.operationId, replayed: true });
        expect(work).toHaveBeenCalledTimes(1);
        expect(harness.spies.append).toHaveBeenCalledWith(
            expect.objectContaining({ idempotencyKey: "create-operator", reason: "first reason", requestId: "request-1" }),
            expect.anything(),
        );
    });

    it("derives an internal idempotency key from requestId when callers do not provide one", async () => {
        const harness = repositoryHarness();
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry());
        const work = vi.fn(async () => ({
            changed: true,
            data: { value: "created" },
            primaryRevision: 1,
            entity: { kind: "role" as const, id: "operator", before: 0, after: 1 },
            change: { kind: "role-created" },
            cacheTargets: ["scope:test:rbac"],
        }));
        const input = {
            ...mutationInput(work),
            options: normalizeMutationOptions({
                actorId: "admin",
                requestId: "request-auto",
            }),
        };

        const first = await executor.execute(input);
        const replay = await executor.execute(input);
        const persisted = await harness.spies.append.mock.results[0]!.value as InternalAuditEntryDocument;

        expect(replay).toMatchObject({ operationId: first.operationId, replayed: true });
        expect(work).toHaveBeenCalledTimes(1);
        expect(persisted).toMatchObject({
            actorId: "admin",
            requestId: "request-auto",
            idempotencyKey: expect.stringMatching(/^auto:[A-Za-z0-9_-]{43}$/),
        });

        const changedInputWork = vi.fn(async () => ({
            changed: true,
            data: { value: "created-other" },
            primaryRevision: 2,
            entity: { kind: "role" as const, id: "viewer", before: 1, after: 2 },
            change: { kind: "role-created" },
            cacheTargets: ["scope:test:rbac"],
        }));
        await executor.execute({
            ...input,
            request: { roleId: "viewer" },
            work: changedInputWork,
        });

        expect(changedInputWork).toHaveBeenCalledTimes(1);
    });

    it("fails closed when replay primary revision evidence is inconsistent", async () => {
        const harness = repositoryHarness();
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry());
        const work = vi.fn(async () => ({
            changed: true,
            data: { value: "created" },
            primaryRevision: 1,
            entity: { kind: "role" as const, id: "operator", before: 0, after: 1 },
            change: { kind: "role-created" },
            cacheTargets: ["scope:test:rbac"],
        }));
        const input = mutationInput(work, "revision-evidence");
        await executor.execute(input);
        const persisted = await harness.spies.append.mock.results[0]!.value as InternalAuditEntryDocument;
        harness.spies.findIdempotentReplay.mockResolvedValueOnce({
            ...persisted,
            replayResult: { data: { value: "created" }, primaryRevision: 2 },
            operationalState: { cacheOutcome: "bypassed", updatedAt: 101 },
        });

        await expect(executor.execute(input)).rejects.toMatchObject({
            code: "PERSISTED_STATE_INVALID",
            details: expect.objectContaining({ reason: expect.stringContaining("primary revision") }),
        });
    });

    it("maps operation-specific replay decoder errors to persisted-state failures", async () => {
        const harness = repositoryHarness();
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry());
        const input = mutationInput(async () => ({
            changed: true,
            data: { value: "created" },
            primaryRevision: 1,
            entity: { kind: "role", id: "operator", before: 0, after: 1 },
            change: { kind: "role-created" },
            cacheTargets: ["scope:test:rbac"],
        }));

        await expect(executor.execute({
            ...input,
            decodeReplay() {
                throw new PermissionCoreError("INVALID_ACTION", "invalid action");
            },
        })).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    });

    it("maps raw idempotency preflight failures to stable database errors", async () => {
        const harness = repositoryHarness();
        harness.spies.findIdempotentReplay.mockRejectedValueOnce(new Error("query execution failed"));
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry());

        await expect(executor.execute(mutationInput(vi.fn(), "lookup-error"))).rejects.toMatchObject({
            code: "DATABASE_ERROR",
            details: { kind: "database-failure", stage: "read" },
        });
    });

    it("does not append audit or settle cache when work fails", async () => {
        const harness = repositoryHarness();
        const invalidator = vi.fn(async () => "bypassed" as const);
        const executor = new RbacMutationExecutor(harness.repository, new ResourceSchemeRegistry(), invalidator);
        await expect(executor.execute(mutationInput(async () => {
            throw new PermissionCoreError("ROLE_ALREADY_EXISTS", "exists");
        }))).rejects.toMatchObject({ code: "ROLE_ALREADY_EXISTS" });
        expect(harness.spies.append).not.toHaveBeenCalled();
        expect(invalidator).not.toHaveBeenCalled();
    });
});

describe("mutation option normalization", () => {
    it("rejects Proxy options before invoking traps", () => {
        let traps = 0;
        const options = new Proxy({ actorId: "admin" }, {
            getPrototypeOf() {
                traps += 1;
                return Object.prototype;
            },
        });
        expect(() => normalizeMutationOptions(options)).toThrowError(PermissionCoreError);
        expect(traps).toBe(0);
    });

    it("normalizes actor and rejects explicit undefined option fields", () => {
        expect(normalizeMutationOptions({ actorId: " admin " })).toEqual({ actorId: "admin" });
        expect(() => normalizeMutationOptions({ actorId: undefined })).toThrowError(PermissionCoreError);
        expect(() => normalizeMutationOptions({ idempotencyKey: "   " })).toThrowError(PermissionCoreError);
        expect(() => normalizeMutationOptions({ idempotencyKey: "bad\u0000key" })).toThrowError(PermissionCoreError);
    });
});
