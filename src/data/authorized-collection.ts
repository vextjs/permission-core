import type { MonSQLizeInstance, Transaction } from "monsqlize";
import type {
    AuthorizedBulkWriteOptions,
    AuthorizedCollection,
    AuthorizedCollectionOptions,
    AuthorizedDeleteResult,
    AuthorizedDocument,
    AuthorizedFindOneOptions,
    AuthorizedInsertResult,
    AuthorizedPageQuery,
    AuthorizedPageResult,
    AuthorizedReadOptions,
    AuthorizedUpdateResult,
    PermissionAction,
    PermissionSubject,
    PolicyContext,
    SafeMongoFilter,
    SafeMongoUpdate,
    SubjectDataRuntime,
} from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalByteLength, digestCanonical } from "../internal/canonical";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import {
    mapDatabaseReadError,
    mapDatabaseWriteError,
    type PermissionRepository,
} from "../persistence/repository";
import {
    createInternalPermissionCollection,
    type InternalPermissionCollection,
} from "../persistence/native-collection";
import type { RbacQueryService } from "../rbac/queries";
import { loadEffectiveAuthorization } from "../rbac/effective";
import { DataAuthorizationPlan } from "./authorization";
import { DataCursorCodec } from "./cursor";
import { normalizeSafeMongoFilter, type NormalizedSafeMongoFilter } from "./filter";
import {
    assertActiveTransaction,
    normalizeAuthorizedCollectionOptions,
    normalizeBulkOptions,
    normalizeCountOptions,
    normalizePageQuery,
    normalizeReadOptions,
    normalizeTransactionOptions,
    type NormalizedCollectionOptions,
    type NormalizedPageQuery,
    type NormalizedProjection,
    type NormalizedReadOptions,
} from "./options";
import {
    collectDocumentPaths,
    declaredPathClosure,
    readDataPath,
    writeDataPath,
    pathsOverlap,
} from "./path";
import {
    detectMongoSortScalarType,
    isMongoSortScalarType,
    readSortScalarTypes,
    sortDomainFilter,
    type MongoSortScalarType,
} from "./pagination";
import { normalizeSafeMongoUpdate, type NormalizedSafeMongoUpdate } from "./update";
import {
    normalizeCallerDocument,
    normalizeMongoValue,
    normalizePersistedDocument,
} from "./value";

type RunOperation = <T>(operation: () => Promise<T>) => Promise<T>;

interface DataRuntimeDependencies {
    readonly monsqlize: MonSQLizeInstance;
    readonly repository: PermissionRepository;
    readonly queryService: RbacQueryService;
    readonly schemes: ResourceSchemeRegistry;
    readonly subject: Readonly<PermissionSubject>;
    readonly context: PolicyContext;
    readonly run: RunOperation;
    readonly coreNamespaceHash: string;
    readonly tokenSecret: Uint8Array;
    readonly maxTimeMS: number;
}

interface LoadedPlan {
    readonly plan: DataAuthorizationPlan;
    readonly queryPlan: DataAuthorizationPlan;
    readonly transaction: Transaction;
}

interface CursorBinding {
    readonly queryHash: string;
    readonly scopeHash: string;
    readonly userHash: string;
    readonly claimsFingerprint: string;
    readonly contextFingerprint: string;
    readonly collectionHash: string;
}

const RESPONSE_BYTES = 8 * 1024 * 1024;
const CURSOR_TTL_MS = 15 * 60 * 1000;
const INTERNAL_CURSOR_PURPOSE = "pc:v2:data-cursor";
const BULK_ID_BSON_TYPES = ["null", "number", "string", "object", "binData", "objectId", "bool", "date"] as const;

interface ObjectIdConstructor {
    createFromHexString?(value: string): unknown;
    new(value: string): unknown;
}

interface BinaryConstructor {
    new(value: Uint8Array, subtype?: number): unknown;
}

interface BsonCodecs {
    objectId?: ObjectIdConstructor;
    binary?: BinaryConstructor;
}

const BSON_CODECS = new WeakMap<object, BsonCodecs>();

function bsonCodecs(monsqlize: MonSQLizeInstance) {
    const owner = monsqlize as unknown as object;
    const existing = BSON_CODECS.get(owner);
    if (existing) return existing;
    const created: BsonCodecs = {};
    BSON_CODECS.set(owner, created);
    return created;
}

function invalid(field: string, reason: string): never {
    throw validationError("INVALID_ARGUMENT", field, reason);
}

function permissionDenied(message = "The subject is not allowed to perform this data operation."): never {
    throw new PermissionCoreError("PERMISSION_DENIED", message);
}

function fieldDenied(path: string, stage: "pre-image" | "post-image" | "query"):
never {
    throw new PermissionCoreError("FIELD_PERMISSION_DENIED", `Field ${path} is not authorized for this data operation.`, {
        details: { kind: "validation", field: path, reason: `field permission failed at ${stage}`, stage },
    });
}

function invalidCursor(reason: string): never {
    throw new PermissionCoreError("INVALID_CURSOR", `Invalid data cursor: ${reason}.`, {
        details: { kind: "validation", field: "cursor", reason },
    });
}

function persistedInvalid(reason: string, stage: "load" | "pre-image" | "post-image" | "post-image-invariant" = "post-image"): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The protected data state failed a security invariant.", {
        details: { kind: "persisted-state-invalid", stage, reason },
    });
}

function readError(error: unknown) {
    if (isForeignSessionError(error)) {
        return validationError("INVALID_ARGUMENT", "options.transaction", "belongs to a different MongoDB client/session domain");
    }
    return mapDatabaseReadError("The authorized business collection read failed.", error);
}

function writeError(error: unknown) {
    if (isForeignSessionError(error)) {
        return validationError("INVALID_ARGUMENT", "options.transaction", "belongs to a different MongoDB client/session domain");
    }
    return mapDatabaseWriteError("The authorized business collection write failed.", error);
}

function isForeignSessionError(error: unknown) {
    let current = error;
    const messages: string[] = [];
    for (let depth = 0; depth < 5; depth += 1) {
        if (current === null || typeof current !== "object") break;
        const record = current as Record<string, unknown>;
        if (typeof record.message === "string") messages.push(record.message);
        current = record.cause;
    }
    return /session.*(?:different|another|same).*client|ClientSession.*MongoClient/iu.test(messages.join("\n"));
}

function normalizeCollectionName(value: unknown, internalNames: ReadonlySet<string>) {
    if (
        typeof value !== "string"
        || !value
        || Buffer.byteLength(value, "utf8") > 120
        || value.includes("\0")
        || value.includes("$")
        || value.startsWith("system.")
        || internalNames.has(value)
    ) {
        invalid("name", "must be a legal non-system business collection name outside permission-core storage");
    }
    return value;
}

function buildScopeFilter(subject: Readonly<PermissionSubject>, options: NormalizedCollectionOptions) {
    const predicates: Record<string, unknown>[] = [];
    for (const key of ["tenantId", "appId", "moduleId", "namespace"] as const) {
        const value = subject.scope[key];
        if (value === undefined) continue;
        const path = options.scopeFields[key];
        predicates.push(
            { [path]: value },
            { [path]: { $type: "string" } },
            { [path]: { $not: { $type: "array" } } },
        );
    }
    return { $and: predicates };
}

function mergedFilter(...filters: readonly Readonly<Record<string, unknown>>[]) {
    return { $and: filters };
}

function nativeReadOptions(transaction: Transaction, maxTimeMS: number) {
    return {
        session: transaction.session,
        collation: SIMPLE_COLLATION,
        maxTimeMS,
        cache: 0,
    };
}

function nativeWriteOptions(transaction: Transaction) {
    return {
        session: transaction.session,
        collation: SIMPLE_COLLATION,
        cache: { invalidate: false },
        autoInvalidate: false,
    };
}

function nativeInsertOptions(transaction: Transaction) {
    return {
        session: transaction.session,
        cache: { invalidate: false },
        autoInvalidate: false,
    };
}

function assertResponseBudget(value: unknown) {
    const canonical = normalizeMongoValue(value, "persisted-data-state", "response", false, 16).canonical;
    const bytes = canonicalByteLength(canonical);
    if (bytes > RESPONSE_BYTES) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The authorized data response exceeds 8 MiB.", {
            details: { kind: "limit-exceeded", origin: "persisted-data-state", limitName: "data-response-bytes", current: bytes, max: RESPONSE_BYTES, unit: "bytes" },
        });
    }
}

function pathExcluded(path: string, projection: NormalizedProjection) {
    return projection.mode === "exclude" && projection.paths.some((entry) => path === entry || path.startsWith(`${entry}.`));
}

function pathRelevant(path: string, projection: NormalizedProjection) {
    if (projection.mode !== "include") return true;
    return projection.paths.some((entry) => path === entry || path.startsWith(`${entry}.`) || entry.startsWith(`${path}.`));
}

function pathValueSelected(path: string, projection: NormalizedProjection) {
    if (projection.mode !== "include") return true;
    return projection.paths.some((entry) => path === entry || path.startsWith(`${entry}.`));
}

function cloneOutputScalar(value: unknown): unknown {
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Uint8Array) return new Uint8Array(value);
    return value;
}

function projectDocument(
    document: Readonly<Record<string, unknown>>,
    plan: DataAuthorizationPlan,
    projection: NormalizedProjection,
) {
    const walk = (value: unknown, path: string): { included: boolean; value?: unknown } => {
        if (!pathRelevant(path, projection) || pathExcluded(path, projection)) return { included: false };
        if (value === null || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) {
            return pathValueSelected(path, projection) && plan.canReadField(path, document)
                ? { included: true, value: cloneOutputScalar(value) }
                : { included: false };
        }
        if (Array.isArray(value)) {
            const output: unknown[] = [];
            let included = false;
            for (const item of value) {
                const selected = walk(item, path);
                if (selected.included) {
                    output.push(selected.value);
                    included = true;
                } else if (Array.isArray(item)) {
                    output.push([]);
                } else if (item !== null && typeof item === "object" && !(item instanceof Date) && !(item instanceof Uint8Array)) {
                    output.push({});
                } else {
                    return { included: false };
                }
            }
            return included || (pathValueSelected(path, projection) && plan.canReadField(path, document))
                ? { included: true, value: output }
                : { included: false };
        }
        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            const childPath = `${path}.${key}`;
            const selected = walk(child, childPath);
            if (selected.included) output[key] = selected.value;
        }
        if (Object.keys(output).length > 0 || (pathValueSelected(path, projection) && plan.canReadField(path, document))) {
            return { included: true, value: output };
        }
        return { included: false };
    };

    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document)) {
        if (key === "_id" && projection.mode === "include" && projection.includeId !== true) continue;
        if (key === "_id" && projection.mode === "exclude" && projection.includeId === false) continue;
        const selected = walk(value, key);
        if (selected.included) output[key] = selected.value;
    }
    return output;
}

function rawScopeIsExactString(
    raw: Readonly<Record<string, unknown>>,
    subject: Readonly<PermissionSubject>,
    options: NormalizedCollectionOptions,
) {
    for (const key of ["tenantId", "appId", "moduleId", "namespace"] as const) {
        const expected = subject.scope[key];
        if (expected === undefined) continue;
        const actual = readDataPath(raw, options.scopeFields[key]);
        if (!actual.found || typeof actual.value !== "string" || actual.value !== expected) return false;
    }
    return true;
}

function normalizeScopedReadback(
    raw: Readonly<Record<string, unknown>>,
    subject: Readonly<PermissionSubject>,
    options: NormalizedCollectionOptions,
) {
    if (!rawScopeIsExactString(raw, subject, options)) persistedInvalid("mapped scope field is not an exact scalar string");
    return normalizePersistedDocument(raw).value;
}

function assertReadback(
    raw: Readonly<Record<string, unknown>>,
    subject: Readonly<PermissionSubject>,
    options: NormalizedCollectionOptions,
    plan: DataAuthorizationPlan,
) {
    const normalized = normalizeScopedReadback(raw, subject, options);
    if (!plan.allowsDocument(normalized)) persistedInvalid("Mongo policy compiler admitted a row rejected by the canonical evaluator");
    return normalized;
}

function assertQueryFields(plan: DataAuthorizationPlan, filter: NormalizedSafeMongoFilter, options: NormalizedReadOptions) {
    for (const path of [...filter.referencedPaths, ...options.callerSortPaths]) {
        if (!plan.canUseFieldInQuery(path)) fieldDenied(path, "query");
    }
    if (options.projection.mode === "include") {
        for (const path of options.projection.paths) {
            if (!plan.canRequestField(path)) fieldDenied(path, "query");
        }
    }
}

function idKey(value: unknown) {
    return digestCanonical(normalizeMongoValue(value, "persisted-data-state", "document._id").canonical);
}

function changedPaths(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>) {
    const paths = new Set([...collectDocumentPaths(before), ...collectDocumentPaths(after)]);
    return [...paths].filter((path) => {
        const left = readDataPath(before, path);
        const right = readDataPath(after, path);
        if (left.found !== right.found) return true;
        if (!left.found) return false;
        return digestCanonical(normalizeMongoValue(left.value, "persisted-data-state", path).canonical)
            !== digestCanonical(normalizeMongoValue(right.value, "persisted-data-state", path).canonical);
    });
}

function unexpectedPostImage(paths: readonly string[], reason = "post-image contains unowned field changes"): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The write post-image failed the declared ownership closure.", {
        details: {
            kind: "unexpected-post-image-field",
            stage: "post-image-invariant",
            reason,
            pathCount: paths.length,
            pathDigest: digestCanonical([...paths].sort()),
        },
    });
}

async function abortBorrowedTransaction(transaction: Transaction, original: unknown): Promise<never> {
    try {
        await transaction.abort();
    } catch {
        // MonSQLize may swallow or surface the driver error; terminal session state is authoritative.
    }
    let active = true;
    try {
        active = transaction.session.inTransaction();
    } catch {
        active = true;
    }
    if (active) {
        throw new PermissionCoreError("TRANSACTION_FAILED", "The borrowed transaction could not be confirmed aborted.", {
            details: { kind: "database-failure", stage: "transaction-abort" },
            retryable: true,
            cause: original,
        });
    }
    throw original;
}

class AuthorizedCollectionService<TDocument extends object, TCreate extends object>
implements AuthorizedCollection<TDocument, TCreate> {
    private readonly collection: InternalPermissionCollection;
    private readonly options: NormalizedCollectionOptions;
    private readonly scopeFilter: Readonly<Record<string, unknown>>;
    private readonly limits: { readonly findMaxLimit: number; readonly maxTimeMS: number };
    private readonly cursorCodec: DataCursorCodec;
    private readonly codecs: BsonCodecs;

    constructor(
        private readonly dependencies: DataRuntimeDependencies,
        readonly name: string,
        options: AuthorizedCollectionOptions,
    ) {
        this.options = normalizeAuthorizedCollectionOptions(options, dependencies.subject.scope);
        dependencies.schemes.validate(this.options.resource, "resource");
        const wrapper = dependencies.monsqlize.collection<Record<string, unknown>>(name);
        const namespace = wrapper.getNamespace();
        const trust = dependencies.repository.getScopeStateNamespace();
        if (
            namespace === null
            || typeof namespace !== "object"
            || (namespace as Record<string, unknown>).db !== trust.db
            || (namespace as Record<string, unknown>).pool !== trust.pool
            || (namespace as Record<string, unknown>).collection !== name
        ) {
            throw new PermissionCoreError("MONSQLIZE_CONTRACT_UNSUPPORTED", "The business collection is outside the PermissionCore MonSQLize trust namespace.", {
                details: { kind: "validation", field: "monsqlize.collection.getNamespace", reason: "namespace identity does not match the core" },
            });
        }
        this.collection = createInternalPermissionCollection(wrapper);
        this.scopeFilter = buildScopeFilter(dependencies.subject, this.options);
        this.limits = Object.freeze({ findMaxLimit: dependencies.repository.findMaxLimit, maxTimeMS: dependencies.maxTimeMS });
        this.cursorCodec = new DataCursorCodec(dependencies.tokenSecret, dependencies.coreNamespaceHash);
        this.codecs = bsonCodecs(dependencies.monsqlize);
    }

    private async loadPlan(action: PermissionAction, transaction: Transaction): Promise<LoadedPlan> {
        try {
            const reader = await this.dependencies.queryService.open(this.dependencies.subject.scope, transaction.session);
            const direct = await reader.readUserRoleSet(this.dependencies.subject.userId);
            const state = await loadEffectiveAuthorization(reader, direct);
            await reader.verifyAuthorizationUnchanged();
            const revisions = { rbacRevision: reader.state.rbacRevision, menuRevision: reader.state.menuRevision };
            const plan = new DataAuthorizationPlan(
                state,
                this.dependencies.schemes,
                this.dependencies.subject,
                this.dependencies.context,
                action,
                this.options.resource,
                revisions,
            );
            return {
                plan,
                queryPlan: action === "read" ? plan : new DataAuthorizationPlan(
                    state,
                    this.dependencies.schemes,
                    this.dependencies.subject,
                    this.dependencies.context,
                    "read",
                    this.options.resource,
                    revisions,
                ),
                transaction,
            };
        } catch (error) {
            throw readError(error);
        }
    }

    private runWithTransaction<R>(transaction: Transaction | undefined, operation: (transaction: Transaction) => Promise<R>) {
        if (transaction) {
            assertActiveTransaction(transaction);
            return operation(transaction);
        }
        return this.dependencies.repository.withTransaction(operation);
    }

    private finalFilter(business: NormalizedSafeMongoFilter, plan: DataAuthorizationPlan, anchor?: Readonly<Record<string, unknown>>) {
        return mergedFilter(
            business.filter,
            this.scopeFilter,
            plan.permissionFilter,
            ...(anchor === undefined ? [] : [anchor]),
        );
    }

    private async rawRows(
        filter: Readonly<Record<string, unknown>>,
        options: NormalizedReadOptions,
        transaction: Transaction,
        limit = options.limit,
        sort = options.sort,
    ) {
        try {
            return await this.collection.find(filter, nativeReadOptions(transaction, options.maxTimeMS))
                .sort(sort)
                .limit(limit)
                .toArray();
        } catch (error) {
            throw readError(error);
        }
    }

    private async rawCount(filter: Readonly<Record<string, unknown>>, maxTimeMS: number, transaction: Transaction) {
        try {
            return await this.collection.count(filter, nativeReadOptions(transaction, maxTimeMS));
        } catch (error) {
            throw readError(error);
        }
    }

    private publicRows(raw: readonly Record<string, unknown>[], plan: DataAuthorizationPlan, projection: NormalizedProjection) {
        const rows = raw.map((entry) => projectDocument(
            assertReadback(entry, this.dependencies.subject, this.options, plan),
            plan,
            projection,
        )) as AuthorizedDocument<TDocument>[];
        assertResponseBudget(rows);
        return rows;
    }

    find(filter?: SafeMongoFilter, options?: AuthorizedReadOptions): Promise<AuthorizedDocument<TDocument>[]> {
        const business = normalizeSafeMongoFilter(filter);
        const read = normalizeReadOptions(options, this.limits);
        return this.dependencies.run(() => this.runWithTransaction(read.transaction, async (transaction) => {
            const { plan } = await this.loadPlan("read", transaction);
            if (plan.mode === "none") return [];
            assertQueryFields(plan, business, read);
            const raw = await this.rawRows(this.finalFilter(business, plan), read, transaction);
            return this.publicRows(raw, plan, read.projection);
        }));
    }

    findOne(filter?: SafeMongoFilter, options?: AuthorizedFindOneOptions): Promise<AuthorizedDocument<TDocument> | null> {
        const business = normalizeSafeMongoFilter(filter);
        const read = normalizeReadOptions(options, this.limits, false);
        return this.dependencies.run(() => this.runWithTransaction(read.transaction, async (transaction) => {
            const { plan } = await this.loadPlan("read", transaction);
            if (plan.mode === "none") return null;
            assertQueryFields(plan, business, read);
            const raw = await this.rawRows(this.finalFilter(business, plan), read, transaction, 1);
            return raw.length === 0 ? null : this.publicRows(raw, plan, read.projection)[0];
        }));
    }

    count(filter?: SafeMongoFilter, options?: Pick<AuthorizedReadOptions, "maxTimeMS" | "transaction">): Promise<number> {
        const business = normalizeSafeMongoFilter(filter);
        const read = normalizeCountOptions(options, this.limits);
        return this.dependencies.run(() => this.runWithTransaction(read.transaction, async (transaction) => {
            const { plan } = await this.loadPlan("read", transaction);
            if (plan.mode === "none") return 0;
            for (const path of business.referencedPaths) if (!plan.canUseFieldInQuery(path)) fieldDenied(path, "query");
            return this.rawCount(this.finalFilter(business, plan), read.maxTimeMS, transaction);
        }));
    }

    findAndCount(filter?: SafeMongoFilter, options?: AuthorizedReadOptions): Promise<{ data: AuthorizedDocument<TDocument>[]; total: number }> {
        const business = normalizeSafeMongoFilter(filter);
        const read = normalizeReadOptions(options, this.limits);
        return this.dependencies.run(() => this.runWithTransaction(read.transaction, async (transaction) => {
            const { plan } = await this.loadPlan("read", transaction);
            if (plan.mode === "none") return { data: [], total: 0 };
            assertQueryFields(plan, business, read);
            const final = this.finalFilter(business, plan);
            const raw = await this.rawRows(final, read, transaction);
            const total = await this.rawCount(final, read.maxTimeMS, transaction);
            const result = { data: this.publicRows(raw, plan, read.projection), total };
            assertResponseBudget(result);
            return result;
        }));
    }

    private cursorBinding(business: NormalizedSafeMongoFilter, page: NormalizedPageQuery): CursorBinding {
        return Object.freeze({
            queryHash: digestCanonical({
                filter: business.canonical,
                sort: page.sortEntries,
                projection: page.projection,
            }),
            scopeHash: digestCanonical(this.dependencies.subject.scope),
            userHash: digestCanonical(this.dependencies.subject.userId),
            claimsFingerprint: digestCanonical(this.dependencies.subject.claims ?? {}),
            contextFingerprint: digestCanonical(this.dependencies.context),
            collectionHash: digestCanonical(this.name),
        });
    }

    private rememberBsonCodec(value: unknown) {
        if (value === null || typeof value !== "object") return;
        const type = (value as Record<string, unknown>)._bsontype;
        const constructor = (value as { constructor?: unknown }).constructor;
        if (typeof constructor !== "function") return;
        if (type === "ObjectId" && !this.codecs.objectId) this.codecs.objectId = constructor as ObjectIdConstructor;
        if (type === "Binary" && !this.codecs.binary) this.codecs.binary = constructor as BinaryConstructor;
    }

    private anchorCanonicalValue(path: string, value: unknown) {
        if (value !== null && typeof value === "object" && (value as Record<string, unknown>)._bsontype === "Binary") {
            const subtype = (value as { sub_type?: unknown }).sub_type;
            const bytes = (value as { buffer?: unknown }).buffer;
            if (!Number.isSafeInteger(subtype) || (subtype as number) < 0 || (subtype as number) > 255 || !(bytes instanceof Uint8Array)) {
                persistedInvalid(`sort anchor field ${path} contains an invalid Binary value`, "load");
            }
            return {
                tag: "binary",
                subtype,
                base64: Buffer.from(bytes).toString("base64"),
            };
        }
        return normalizeMongoValue(value, "persisted-data-state", path).canonical;
    }

    private anchorFromRaw(
        raw: Readonly<Record<string, unknown>>,
        sort: NormalizedPageQuery["sortEntries"],
        expectedTypes: readonly MongoSortScalarType[],
    ) {
        const actualTypes = readSortScalarTypes(raw, sort);
        return sort.map(([path], index) => {
            const resolved = readDataPath(raw, path);
            if (!resolved.found) persistedInvalid(`sort anchor field ${path} is missing`);
            if (actualTypes[index] !== expectedTypes[index]) {
                persistedInvalid(`sort anchor field ${path} changed BSON type inside the protected result set`, "load");
            }
            this.rememberBsonCodec(resolved.value);
            return {
                path,
                type: actualTypes[index],
                value: this.anchorCanonicalValue(path, resolved.value),
            };
        });
    }

    private restoreAnchorValue(path: string, canonical: unknown): unknown {
        if (canonical === null || typeof canonical !== "object" || Array.isArray(canonical)) invalidCursor("anchor contains an invalid canonical value");
        const record = canonical as Record<string, unknown>;
        const exact = (...keys: readonly string[]) => (
            Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
        );
        if (record.tag === "null" && exact("tag")) return null;
        if (record.tag === "boolean" && exact("tag", "value") && typeof record.value === "boolean") return record.value;
        if (record.tag === "number" && exact("tag", "value") && typeof record.value === "number" && Number.isFinite(record.value)) return record.value;
        if (record.tag === "string" && exact("tag", "value") && typeof record.value === "string") return record.value;
        if (record.tag === "date" && exact("tag", "epochMs") && typeof record.epochMs === "number" && Number.isFinite(record.epochMs)) {
            return new Date(record.epochMs);
        }
        if (record.tag === "bytes" && exact("tag", "base64") && typeof record.base64 === "string") {
            const bytes = Buffer.from(record.base64, "base64");
            if (bytes.toString("base64") !== record.base64) invalidCursor("anchor contains a non-canonical byte value");
            return new Uint8Array(bytes);
        }
        if (
            record.tag === "binary"
            && exact("tag", "subtype", "base64")
            && Number.isSafeInteger(record.subtype)
            && (record.subtype as number) >= 0
            && (record.subtype as number) <= 255
            && typeof record.base64 === "string"
        ) {
            const bytes = Buffer.from(record.base64, "base64");
            if (bytes.toString("base64") !== record.base64) invalidCursor("anchor contains a non-canonical Binary value");
            const constructor = this.codecs.binary;
            if (!constructor) throw new PermissionCoreError("INVALID_CURSOR", "The cursor requires the originating worker's Binary codec.", {
                details: { kind: "validation", field: "cursor.anchor", reason: "Binary codec is unavailable; use sticky routing or the originating collection guard" },
            });
            return new constructor(new Uint8Array(bytes), record.subtype as number);
        }
        if (record.tag === "object-id" && exact("tag", "hex") && typeof record.hex === "string" && /^[a-f0-9]{24}$/u.test(record.hex)) {
            const constructor = this.codecs.objectId;
            if (!constructor) throw new PermissionCoreError("INVALID_CURSOR", "The cursor requires the originating worker's ObjectId codec.", {
                details: { kind: "validation", field: "cursor.anchor", reason: "ObjectId codec is unavailable; use sticky routing or the originating collection guard" },
            });
            return typeof constructor.createFromHexString === "function"
                ? constructor.createFromHexString(record.hex)
                : new constructor(record.hex);
        }
        invalidCursor("anchor contains an unsupported canonical value");
    }

    private decodeCursor(
        token: string,
        page: NormalizedPageQuery,
        binding: CursorBinding,
    ) {
        const payload = this.cursorCodec.decode(token);
        const allowedKeys = new Set([
            "purpose", "version", "direction", "resource", "action",
            "queryHash", "scopeHash", "userHash", "claimsFingerprint", "contextFingerprint", "collectionHash",
            "rbacRevision", "menuRevision", "anchor", "issuedAt", "expiresAt",
        ]);
        if (Object.keys(payload).some((key) => !allowedKeys.has(key)) || Object.keys(payload).length !== allowedKeys.size) {
            invalidCursor("payload shape is unsupported");
        }
        for (const [key, expected] of Object.entries({
            purpose: INTERNAL_CURSOR_PURPOSE,
            version: 2,
            direction: page.direction,
            resource: this.options.resource,
            action: "read",
            queryHash: binding.queryHash,
            scopeHash: binding.scopeHash,
            userHash: binding.userHash,
            collectionHash: binding.collectionHash,
        })) {
            if (payload[key] !== expected) invalidCursor(`binding does not match ${key}`);
        }
        if (
            payload.claimsFingerprint !== binding.claimsFingerprint
            || payload.contextFingerprint !== binding.contextFingerprint
        ) {
            throw new PermissionCoreError("CURSOR_STALE", "The data cursor subject context changed.", {
                details: {
                    kind: "cursor-stale",
                    owner: "subject-context",
                    expected: `${payload.claimsFingerprint}:${payload.contextFingerprint}`,
                    current: `${binding.claimsFingerprint}:${binding.contextFingerprint}`,
                },
            });
        }
        if (
            typeof payload.issuedAt !== "number"
            || typeof payload.expiresAt !== "number"
            || !Number.isSafeInteger(payload.issuedAt)
            || !Number.isSafeInteger(payload.expiresAt)
            || payload.expiresAt - payload.issuedAt !== CURSOR_TTL_MS
            || payload.issuedAt > Date.now()
        ) {
            invalidCursor("validity interval is invalid");
        }
        if (payload.expiresAt <= Date.now()) {
            throw new PermissionCoreError("CURSOR_STALE", "The data cursor has expired.", {
                details: { kind: "cursor-stale", owner: "data-cursor-expiry", expected: payload.expiresAt, current: Date.now() },
            });
        }
        if (!Number.isSafeInteger(payload.rbacRevision) || !Number.isSafeInteger(payload.menuRevision)) {
            invalidCursor("authorization revision is invalid");
        }
        if (!Array.isArray(payload.anchor) || payload.anchor.length !== page.sortEntries.length) invalidCursor("anchor does not match the sort contract");
        const sortTypes: MongoSortScalarType[] = [];
        const anchor = payload.anchor.map((entry, index) => {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalidCursor("anchor contains an invalid entry");
            const record = entry as Record<string, unknown>;
            const path = page.sortEntries[index][0];
            if (
                Object.keys(record).length !== 3
                || record.path !== path
                || !Object.hasOwn(record, "value")
                || !isMongoSortScalarType(record.type)
            ) {
                invalidCursor("anchor path order does not match the sort contract");
            }
            const value = this.restoreAnchorValue(path, record.value);
            if (detectMongoSortScalarType(value) !== record.type) invalidCursor("anchor value does not match its BSON type contract");
            sortTypes.push(record.type);
            return value;
        });
        return Object.freeze({
            anchor: Object.freeze(anchor),
            sortTypes: Object.freeze(sortTypes),
            rbacRevision: payload.rbacRevision as number,
            menuRevision: payload.menuRevision as number,
        });
    }

    private assertCursorRevision(
        cursor: { readonly rbacRevision: number; readonly menuRevision: number },
        plan: DataAuthorizationPlan,
    ) {
        if (cursor.rbacRevision !== plan.rbacRevision || cursor.menuRevision !== plan.menuRevision) {
            throw new PermissionCoreError("CURSOR_STALE", "The data authorization revision changed.", {
                details: {
                    kind: "cursor-stale",
                    owner: "scope.authorization",
                    expected: `${cursor.rbacRevision}:${cursor.menuRevision}`,
                    current: `${plan.rbacRevision}:${plan.menuRevision}`,
                },
            });
        }
    }

    private anchorFilter(values: readonly unknown[], page: NormalizedPageQuery) {
        const alternatives = page.sortEntries.map(([path, direction], index) => {
            const equality = page.sortEntries.slice(0, index).map(([priorPath], priorIndex) => ({ [priorPath]: values[priorIndex] }));
            const forwardOperator = direction === 1 ? "$gt" : "$lt";
            const operator = page.direction === "forward" ? forwardOperator : (forwardOperator === "$gt" ? "$lt" : "$gt");
            return { $and: [...equality, { [path]: { [operator]: values[index] } }] };
        });
        return { $or: alternatives };
    }

    private encodeCursor(
        raw: Readonly<Record<string, unknown>>,
        page: NormalizedPageQuery,
        binding: CursorBinding,
        plan: DataAuthorizationPlan,
        direction: "forward" | "backward",
        sortTypes: readonly MongoSortScalarType[],
    ) {
        const issuedAt = Date.now();
        return this.cursorCodec.encode({
            purpose: INTERNAL_CURSOR_PURPOSE,
            version: 2,
            direction,
            resource: this.options.resource,
            action: "read",
            ...binding,
            rbacRevision: plan.rbacRevision,
            menuRevision: plan.menuRevision,
            anchor: this.anchorFromRaw(raw, page.sortEntries, sortTypes),
            issuedAt,
            expiresAt: issuedAt + CURSOR_TTL_MS,
        });
    }

    private async assertPageSortDomain(
        final: Readonly<Record<string, unknown>>,
        page: NormalizedPageQuery,
        types: readonly MongoSortScalarType[],
        transaction: Transaction,
    ) {
        const mismatch = mergedFilter(final, { $nor: [sortDomainFilter(page.sortEntries, types)] });
        try {
            const rows = await this.collection.find(mismatch, nativeReadOptions(transaction, page.maxTimeMS))
                .limit(1)
                .toArray();
            if (rows.length > 0) {
                persistedInvalid("pagination sort fields must be present non-array scalars from one stable BSON type domain", "load");
            }
        } catch (error) {
            if (error instanceof PermissionCoreError) throw error;
            throw readError(error);
        }
    }

    findPage(query?: AuthorizedPageQuery): Promise<AuthorizedPageResult<TDocument>> {
        const page = normalizePageQuery(query, this.limits);
        const business = normalizeSafeMongoFilter(page.filter);
        const binding = this.cursorBinding(business, page);
        const decodedCursor = page.cursor ? this.decodeCursor(page.cursor, page, binding) : undefined;
        return this.dependencies.run(() => this.runWithTransaction(page.transaction, async (transaction) => {
            const { plan } = await this.loadPlan("read", transaction);
            if (decodedCursor) this.assertCursorRevision(decodedCursor, plan);
            if (plan.mode === "none") return { items: [], pageInfo: { hasNext: false, hasPrev: false, startCursor: null, endCursor: null }, ...(page.totals ? { total: 0 } : {}) };
            assertQueryFields(plan, business, page);
            const final = this.finalFilter(business, plan);
            let sortTypes = decodedCursor?.sortTypes;
            if (sortTypes) await this.assertPageSortDomain(final, page, sortTypes, transaction);
            const anchor = decodedCursor ? this.anchorFilter(decodedCursor.anchor, page) : undefined;
            const querySort = page.direction === "forward"
                ? page.sort
                : Object.freeze(Object.fromEntries(page.sortEntries.map(([path, direction]) => [path, direction === 1 ? -1 : 1])) as Record<string, 1 | -1>);
            const rawQueryOrder = await this.rawRows(anchor ? mergedFilter(final, anchor) : final, page, transaction, page.limit + 1, querySort);
            if (!sortTypes && rawQueryOrder.length > 0) {
                sortTypes = readSortScalarTypes(rawQueryOrder[0], page.sortEntries);
                await this.assertPageSortDomain(final, page, sortTypes, transaction);
            }
            const hasMore = rawQueryOrder.length > page.limit;
            const selected = rawQueryOrder.slice(0, page.limit);
            const raw = page.direction === "forward" ? selected : selected.reverse();
            const items = this.publicRows(raw, plan, page.projection);
            const total = page.totals ? await this.rawCount(final, page.maxTimeMS, transaction) : undefined;
            if (raw.length > 0 && !sortTypes) persistedInvalid("pagination sort type contract was not established", "load");
            const result: AuthorizedPageResult<TDocument> = {
                items,
                pageInfo: {
                    hasNext: page.direction === "forward" ? hasMore : page.cursor !== undefined,
                    hasPrev: page.direction === "backward" ? hasMore : page.cursor !== undefined,
                    startCursor: raw.length === 0 ? null : this.encodeCursor(raw[0], page, binding, plan, "backward", sortTypes!),
                    endCursor: raw.length === 0 ? null : this.encodeCursor(raw.at(-1)!, page, binding, plan, "forward", sortTypes!),
                },
                ...(total === undefined ? {} : { total }),
            };
            assertResponseBudget(result);
            return result;
        }));
    }

    private async writePlan(action: "create" | "update" | "delete", transaction: Transaction) {
        return this.loadPlan(action, transaction);
    }

    private injectScope(document: Record<string, unknown>) {
        for (const key of ["tenantId", "appId", "moduleId", "namespace"] as const) {
            const expected = this.dependencies.subject.scope[key];
            if (expected === undefined) continue;
            const path = this.options.scopeFields[key];
            const current = readDataPath(document, path);
            if (current.found && current.value !== expected) invalid(`document.${path}`, "conflicts with the bound subject scope");
            writeDataPath(document, path, expected);
        }
    }

    private assertFieldWrites(plan: DataAuthorizationPlan, paths: readonly string[], document: Readonly<Record<string, unknown>>, stage: "pre-image" | "post-image", unconditional = false) {
        for (const path of paths) {
            const allowed = unconditional ? plan.isFieldWriteUnconditional(path) : plan.canWriteField(path, document);
            if (!allowed) fieldDenied(path, stage);
        }
    }

    insertOne(document: TCreate, options?: { transaction?: Transaction }): Promise<AuthorizedInsertResult> {
        const caller = normalizeCallerDocument(document, "document");
        const writeOptions = normalizeTransactionOptions(options);
        let candidate = caller.value;
        const callerPaths = collectDocumentPaths(candidate).filter((path) => !this.options.scopePaths.some((scope) => pathsOverlap(scope, path)));
        const callerProvidedId = Object.hasOwn(candidate, "_id");
        this.injectScope(candidate);
        candidate = normalizeCallerDocument(candidate, "document").value;
        const callerValueDigests = new Map(callerPaths.flatMap((path) => {
            const resolved = readDataPath(candidate, path);
            return resolved.found
                ? [[path, digestCanonical(normalizeMongoValue(resolved.value, "persisted-data-state", path).canonical)] as const]
                : [];
        }));
        const transaction = writeOptions.transaction;
        return this.dependencies.run(() => this.runWithTransaction(transaction, async (active) => {
            const { plan } = await this.writePlan("create", active);
            if (plan.mode === "none" || !plan.allowsDocument(candidate)) permissionDenied();
            this.assertFieldWrites(plan, callerPaths, candidate, "post-image");
            let writeAttempted = false;
            try {
                writeAttempted = true;
                const result = await this.collection.insertOne(candidate, nativeInsertOptions(active));
                if (!result.acknowledged) throw writeError(new Error("insertOne was not acknowledged"));
                const raw = await this.collection.findOne(
                    mergedFilter({ _id: result.insertedId }, this.scopeFilter),
                    nativeReadOptions(active, this.limits.maxTimeMS),
                );
                if (!raw) persistedInvalid("inserted document could not be read back", "post-image");
                const post = normalizeScopedReadback(raw, this.dependencies.subject, this.options);
                if (!plan.allowsDocument(post)) permissionDenied("The inserted post-image is outside the authorized row policy.");
                this.assertFieldWrites(plan, callerPaths, post, "post-image");
                const allowedPaths = declaredPathClosure([
                    ...callerPaths,
                    ...this.options.scopePaths,
                    ...(callerProvidedId ? [] : ["_id"]),
                ]);
                const unexpected = collectDocumentPaths(post).filter((path) => !allowedPaths.has(path));
                if (unexpected.length > 0) unexpectedPostImage(unexpected);
                const rewritten = [...callerValueDigests].filter(([path, digest]) => {
                    const resolved = readDataPath(post, path);
                    return !resolved.found
                        || digestCanonical(normalizeMongoValue(resolved.value, "persisted-data-state", path).canonical) !== digest;
                }).map(([path]) => path);
                if (rewritten.length > 0) unexpectedPostImage(rewritten, "post-image changed caller-controlled values");
                return { acknowledged: true, insertedId: result.insertedId } as const;
            } catch (error) {
                const failure = writeError(error);
                if (transaction && writeAttempted && !isForeignSessionError(error)) return abortBorrowedTransaction(transaction, failure);
                throw failure;
            }
        }));
    }

    private async rawPreImages(
        final: Readonly<Record<string, unknown>>,
        transaction: Transaction,
        maxAffected: number,
        probeOverflow: boolean,
    ) {
        try {
            if (!probeOverflow) {
                return await this.collection.find(final, nativeReadOptions(transaction, this.limits.maxTimeMS))
                    .sort({ _id: 1 })
                    .limit(1)
                    .toArray();
            }
            const unsupported = await this.collection.find(mergedFilter(final, {
                $nor: [{ $or: BULK_ID_BSON_TYPES.map((type) => ({ _id: { $type: type } })) }],
            }), nativeReadOptions(transaction, this.limits.maxTimeMS)).limit(1).toArray();
            if (unsupported.length > 0) persistedInvalid("bulk authorization requires a supported scalar or document _id BSON type", "pre-image");

            const target = maxAffected + 1;
            const rows: Record<string, unknown>[] = [];
            for (const type of BULK_ID_BSON_TYPES) {
                let anchor: unknown;
                let hasAnchor = false;
                while (rows.length < target) {
                    const limit = Math.min(target - rows.length, this.limits.findMaxLimit);
                    const idPredicate = { $type: type, ...(hasAnchor ? { $gt: anchor } : {}) };
                    const batch = await this.collection.find(
                        mergedFilter(final, { _id: idPredicate }),
                        nativeReadOptions(transaction, this.limits.maxTimeMS),
                    ).sort({ _id: 1 }).limit(limit).toArray();
                    rows.push(...batch);
                    if (batch.length < limit) break;
                    anchor = batch.at(-1)!._id;
                    hasAnchor = true;
                }
                if (rows.length >= target) break;
            }
            return rows;
        } catch (error) {
            if (error instanceof PermissionCoreError) throw error;
            throw readError(error);
        }
    }

    private async rawPostImages(ids: readonly unknown[], transaction: Transaction) {
        const rows: Record<string, unknown>[] = [];
        try {
            for (let offset = 0; offset < ids.length; offset += this.limits.findMaxLimit) {
                const chunk = ids.slice(offset, offset + this.limits.findMaxLimit);
                const batch = await this.collection.find(
                    mergedFilter({ _id: { $in: chunk } }, this.scopeFilter),
                    nativeReadOptions(transaction, this.limits.maxTimeMS),
                ).sort({ _id: 1 }).limit(chunk.length).toArray();
                rows.push(...batch);
            }
            return rows;
        } catch (error) {
            throw readError(error);
        }
    }

    private async updateOperation(
        many: boolean,
        business: NormalizedSafeMongoFilter,
        update: NormalizedSafeMongoUpdate,
        maxAffected: number,
        transaction?: Transaction,
    ): Promise<AuthorizedUpdateResult> {
        return this.dependencies.run(() => this.runWithTransaction(transaction, async (active) => {
            const { plan, queryPlan } = await this.writePlan("update", active);
            if (plan.mode === "none") permissionDenied();
            if (business.referencedPaths.length > 0 && queryPlan.mode === "none") fieldDenied(business.referencedPaths[0], "query");
            for (const path of business.referencedPaths) if (!queryPlan.canUseFieldInQuery(path)) fieldDenied(path, "query");
            if (many && update.touchedPaths.some((path) => plan.rowPolicyFields.some((rowPath) => pathsOverlap(path, rowPath)))) {
                throw new PermissionCoreError("DATA_BULK_SCOPE_MUTATION_UNSAFE", "Bulk update cannot modify an active row-policy field.", {
                    details: { kind: "validation", field: "update", reason: "touched path overlaps an active row-policy field" },
                });
            }
            const final = this.finalFilter(business, plan);
            const rawPre = await this.rawPreImages(final, active, maxAffected, many);
            if (many && rawPre.length > maxAffected) {
                throw new PermissionCoreError("DATA_BULK_SCOPE_MUTATION_UNSAFE", "The protected bulk update exceeds maxAffected.", {
                    details: { kind: "validation", field: "options.maxAffected", reason: "matched row count exceeds the declared bound" },
                });
            }
            if (rawPre.length === 0) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
            const pre = rawPre.map((entry) => assertReadback(entry, this.dependencies.subject, this.options, plan));
            for (const document of pre) this.assertFieldWrites(plan, update.authorizationPaths, document, "pre-image", many);
            const ids = rawPre.map((entry) => entry._id);
            const frozenFilter = mergedFilter(final, { _id: { $in: ids } });
            let writeAttempted = false;
            try {
                writeAttempted = true;
                const result = many
                    ? await this.collection.updateMany(frozenFilter, update.update, nativeWriteOptions(active))
                    : await this.collection.updateOne(frozenFilter, update.update, nativeWriteOptions(active));
                if (!result.acknowledged || result.matchedCount !== rawPre.length) {
                    throw new PermissionCoreError("READ_CONFLICT", "The protected update changed between pre-image and write.", {
                        details: { kind: "read-conflict", owner: `${this.name}.update`, expected: rawPre.length, current: result.matchedCount },
                    });
                }
                const rawPost = await this.rawPostImages(ids, active);
                if (rawPost.length !== rawPre.length) persistedInvalid("post-image count does not match the frozen pre-image set");
                const beforeById = new Map(rawPre.map((entry, index) => [idKey(entry._id), pre[index]]));
                for (const raw of rawPost) {
                    const post = normalizeScopedReadback(raw, this.dependencies.subject, this.options);
                    if (!plan.allowsDocument(post)) permissionDenied("The updated post-image is outside the authorized row policy.");
                    this.assertFieldWrites(plan, update.authorizationPaths, post, "post-image", many);
                    const before = beforeById.get(idKey(raw._id));
                    if (!before) persistedInvalid("post-image contains an unexpected document");
                    const unexpected = changedPaths(before, post).filter((path) => !update.touchedPaths.some((touched) => pathsOverlap(touched, path)));
                    if (unexpected.length > 0) unexpectedPostImage(unexpected);
                }
                return { acknowledged: true, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
            } catch (error) {
                const failure = writeError(error);
                if (transaction && writeAttempted && !isForeignSessionError(error)) return abortBorrowedTransaction(transaction, failure);
                throw failure;
            }
        }));
    }

    updateOne(filter: SafeMongoFilter, update: SafeMongoUpdate, options?: { transaction?: Transaction }): Promise<AuthorizedUpdateResult> {
        const business = normalizeSafeMongoFilter(filter);
        const normalizedUpdate = normalizeSafeMongoUpdate(update, this.options.scopePaths);
        const writeOptions = normalizeTransactionOptions(options);
        return this.updateOperation(false, business, normalizedUpdate, 1, writeOptions.transaction);
    }

    updateMany(filter: SafeMongoFilter, update: SafeMongoUpdate, options: AuthorizedBulkWriteOptions): Promise<AuthorizedUpdateResult> {
        const business = normalizeSafeMongoFilter(filter);
        const normalizedUpdate = normalizeSafeMongoUpdate(update, this.options.scopePaths);
        const bulk = normalizeBulkOptions(options);
        return this.updateOperation(true, business, normalizedUpdate, bulk.maxAffected, bulk.transaction);
    }

    private async deleteOperation(
        many: boolean,
        business: NormalizedSafeMongoFilter,
        maxAffected: number,
        transaction?: Transaction,
    ): Promise<AuthorizedDeleteResult> {
        return this.dependencies.run(() => this.runWithTransaction(transaction, async (active) => {
            const { plan, queryPlan } = await this.writePlan("delete", active);
            if (plan.mode === "none") permissionDenied();
            if (business.referencedPaths.length > 0 && queryPlan.mode === "none") fieldDenied(business.referencedPaths[0], "query");
            for (const path of business.referencedPaths) if (!queryPlan.canUseFieldInQuery(path)) fieldDenied(path, "query");
            const final = this.finalFilter(business, plan);
            const raw = await this.rawPreImages(final, active, maxAffected, many);
            if (many && raw.length > maxAffected) {
                throw new PermissionCoreError("DATA_BULK_SCOPE_MUTATION_UNSAFE", "The protected bulk delete exceeds maxAffected.", {
                    details: { kind: "validation", field: "options.maxAffected", reason: "matched row count exceeds the declared bound" },
                });
            }
            if (raw.length === 0) return { acknowledged: true, deletedCount: 0 };
            for (const entry of raw) assertReadback(entry, this.dependencies.subject, this.options, plan);
            const ids = raw.map((entry) => entry._id);
            const frozen = mergedFilter(final, { _id: { $in: ids } });
            let writeAttempted = false;
            try {
                writeAttempted = true;
                const result = many
                    ? await this.collection.deleteMany(frozen, nativeWriteOptions(active))
                    : await this.collection.deleteOne(frozen, nativeWriteOptions(active));
                if (!result.acknowledged || result.deletedCount !== ids.length) {
                    throw new PermissionCoreError("READ_CONFLICT", "The protected delete changed after its pre-image was frozen.", {
                        details: { kind: "read-conflict", owner: `${this.name}.delete`, expected: ids.length, current: result.deletedCount },
                    });
                }
                return { acknowledged: true, deletedCount: result.deletedCount };
            } catch (error) {
                const failure = writeError(error);
                if (transaction && writeAttempted && !isForeignSessionError(error)) return abortBorrowedTransaction(transaction, failure);
                throw failure;
            }
        }));
    }

    deleteOne(filter: SafeMongoFilter, options?: { transaction?: Transaction }): Promise<AuthorizedDeleteResult> {
        const business = normalizeSafeMongoFilter(filter);
        const writeOptions = normalizeTransactionOptions(options);
        return this.deleteOperation(false, business, 1, writeOptions.transaction);
    }

    deleteMany(filter: SafeMongoFilter, options: AuthorizedBulkWriteOptions): Promise<AuthorizedDeleteResult> {
        const business = normalizeSafeMongoFilter(filter);
        const bulk = normalizeBulkOptions(options);
        return this.deleteOperation(true, business, bulk.maxAffected, bulk.transaction);
    }
}

export function createSubjectDataRuntime(dependencies: DataRuntimeDependencies): SubjectDataRuntime {
    const internalNames = new Set(Object.values(dependencies.repository.namespaces).map((entry) => entry.collection));
    return Object.freeze({
        collection<TDocument extends object, TCreate extends object = Omit<TDocument, "_id">>(
            nameInput: string,
            options: AuthorizedCollectionOptions,
        ) {
            const name = normalizeCollectionName(nameInput, internalNames);
            return Object.freeze(new AuthorizedCollectionService<TDocument, TCreate>(dependencies, name, options));
        },
    });
}

export type { DataRuntimeDependencies };
