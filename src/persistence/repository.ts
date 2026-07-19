import type {
    Collection,
    MonSQLizeInstance,
    Transaction,
} from "monsqlize";
import type { BoundedHealthCount } from "../types";
import { compareUtf8, digestCanonical } from "../internal/canonical";
import { PermissionCoreError } from "../core/errors";
import {
    INTERNAL_COLLECTION_SUFFIXES,
    type InternalCollectionKey,
} from "./documents";
import {
    INTERNAL_INDEX_CATALOG,
    SIMPLE_COLLATION,
    createAndVerifyIndexes,
} from "./indexes";
import { ScopeStateStore, type ScopeStateContract } from "./scope-state";
import { AuditStore } from "./audit-store";
import {
    createInternalPermissionCollection,
    readFindMaxLimit,
    validateFindMaxLimit,
    type InternalPermissionCollection,
} from "./native-collection";

export interface MonSQLizeCollectionNamespace {
    readonly iid: string;
    readonly type: "mongodb";
    readonly db: string;
    readonly collection: string;
    readonly pool?: string;
}

const REQUIRED_COLLECTION_METHODS = [
    "getNamespace",
    "raw",
    "findOne",
    "find",
    "findAndCount",
    "findPage",
    "count",
    "insertOne",
    "insertMany",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany",
    "createIndexes",
    "listIndexes",
] as const;

function unsupported(field: string, reason: string): never {
    throw new PermissionCoreError(
        "MONSQLIZE_CONTRACT_UNSUPPORTED",
        `MonSQLize contract is missing ${field}: ${reason}.`,
        { details: { kind: "validation", field, reason } },
    );
}

function normalizeNamespace(value: unknown, expectedCollection: string): MonSQLizeCollectionNamespace {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        unsupported("monsqlize.collection.getNamespace", "must return a namespace descriptor");
    }
    const record = value as Record<string, unknown>;
    if (
        typeof record.iid !== "string" || !record.iid
        || record.type !== "mongodb"
        || typeof record.db !== "string" || !record.db
        || record.collection !== expectedCollection
        || (record.pool !== undefined && (typeof record.pool !== "string" || !record.pool))
    ) {
        unsupported("monsqlize.collection.getNamespace", "returned an invalid or inconsistent namespace descriptor");
    }
    return Object.freeze({
        iid: record.iid,
        type: "mongodb",
        db: record.db,
        collection: expectedCollection,
        ...(record.pool === undefined ? {} : { pool: record.pool as string }),
    });
}

function databaseFailure(
    code: "DATABASE_UNAVAILABLE" | "DATABASE_ERROR" | "TRANSACTION_FAILED",
    stage: "health" | "read" | "write" | "transaction-start" | "transaction-callback" | "transaction-commit" | "transaction-abort" | "index",
    message: string,
    cause: unknown,
    retryable?: boolean,
) {
    return new PermissionCoreError(code, message, {
        details: { kind: "database-failure", stage },
        cause,
        ...(retryable === undefined ? {} : { retryable }),
    });
}

function readErrorField(error: unknown, field: string) {
    return error !== null && typeof error === "object"
        ? (error as Record<string, unknown>)[field]
        : undefined;
}

function readErrorFieldDeep(error: unknown, field: string) {
    let current = error;
    for (let depth = 0; depth < 5; depth += 1) {
        const value = readErrorField(current, field);
        if (value !== undefined) {
            return value;
        }
        current = readErrorField(current, "cause");
        if (current === undefined) {
            break;
        }
    }
    return undefined;
}

function readErrorMessagesDeep(error: unknown) {
    const messages: string[] = [];
    let current = error;
    for (let depth = 0; depth < 5; depth += 1) {
        const message = readErrorField(current, "message");
        if (typeof message === "string") {
            messages.push(message);
        }
        current = readErrorField(current, "cause");
        if (current === undefined) {
            break;
        }
    }
    return messages.join("\n");
}

const DATABASE_UNAVAILABLE_NUMERIC_CODES = new Set([
    6, 7, 50, 89, 91, 189, 262, 9001, 11600, 11602, 13435, 13436,
]);
const DATABASE_UNAVAILABLE_STRING_CODES = new Set([
    "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT",
]);

function isDatabaseUnavailableCause(error: unknown) {
    let current = error;
    for (let depth = 0; depth < 8; depth += 1) {
        if (current === null || typeof current !== "object") {
            break;
        }
        const record = current as Record<string, unknown>;
        const code = record.code;
        const codeName = record.codeName;
        const name = record.name;
        if (
            (typeof code === "number" && DATABASE_UNAVAILABLE_NUMERIC_CODES.has(code))
            || (typeof code === "string" && DATABASE_UNAVAILABLE_STRING_CODES.has(code.toUpperCase()))
            || (typeof codeName === "string" && /HostUnreachable|HostNotFound|NetworkTimeout|ShutdownInProgress|ExceededTimeLimit|NotPrimary|PrimarySteppedDown/iu.test(codeName))
            || (typeof name === "string" && /Mongo(?:ServerSelection|Network|NetworkTimeout|TopologyClosed|NotConnected|OperationTimeout)Error/iu.test(name))
        ) {
            return true;
        }
        current = record.cause;
    }
    return /server selection|connection (?:closed|refused|reset)|network (?:error|timeout)|timed? out|topology (?:is )?closed/iu.test(
        readErrorMessagesDeep(error),
    );
}

export function mapDatabaseReadError(message: string, cause: unknown): PermissionCoreError {
    if (cause instanceof PermissionCoreError) {
        return cause;
    }
    return databaseFailure(
        isDatabaseUnavailableCause(cause) ? "DATABASE_UNAVAILABLE" : "DATABASE_ERROR",
        "read",
        message,
        cause,
    );
}

export function mapDatabaseWriteError(message: string, cause: unknown): PermissionCoreError {
    if (cause instanceof PermissionCoreError) {
        return cause;
    }
    return databaseFailure(
        isDatabaseUnavailableCause(cause) ? "DATABASE_UNAVAILABLE" : "DATABASE_ERROR",
        "write",
        message,
        cause,
    );
}

function isStandaloneTransactionError(error: unknown) {
    const code = readErrorFieldDeep(error, "code");
    const codeName = readErrorFieldDeep(error, "codeName");
    const message = readErrorMessagesDeep(error) || String(error);
    return code === 20
        || codeName === "IllegalOperation"
        || /transaction numbers are only allowed|replica set member or mongos|transactions? (?:are|is) not supported/iu.test(message);
}

function isScopeStateFirstWriteConflict(error: unknown) {
    if (readErrorFieldDeep(error, "code") !== 11000) {
        return false;
    }
    const keyPattern = readErrorFieldDeep(error, "keyPattern");
    const message = readErrorMessagesDeep(error) || String(error);
    return (
        keyPattern !== null
        && typeof keyPattern === "object"
        && Object.keys(keyPattern as Record<string, unknown>).length === 1
        && (keyPattern as Record<string, unknown>).scopeKey === 1
        && /_scope_state/iu.test(message)
    );
}

function findTransientTransactionCause(error: unknown) {
    let current = error;
    for (let depth = 0; depth < 8; depth += 1) {
        if (current === null || typeof current !== "object") {
            return null;
        }
        const candidate = current as Record<string, unknown>;
        const hasErrorLabel = candidate.hasErrorLabel;
        if (
            candidate.code === 112
            || candidate.code === 117
            || candidate.codeName === "WriteConflict"
            || (
                typeof hasErrorLabel === "function"
                && (
                    (hasErrorLabel as (label: string) => boolean).call(current, "TransientTransactionError")
                    || (hasErrorLabel as (label: string) => boolean).call(current, "UnknownTransactionCommitResult")
                )
            )
        ) {
            return current;
        }
        current = candidate.cause;
    }
    return null;
}

function assertTransaction(value: unknown): asserts value is Transaction {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        unsupported("monsqlize.withTransaction.callback", "must receive a transaction object");
    }
    const record = value as unknown as Record<string, unknown>;
    if (record.state !== "active" || typeof record.abort !== "function") {
        unsupported("monsqlize.withTransaction.callback", "transaction state/abort contract is unsupported");
    }
    const session = record.session;
    if (
        session === null
        || typeof session !== "object"
        || typeof (session as Record<string, unknown>).inTransaction !== "function"
    ) {
        unsupported("monsqlize.withTransaction.callback.session", "active MongoDB session is required");
    }
    if (!(session as { inTransaction(): boolean }).inTransaction()) {
        unsupported("monsqlize.withTransaction.callback.session", "session must be inside the active transaction");
    }
}

function boundedHealthCount(rows: readonly unknown[]): BoundedHealthCount {
    return Object.freeze({
        value: Math.min(rows.length, 1000),
        cap: 1000 as const,
        truncated: rows.length > 1000,
    });
}

function healthRowInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "A bounded health query returned malformed state.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

export interface RepositoryHealthSnapshot {
    readonly indexedContractMismatchScopes: BoundedHealthCount;
    readonly pendingCacheOutcomes: BoundedHealthCount;
    readonly lastMismatchScopeHash?: string;
}

export class PermissionRepository {
    readonly collections: Readonly<Record<InternalCollectionKey, InternalPermissionCollection>>;
    readonly namespaces: Readonly<Record<InternalCollectionKey, MonSQLizeCollectionNamespace>>;
    readonly scopeStates: ScopeStateStore;
    readonly audits: AuditStore;
    readonly findMaxLimit: number;
    private readonly monsqlize: MonSQLizeInstance;

    constructor(
        monsqlize: MonSQLizeInstance,
        prefix: string,
        scopeStateContract: ScopeStateContract,
        findMaxLimit?: number,
    ) {
        const collections = {} as Record<InternalCollectionKey, InternalPermissionCollection>;
        const namespaces = {} as Record<InternalCollectionKey, MonSQLizeCollectionNamespace>;
        this.findMaxLimit = findMaxLimit === undefined
            ? readFindMaxLimit(monsqlize)
            : validateFindMaxLimit(findMaxLimit);

        for (const [key, suffix] of Object.entries(INTERNAL_COLLECTION_SUFFIXES) as [InternalCollectionKey, string][]) {
            const name = `${prefix}${suffix}`;
            let wrapper: Collection<Record<string, unknown>>;
            try {
                wrapper = monsqlize.collection<Record<string, unknown>>(name);
            } catch {
                unsupported("monsqlize.collection", `could not create handle for ${name}`);
            }
            for (const method of REQUIRED_COLLECTION_METHODS) {
                if (typeof (wrapper as unknown as Record<string, unknown>)[method] !== "function") {
                    unsupported(`monsqlize.collection.${method}`, "is required by permission-core");
                }
            }
            const collection = createInternalPermissionCollection(wrapper);
            collections[key] = collection;
            try {
                namespaces[key] = normalizeNamespace(collection.getNamespace(), name);
            } catch (error) {
                if (error instanceof PermissionCoreError) {
                    throw error;
                }
                unsupported("monsqlize.collection.getNamespace", `call failed for ${name}`);
            }
        }

        const trustNamespace = namespaces.scopeState;
        for (const namespace of Object.values(namespaces)) {
            if (namespace.db !== trustNamespace.db || namespace.pool !== trustNamespace.pool) {
                unsupported("monsqlize.collection.getNamespace", "internal collections do not share one database trust namespace");
            }
        }

        this.collections = Object.freeze(collections);
        this.namespaces = Object.freeze(namespaces);
        this.monsqlize = monsqlize;
        this.scopeStates = new ScopeStateStore(collections.scopeState, scopeStateContract);
        this.audits = new AuditStore(collections.auditEntries, this.findMaxLimit);
    }

    async ensureIndexes() {
        try {
            for (const key of Object.keys(INTERNAL_COLLECTION_SUFFIXES) as InternalCollectionKey[]) {
                await createAndVerifyIndexes(
                    this.namespaces[key].collection,
                    this.collections[key],
                    INTERNAL_INDEX_CATALOG[key],
                );
            }
        } catch (error) {
            if (error instanceof PermissionCoreError) {
                throw error;
            }
            throw databaseFailure(
                "DATABASE_ERROR",
                "index",
                "The permission-core index operation failed.",
                error,
            );
        }
    }

    async getDatabaseTime() {
        let status: unknown;
        try {
            const database = this.monsqlize.db() as unknown as { admin(): { serverStatus(): Promise<unknown> } };
            status = await database.admin().serverStatus();
        } catch (error) {
            throw databaseFailure(
                isDatabaseUnavailableCause(error) ? "DATABASE_UNAVAILABLE" : "DATABASE_ERROR",
                "health",
                "MongoDB server time could not be read.",
                error,
            );
        }
        const localTime = status !== null && typeof status === "object"
            ? (status as Record<string, unknown>).localTime
            : undefined;
        if (
            !(localTime instanceof Date)
            || !Number.isSafeInteger(localTime.getTime())
            || localTime.getTime() < 0
        ) {
            unsupported("monsqlize.db().admin().serverStatus().localTime", "must be a valid Date");
        }
        return localTime.getTime();
    }

    async probeTransaction() {
        let callbackObserved = false;
        try {
            await this.monsqlize.withTransaction(async (transaction) => {
                assertTransaction(transaction);
                callbackObserved = true;
                await this.collections.scopeState.findOne(
                    { scopeKey: "__permission_core_transaction_probe__" },
                    {
                        session: transaction.session,
                        cache: 0,
                        collation: SIMPLE_COLLATION,
                        projection: { _id: 1 },
                    },
                );
            }, {
                readConcern: { level: "snapshot" },
                readPreference: "primary",
                enableRetry: false,
                maxRetries: 0,
            });
        } catch (error) {
            if (error instanceof PermissionCoreError) {
                if (error.code === "DATABASE_UNAVAILABLE" || error.code === "DATABASE_ERROR") {
                    throw databaseFailure(
                        "TRANSACTION_FAILED",
                        "transaction-start",
                        "The read-only transaction capability probe failed.",
                        error,
                        error.retryable || findTransientTransactionCause(error) !== null,
                    );
                }
                throw error;
            }
            if (isStandaloneTransactionError(error)) {
                throw new PermissionCoreError(
                    "INVALID_CONFIGURATION",
                    "permission-core requires MongoDB replica-set or sharded-cluster transactions.",
                    {
                        details: {
                            kind: "validation",
                            field: "monsqlize.withTransaction",
                            reason: "snapshot transactions are unavailable",
                        },
                        cause: error,
                    },
                );
            }
            throw databaseFailure(
                "TRANSACTION_FAILED",
                "transaction-start",
                "The read-only transaction capability probe failed.",
                error,
            );
        }
        if (!callbackObserved) {
            unsupported("monsqlize.withTransaction", "did not invoke the transaction callback");
        }
    }

    async withTransaction<T>(callback: (transaction: Transaction) => Promise<T>) {
        let attemptState: "not-started" | "callback-running" | "callback-failed" | "callback-completed" = "not-started";
        try {
            return await this.monsqlize.withTransaction(async (transaction) => {
                assertTransaction(transaction);
                attemptState = "callback-running";
                try {
                    const result = await callback(transaction);
                    attemptState = "callback-completed";
                    return result;
                } catch (error) {
                    attemptState = "callback-failed";
                    const transientCause = findTransientTransactionCause(error);
                    if (transientCause !== null) {
                        throw transientCause;
                    }
                    throw error;
                }
            }, {
                readConcern: { level: "snapshot" },
                readPreference: "primary",
            });
        } catch (error) {
            const stage = attemptState === "not-started"
                ? "transaction-start"
                : attemptState === "callback-completed"
                    ? "transaction-commit"
                    : "transaction-callback";
            if (error instanceof PermissionCoreError) {
                if (error.code === "DATABASE_UNAVAILABLE" || error.code === "DATABASE_ERROR") {
                    throw databaseFailure(
                        "TRANSACTION_FAILED",
                        stage,
                        "The permission-core database transaction failed.",
                        error,
                        error.retryable || findTransientTransactionCause(error) !== null,
                    );
                }
                throw error;
            }
            if (isScopeStateFirstWriteConflict(error)) {
                throw new PermissionCoreError("REVISION_CONFLICT", "Another writer established the virgin scope first.", {
                    details: {
                        kind: "revision-conflict",
                        owner: "scope.global",
                        expected: 0,
                        current: 1,
                    },
                    cause: error,
                });
            }
            const retryable = findTransientTransactionCause(error) !== null
                || isDatabaseUnavailableCause(error);
            throw databaseFailure(
                "TRANSACTION_FAILED",
                stage,
                "The permission-core database transaction failed.",
                error,
                retryable,
            );
        }
    }

    private async readContractMismatchRows(schemaContractKey: string) {
        const rows: Record<string, unknown>[] = [];
        let after: { schemaContractKey: string; scopeKey: string } | undefined;
        while (rows.length < 1001) {
            const conditions: Record<string, unknown>[] = [
                { schemaContractKey: { $type: "string" } },
                { scopeKey: { $type: "string" } },
                {
                    $or: [
                        { schemaContractKey: { $lt: schemaContractKey } },
                        { schemaContractKey: { $gt: schemaContractKey } },
                    ],
                },
            ];
            if (after !== undefined) {
                conditions.push({
                    $or: [
                        { schemaContractKey: { $gt: after.schemaContractKey } },
                        {
                            schemaContractKey: after.schemaContractKey,
                            scopeKey: { $gt: after.scopeKey },
                        },
                    ],
                });
            }
            const pageSize = Math.min(this.findMaxLimit, 1001 - rows.length);
            const page = await this.collections.scopeState.find({ $and: conditions }, {
                cache: 0,
                projection: { _id: 0, scopeKey: 1, schemaContractKey: 1 },
                hint: "pc_scope_state_contract_scope",
                collation: SIMPLE_COLLATION,
            })
                .sort({ schemaContractKey: 1, scopeKey: 1 })
                .limit(pageSize)
                .toArray();
            if (page.length === 0) {
                break;
            }
            for (const row of page) {
                if (typeof row.schemaContractKey !== "string" || typeof row.scopeKey !== "string") {
                    healthRowInvalid("contract mismatch row identity is not string-valued");
                }
                if (
                    after !== undefined
                    && (
                        compareUtf8(row.schemaContractKey, after.schemaContractKey) < 0
                        || (
                            row.schemaContractKey === after.schemaContractKey
                            && compareUtf8(row.scopeKey, after.scopeKey) <= 0
                        )
                    )
                ) {
                    healthRowInvalid("contract mismatch keyset did not advance");
                }
                after = {
                    schemaContractKey: row.schemaContractKey,
                    scopeKey: row.scopeKey,
                };
                rows.push(row);
            }
            if (page.length < pageSize) {
                break;
            }
        }
        return rows;
    }

    private async readPendingOutcomeRows() {
        const rows: Record<string, unknown>[] = [];
        let after: { scopeKey: string; auditId: string } | undefined;
        while (rows.length < 1001) {
            const base = {
                "operationalState.cacheOutcome": "pending",
                scopeKey: { $type: "string" },
                auditId: { $type: "string" },
            };
            const filter = after === undefined
                ? base
                : {
                    $and: [
                        base,
                        {
                            $or: [
                                { scopeKey: { $gt: after.scopeKey } },
                                { scopeKey: after.scopeKey, auditId: { $gt: after.auditId } },
                            ],
                        },
                    ],
                };
            const pageSize = Math.min(this.findMaxLimit, 1001 - rows.length);
            const page = await this.collections.auditEntries.find(filter, {
                cache: 0,
                projection: { _id: 0, scopeKey: 1, auditId: 1 },
                hint: "pc_audit_health_outcome",
                collation: SIMPLE_COLLATION,
            })
                .sort({ scopeKey: 1, auditId: 1 })
                .limit(pageSize)
                .toArray();
            if (page.length === 0) {
                break;
            }
            for (const row of page) {
                if (typeof row.scopeKey !== "string" || typeof row.auditId !== "string") {
                    healthRowInvalid("pending outcome row identity is not string-valued");
                }
                if (
                    after !== undefined
                    && (
                        compareUtf8(row.scopeKey, after.scopeKey) < 0
                        || (row.scopeKey === after.scopeKey && compareUtf8(row.auditId, after.auditId) <= 0)
                    )
                ) {
                    healthRowInvalid("pending outcome keyset did not advance");
                }
                after = { scopeKey: row.scopeKey, auditId: row.auditId };
                rows.push(row);
            }
            if (page.length < pageSize) {
                break;
            }
        }
        return rows;
    }

    async readHealth(schemaContractKey: string): Promise<RepositoryHealthSnapshot> {
        try {
            const mismatches = await this.readContractMismatchRows(schemaContractKey);
            const pending = await this.readPendingOutcomeRows();

            const firstScopeKey = mismatches[0]?.scopeKey;
            return Object.freeze({
                indexedContractMismatchScopes: boundedHealthCount(mismatches),
                pendingCacheOutcomes: boundedHealthCount(pending),
                ...(typeof firstScopeKey === "string"
                    ? { lastMismatchScopeHash: digestCanonical({ scopeKey: firstScopeKey }) }
                    : {}),
            });
        } catch (error) {
            throw mapDatabaseReadError("The permission-core health query failed.", error);
        }
    }

    getScopeStateNamespace() {
        return this.namespaces.scopeState;
    }

    getCollectionNames() {
        return Object.freeze(Object.values(this.namespaces).map((namespace) => namespace.collection));
    }
}
