import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { Transaction } from "monsqlize";
import type {
    MutationOptions,
    MutationResult,
    PermissionScope,
    PolicyValue,
    ResponseDetailBudget,
    RevisionVector,
} from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { isWellFormedUnicode } from "../internal/unicode";
import type {
    InternalAuditEntryDocument,
    InternalEntityRevisionKind,
    InternalManagementAuditAction,
    InternalManagementAuditOperation,
    InternalRevisionVector,
} from "../persistence/documents";
import { mapDatabaseReadError, type PermissionRepository } from "../persistence/repository";
import type { ScopeAggregateUpdate, ScopeStateView } from "../persistence/scope-state";
import { normalizeScope } from "../scope/scope";
import { RbacScopeReader } from "./store";
import { normalizeRbacId } from "./validation";
import { boundedDetails } from "./views";

const OPTION_KEYS = ["actorId", "reason", "requestId", "idempotencyKey"] as const;

export interface NormalizedMutationOptions {
    readonly actorId: string;
    readonly reason?: string;
    readonly requestId?: string;
    readonly idempotencyKey?: string;
}

export interface NormalizedRequiredRevisionOptions extends NormalizedMutationOptions {
    readonly expectedRevision: number;
}

export interface MutationWorkResult<T> {
    readonly changed: boolean;
    readonly data: T;
    readonly primaryRevision: number;
    readonly entity: {
        readonly kind: InternalEntityRevisionKind;
        readonly id: string;
        readonly before: number;
        readonly after: number;
    };
    readonly relatedEntities?: readonly {
        readonly kind: InternalEntityRevisionKind;
        readonly id: string;
        readonly before: number;
        readonly after: number;
    }[];
    readonly revisionImpact?: {
        readonly rbac: boolean;
        readonly menu: boolean;
    };
    readonly scopeAggregate?: ScopeAggregateUpdate;
    readonly change: unknown;
    readonly cacheTargets: readonly string[];
    readonly returnedDetails?: number;
    readonly completeDetailTree?: PolicyValue;
    readonly validatedPlanHash?: string;
    readonly capacity?: PolicyValue;
}

export interface MutationWorkContext {
    readonly transaction: Transaction;
    readonly state: ScopeStateView;
    readonly reader: RbacScopeReader;
    readonly now: number;
}

export interface ExecuteMutationInput<T> {
    readonly scope: PermissionScope;
    readonly operation: InternalManagementAuditOperation;
    readonly action: InternalManagementAuditAction;
    readonly resource: string;
    readonly request: PolicyValue;
    readonly options: NormalizedMutationOptions;
    work(context: MutationWorkContext): Promise<MutationWorkResult<T>>;
    decodeReplay(value: unknown): T;
    replayDetails?(data: T): { returned: number; total: number; tree: PolicyValue };
}

export type CacheInvalidator = (targets: readonly string[]) => Promise<"completed" | "bypassed">;

function normalizeOptionalText(
    value: unknown,
    field: "reason" | "requestId" | "idempotencyKey",
    max: number,
    unit: "characters" | "bytes",
) {
    if (typeof value !== "string" || !isWellFormedUnicode(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a well-formed string");
    }
    const normalized = field === "idempotencyKey" ? value.trim() : value;
    if (field === "idempotencyKey" && /[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
        throw validationError("INVALID_ARGUMENT", field, "cannot contain control characters");
    }
    const current = unit === "bytes" ? Buffer.byteLength(normalized, "utf8") : [...normalized].length;
    if (current < 1 && field !== "reason") {
        throw validationError("INVALID_ARGUMENT", field, "cannot be empty");
    }
    if (current > max) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds its limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: `${field}-${unit}`,
                current,
                max,
                unit: unit === "bytes" ? "bytes" : "items",
            },
        });
    }
    return normalized;
}

function snapshotOptions(value: unknown, allowedKeys: readonly string[]) {
    const input = value ?? {};
    if (input === null || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) {
        throw validationError("INVALID_ARGUMENT", "options", "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw validationError("INVALID_ARGUMENT", "options", "must be a plain object");
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !allowedKeys.includes(key)) {
            throw validationError("INVALID_ARGUMENT", "options", `contains unsupported key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw validationError("INVALID_ARGUMENT", `options.${key}`, "must be an enumerable defined data property");
        }
        snapshot[key] = descriptor.value;
    }
    return snapshot;
}

function normalizeMutationOptionSnapshot(snapshot: Readonly<Record<string, unknown>>): NormalizedMutationOptions {
    return deepFreeze({
        actorId: Object.hasOwn(snapshot, "actorId") ? normalizeRbacId(snapshot.actorId, "actorId") : "system",
        ...(Object.hasOwn(snapshot, "reason")
            ? { reason: normalizeOptionalText(snapshot.reason, "reason", 4096, "characters") }
            : {}),
        ...(Object.hasOwn(snapshot, "requestId")
            ? { requestId: normalizeOptionalText(snapshot.requestId, "requestId", 256, "bytes") }
            : {}),
        ...(Object.hasOwn(snapshot, "idempotencyKey")
            ? { idempotencyKey: normalizeOptionalText(snapshot.idempotencyKey, "idempotencyKey", 256, "bytes") }
            : {}),
    });
}

export function normalizeMutationOptions(value?: MutationOptions): NormalizedMutationOptions {
    return normalizeMutationOptionSnapshot(snapshotOptions(value, OPTION_KEYS));
}

export function normalizeRequiredRevisionOptions(value: unknown): NormalizedRequiredRevisionOptions {
    const snapshot = snapshotOptions(value, [...OPTION_KEYS, "expectedRevision"]);
    if (!Object.hasOwn(snapshot, "expectedRevision")) {
        throw validationError("INVALID_ARGUMENT", "expectedRevision", "is required");
    }
    return deepFreeze({
        ...normalizeMutationOptionSnapshot(snapshot),
        expectedRevision: normalizeExpectedRevision(snapshot.expectedRevision),
    });
}

export function normalizeExpectedRevision(value: unknown, field = "expectedRevision") {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw validationError("INVALID_ARGUMENT", field, "must be a non-negative safe integer");
    }
    return value as number;
}

function scopeVector(state: ScopeStateView) {
    return {
        global: state.revision,
        rbac: state.rbacRevision,
        menu: state.menuRevision,
        audit: state.auditRevision,
    };
}

function scopeAggregateSnapshot(state: ScopeStateView) {
    return {
        menuNodeCount: state.menuNodeCount,
        apiBindingCount: state.apiBindingCount,
        replaceManifestBytes: state.replaceManifestBytes,
    };
}

function internalVector(
    state: ScopeStateView,
    entities: readonly { kind: InternalEntityRevisionKind; id: string; revision: number }[],
): InternalRevisionVector {
    return {
        ...scopeVector(state),
        entities,
    };
}

function normalizeEntityTransitions(work: MutationWorkResult<unknown>) {
    const transitions = [work.entity, ...(work.relatedEntities ?? [])];
    const seen = new Set<string>();
    for (const transition of transitions) {
        const key = `${transition.kind}\u0000${transition.id}`;
        if (seen.has(key)) {
            throw validationError("INVALID_ARGUMENT", "mutationWork.entities", "cannot contain duplicate entity owners");
        }
        seen.add(key);
        if (
            !Number.isSafeInteger(transition.before)
            || transition.before < 0
            || !Number.isSafeInteger(transition.after)
            || transition.after < transition.before
            || transition.after - transition.before > 1
            || (!work.changed && transition.after !== transition.before)
        ) {
            throw validationError("INVALID_ARGUMENT", "mutationWork.entities", "contains an invalid revision transition");
        }
    }
    if (work.entity.after - work.entity.before !== (work.changed ? 1 : 0)) {
        throw validationError("INVALID_ARGUMENT", "mutationWork.entity", "does not match the primary mutation transition");
    }
    return transitions.sort((left, right) =>
        compareUtf8(left.kind, right.kind) || compareUtf8(left.id, right.id));
}

function publicVector(value: InternalRevisionVector): RevisionVector {
    return deepFreeze({
        global: value.global,
        rbac: value.rbac,
        menu: value.menu,
        audit: value.audit,
        entities: value.entities.map((entity) => ({ ...entity })),
    });
}

function replayEnvelope(value: PolicyValue) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Mutation replay result is malformed.", {
            details: { kind: "persisted-state-invalid", stage: "load", reason: "replayResult must be an object" },
        });
    }
    const record = value as Readonly<Record<string, PolicyValue>>;
    if (
        Object.keys(record).length !== 2
        || !Object.hasOwn(record, "data")
        || !Object.hasOwn(record, "primaryRevision")
        || !Number.isSafeInteger(record.primaryRevision)
        || (record.primaryRevision as number) < 0
    ) {
        throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Mutation replay result is malformed.", {
            details: { kind: "persisted-state-invalid", stage: "load", reason: "replayResult envelope is invalid" },
        });
    }
    return { data: record.data, primaryRevision: record.primaryRevision as number };
}

function detailBudget(returned: number, total: number, tree: PolicyValue): ResponseDetailBudget {
    return deepFreeze({
        limit: 100 as const,
        returned,
        truncated: total > returned,
        digest: digestCanonical(tree),
    });
}

function cacheResult(document: InternalAuditEntryDocument) {
    const status = document.operationalState.cacheOutcome;
    if (status === "pending") {
        return { status: "degraded" as const, reason: "cache outcome remains pending" };
    }
    return status === "degraded"
        ? { status, reason: "cache invalidation or outcome persistence degraded" }
        : { status };
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

export class ManagementMutationExecutor {
    constructor(
        private readonly repository: PermissionRepository,
        private readonly resourceSchemes: ResourceSchemeRegistry,
        private readonly invalidateCache: CacheInvalidator = async () => "bypassed",
    ) {}

    private async settleCacheOutcome(document: InternalAuditEntryDocument) {
        if (document.operationalState.cacheOutcome !== "pending") {
            return document;
        }
        let desired: "completed" | "bypassed" | "degraded";
        try {
            desired = await this.invalidateCache(document.cacheTargets);
        } catch {
            desired = "degraded";
        }
        try {
            const now = await this.repository.getDatabaseTime();
            await this.repository.withTransaction(async (transaction) => {
                const state = await this.repository.scopeStates.read(document.scope, transaction.session);
                const updated = await this.repository.audits.recordCacheOutcome(
                    document.scope,
                    document.operationId,
                    "pending",
                    desired,
                    now,
                    transaction.session,
                );
                if (updated !== null) {
                    await this.repository.scopeStates.advance(
                        document.scope,
                        scopeVector(state),
                        { global: 0, rbac: 0, menu: 0, audit: 1 },
                        {},
                        transaction.session,
                        now,
                        scopeAggregateSnapshot(state),
                    );
                }
            });
            return await this.repository.audits.getByOperationId(document.scope, document.operationId);
        } catch {
            return document;
        }
    }

    private async findReplay(input: ExecuteMutationInput<unknown>, requestHash: string) {
        const key = input.options.idempotencyKey;
        if (key === undefined) {
            return null;
        }
        try {
            return await this.repository.audits.findIdempotentReplay(
                input.scope,
                input.options.actorId,
                input.operation,
                key,
                requestHash,
            );
        } catch (error) {
            throw mapDatabaseReadError("The idempotency replay lookup failed.", error);
        }
    }

    private buildResult<T>(
        document: InternalAuditEntryDocument,
        replayed: boolean,
        decode: (value: unknown) => T,
        replayDetails?: (data: T) => { returned: number; total: number; tree: PolicyValue },
    ): MutationResult<T> {
        const envelope = replayEnvelope(document.replayResult);
        const primaryEntities = document.revisionsAfter.entities;
        if (
            primaryEntities.length < 1
            || !primaryEntities.some((entity) => entity.revision === envelope.primaryRevision)
        ) {
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Mutation replay result is malformed.", {
                details: {
                    kind: "persisted-state-invalid",
                    stage: "load",
                    reason: "replayResult primary revision does not match its entity revision",
                },
            });
        }
        let data: T;
        let details: { returned: number; total: number; tree: PolicyValue };
        try {
            data = decode(envelope.data);
            details = replayDetails?.(data) ?? { returned: 0, total: 0, tree: { warnings: [] } };
        } catch (error) {
            if (error instanceof PermissionCoreError && error.code === "PERSISTED_STATE_INVALID") {
                throw error;
            }
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Mutation replay result is malformed.", {
                details: {
                    kind: "persisted-state-invalid",
                    stage: "load",
                    reason: "operation-specific replay data is invalid",
                },
                cause: error,
            });
        }
        return deepFreeze({
            committed: true as const,
            changed: document.changed,
            data,
            revision: envelope.primaryRevision,
            revisions: publicVector(document.revisionsAfter),
            operationId: document.operationId,
            auditId: document.auditId,
            replayed,
            cache: cacheResult(document),
            warnings: boundedDetails([]),
            detailBudget: detailBudget(details.returned, details.total, details.tree),
        });
    }

    async execute<T>(input: ExecuteMutationInput<T>): Promise<MutationResult<T>> {
        const scope = normalizeScope(input.scope);
        const requestHash = digestCanonical({
            operation: input.operation,
            request: input.request,
        });
        const replayInput = { ...input, scope };
        const existing = await this.findReplay(replayInput, requestHash);
        if (existing !== null) {
            const settled = await this.settleCacheOutcome(existing);
            return this.buildResult(settled, true, input.decodeReplay, input.replayDetails);
        }

        const now = await this.repository.getDatabaseTime();
        const operationId = `operation_${randomUUID()}`;
        const auditId = `audit_${randomUUID()}`;
        let committed: InternalAuditEntryDocument;
        try {
            committed = await this.repository.withTransaction(async (transaction) => {
                const concurrentReplay = input.options.idempotencyKey === undefined
                    ? null
                    : await this.repository.audits.findIdempotentReplay(
                        scope,
                        input.options.actorId,
                        input.operation,
                        input.options.idempotencyKey,
                        requestHash,
                        transaction.session,
                    );
                if (concurrentReplay !== null) {
                    return concurrentReplay;
                }
                const state = await this.repository.scopeStates.ensureForMutation(scope, transaction.session, now);
                const reader = new RbacScopeReader(
                    this.repository,
                    this.resourceSchemes,
                    state,
                    transaction.session,
                );
                const work = await input.work({ transaction, state, reader, now });
                const entities = normalizeEntityTransitions(work);
                const revisionImpact = work.revisionImpact ?? { rbac: work.changed, menu: false };
                const scopeAggregate = work.scopeAggregate ?? {};
                if (
                    work.primaryRevision !== work.entity.after
                    || (work.changed && work.cacheTargets.length === 0)
                    || (!work.changed && work.cacheTargets.length !== 0)
                    || (!work.changed && (revisionImpact.rbac || revisionImpact.menu))
                    || (work.changed && !revisionImpact.rbac && !revisionImpact.menu)
                    || (Object.keys(scopeAggregate).length > 0 && (!work.changed || !revisionImpact.menu))
                ) {
                    throw validationError("INVALID_ARGUMENT", "mutationWork", "violates entity/cache transition invariants");
                }
                const before: InternalRevisionVector = {
                    ...scopeVector(state),
                    entities: entities.map((entity) => ({
                        kind: entity.kind,
                        id: entity.id,
                        revision: entity.before,
                    })),
                };
                const postState = await this.repository.scopeStates.advance(
                    scope,
                    scopeVector(state),
                    {
                        global: work.changed ? 1 : 0,
                        rbac: revisionImpact.rbac ? 1 : 0,
                        menu: revisionImpact.menu ? 1 : 0,
                        audit: 1,
                    },
                    scopeAggregate,
                    transaction.session,
                    now,
                    scopeAggregateSnapshot(state),
                );
                const after = internalVector(postState, entities.map((entity) => ({
                    kind: entity.kind,
                    id: entity.id,
                    revision: entity.after,
                })));
                return this.repository.audits.append({
                    auditId,
                    operationId,
                    scope,
                    actorId: input.options.actorId,
                    operation: input.operation,
                    action: input.action,
                    resource: input.resource,
                    ...(input.options.requestId === undefined ? {} : { requestId: input.options.requestId }),
                    ...(input.options.reason === undefined ? {} : { reason: input.options.reason }),
                    ...(input.options.idempotencyKey === undefined ? {} : { idempotencyKey: input.options.idempotencyKey }),
                    idempotencyRequestHash: requestHash,
                    ...(work.validatedPlanHash === undefined ? {} : { validatedPlanHash: work.validatedPlanHash }),
                    change: toPolicyValue(work.change),
                    ...(work.capacity === undefined ? {} : { capacity: work.capacity }),
                    revisionsBefore: before,
                    revisionsAfter: after,
                    changed: work.changed,
                    cacheTargets: work.cacheTargets,
                    replayResult: toPolicyValue({ data: work.data, primaryRevision: work.primaryRevision }),
                    cacheOutcome: work.changed ? "pending" : "not-needed",
                    now,
                }, transaction.session);
            });
        } catch (error) {
            const replay = await this.findReplay(replayInput, requestHash);
            if (replay === null) {
                throw error;
            }
            committed = replay;
        }
        const settled = await this.settleCacheOutcome(committed);
        return this.buildResult(settled, committed.operationId !== operationId, input.decodeReplay, input.replayDetails);
    }
}

export class RbacMutationExecutor extends ManagementMutationExecutor {}
