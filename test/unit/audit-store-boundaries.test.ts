import { describe, expect, it, vi } from "vitest";
import { digestCanonical } from "../../src/internal/canonical";
import { AuditStore } from "../../src/persistence/audit-store";

const scope = { tenantId: "tenant-a" } as const;

function asRecord(value: unknown) {
    return value as Record<string, unknown>;
}

describe("audit store persisted-evidence boundaries", () => {
    it("rejects malformed immutable and operational evidence before returning an audit entry", async () => {
        let current: Record<string, unknown> | null = null;
        const collection = {
            insertOne: vi.fn(async (document: Record<string, unknown>) => {
                current = structuredClone(document);
                return { acknowledged: true };
            }),
            findOne: vi.fn(async () => current),
        };
        const store = new AuditStore(collection as never, 100);
        const digest = digestCanonical({ request: "create-reader" });
        const appended = await store.append({
            auditId: "audit-1",
            operationId: "operation-1",
            scope,
            actorId: "admin",
            operation: "roles.create",
            action: "create",
            resource: "role:reader",
            requestId: "request-1",
            reason: "create the reader role",
            idempotencyKey: "create-reader",
            idempotencyRequestHash: digest,
            validatedPlanHash: digestCanonical({ plan: "reader" }),
            change: { kind: "role", after: { id: "reader" } },
            capacity: { proof: "exact" },
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
            changed: true,
            cacheTargets: ["scope:one"],
            replayResult: { changed: true, roleId: "reader" },
            cacheOutcome: "pending",
            now: 100,
        }, {} as never);
        const valid = structuredClone(appended) as unknown as Record<string, unknown>;

        current = structuredClone(valid);
        await expect(store.getByOperationId(scope, "operation-1")).resolves.toMatchObject({
            operationId: "operation-1",
            operationalState: { cacheOutcome: "pending" },
        });

        const reject = async (mutate: (document: Record<string, unknown>) => void) => {
            const document = structuredClone(valid);
            mutate(document);
            current = document;
            await expect(store.getByOperationId(scope, "operation-1"))
                .rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        };

        await reject((document) => { document.unexpected = true; });
        await reject((document) => { document.scope = null; });
        await reject((document) => { document.scopeKey = "other"; });
        await reject((document) => { document.auditId = ""; });
        await reject((document) => { document.idempotencyRequestHash = "bad"; });
        await reject((document) => { document.action = "deny"; });
        await reject((document) => { document.committed = false; });
        await reject((document) => { document.changed = "yes"; });
        await reject((document) => { document.createdAt = -1; });
        await reject((document) => { document.updatedAt = 101; });
        await reject((document) => { document.cacheTargets = "scope:one"; });
        await reject((document) => { document.cacheTargets = ["scope:one", "scope:one"]; });
        await reject((document) => { document.cacheTargets = ["scope:\ud800"]; });
        await reject((document) => { document.cacheTargetCount = 2; });

        await reject((document) => { document.revisionsBefore = null; });
        await reject((document) => { asRecord(document.revisionsBefore).extra = true; });
        await reject((document) => { asRecord(document.revisionsBefore).global = -1; });
        await reject((document) => { asRecord(document.revisionsBefore).entities = "reader"; });
        await reject((document) => {
            asRecord(document.revisionsBefore).entities = Array.from({ length: 66 }, (_, index) => ({
                kind: "role",
                id: `reader-${index}`,
                revision: 0,
            }));
        });
        await reject((document) => { asRecord(document.revisionsBefore).entities = [null]; });
        await reject((document) => {
            asRecord(document.revisionsBefore).entities = [{ kind: "unknown", id: "reader", revision: 0 }];
        });
        await reject((document) => {
            asRecord(document.revisionsBefore).entities = [{ kind: "role", id: "\ud800", revision: 0 }];
        });
        await reject((document) => {
            asRecord(document.revisionsBefore).entities = [
                { kind: "role", id: "reader-b", revision: 0 },
                { kind: "role", id: "reader-a", revision: 0 },
            ];
        });
        await reject((document) => { asRecord(document.revisionsAfter).audit = 2; });

        await reject((document) => { document.idempotencyKey = ""; });
        await reject((document) => { document.validatedPlanHash = "bad"; });
        await reject((document) => { document.resource = ""; });
        await reject((document) => { document.requestId = ""; });
        await reject((document) => { document.reason = 1; });
        await reject((document) => { delete document.resourceHash; });
        await reject((document) => { delete document.requestIdHash; });
        await reject((document) => { document.resourceHash = "bad"; });
        await reject((document) => { document.requestIdHash = "bad"; });

        await reject((document) => { document.operationalState = null; });
        await reject((document) => { asRecord(document.operationalState).extra = true; });
        await reject((document) => { asRecord(document.operationalState).cacheOutcome = "unknown"; });
        await reject((document) => { asRecord(document.operationalState).updatedAt = -1; });
        await reject((document) => { asRecord(document.operationalState).cacheReconcileClaim = null; });
        await reject((document) => {
            asRecord(document.operationalState).cacheReconcileClaim = { operationId: "", expiresAt: -1 };
        });
        await reject((document) => {
            asRecord(document.operationalState).reconcileOperation = { invalid: BigInt(1) };
        });
        await reject((document) => { asRecord(document.operationalState).updatedAt = 99; });
        await reject((document) => { delete document.reconcileAvailableAt; });
        await reject((document) => {
            asRecord(document.operationalState).cacheOutcome = "completed";
        });
        await reject((document) => {
            asRecord(document.operationalState).cacheReconcileClaim = { operationId: "reconcile-1", expiresAt: 1 };
        });
        await reject((document) => { document.reconcileAvailableAt = 1; });
        await reject((document) => {
            asRecord(document.operationalState).reconcileOperation = { operationId: "reconcile-1" };
        });

        await reject((document) => { document.changeDigest = digestCanonical({ different: true }); });
        await reject((document) => { document.cacheTargetDigest = digestCanonical(["scope:other"]); });
        await reject((document) => { document.resourceHash = digestCanonical("role:other"); });
        await reject((document) => { document.requestIdHash = digestCanonical("request-other"); });
        await reject((document) => { document.evidenceDigest = digestCanonical({ different: true }); });
    });

    it("validates lookup and idempotency inputs without collection access", async () => {
        const collection = { findOne: vi.fn(async () => null) };
        const store = new AuditStore(collection as never, 100);

        await expect(store.getByAuditId(scope, "missing")).rejects.toMatchObject({ code: "AUDIT_ENTRY_NOT_FOUND" });
        await expect(store.getByOperationId(scope, "missing")).rejects.toMatchObject({ code: "AUDIT_ENTRY_NOT_FOUND" });
        await expect(store.getByAuditId(scope, "")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(store.findIdempotentReplay(scope, "admin", "unknown" as never, "key", digestCanonical("x")))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(store.findIdempotentReplay(scope, "admin", "roles.create", "key", "bad"))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        expect(collection.findOne).toHaveBeenCalledTimes(2);
    });
});
