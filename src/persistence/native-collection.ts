import type { Collection, MonSQLizeInstance } from "monsqlize";
import { PermissionCoreError } from "../core/errors";

export interface InternalFindCursor {
    sort(value: Readonly<Record<string, 1 | -1>>): InternalFindCursor;
    limit(value: number): InternalFindCursor;
    toArray(): Promise<Record<string, unknown>[]>;
}

export interface InternalPermissionCollection {
    getNamespace(): unknown;
    findOne(query?: unknown, options?: unknown): Promise<Record<string, unknown> | null>;
    find(query?: unknown, options?: unknown): InternalFindCursor;
    explain(query?: unknown, options?: unknown): Promise<unknown>;
    count(query?: unknown, options?: unknown): Promise<number>;
    insertOne(document?: unknown, options?: unknown): Promise<{
        acknowledged: boolean;
        insertedId: unknown;
    }>;
    insertMany(documents?: unknown[], options?: unknown): Promise<{
        acknowledged: boolean;
        insertedCount: number;
        insertedIds: Readonly<Record<string, unknown>>;
    }>;
    updateOne(filter?: unknown, update?: unknown, options?: unknown): Promise<{
        acknowledged: boolean;
        matchedCount: number;
        modifiedCount: number;
        upsertedCount: number;
        upsertedId: unknown;
    }>;
    updateMany(filter?: unknown, update?: unknown, options?: unknown): Promise<{
        acknowledged: boolean;
        matchedCount: number;
        modifiedCount: number;
        upsertedCount: number;
        upsertedId: unknown;
    }>;
    deleteOne(filter?: unknown, options?: unknown): Promise<{
        acknowledged: boolean;
        deletedCount: number;
    }>;
    deleteMany(filter?: unknown, options?: unknown): Promise<{
        acknowledged: boolean;
        deletedCount: number;
    }>;
    createIndexes(specs: Array<{ key: unknown } & Record<string, unknown>>): Promise<unknown>;
    listIndexes(): Promise<Record<string, unknown>[]>;
}

interface NativeCollectionHandle {
    findOne(query?: unknown, options?: unknown): Promise<Record<string, unknown> | null>;
    find(query?: unknown, options?: unknown): unknown;
    countDocuments(query?: unknown, options?: unknown): Promise<number>;
    insertOne(document?: unknown, options?: unknown): Promise<unknown>;
    insertMany(documents?: unknown[], options?: unknown): Promise<unknown>;
    updateOne(filter?: unknown, update?: unknown, options?: unknown): Promise<unknown>;
    updateMany(filter?: unknown, update?: unknown, options?: unknown): Promise<unknown>;
    deleteOne(filter?: unknown, options?: unknown): Promise<unknown>;
    deleteMany(filter?: unknown, options?: unknown): Promise<unknown>;
}

const NATIVE_METHODS = [
    "findOne",
    "find",
    "countDocuments",
    "insertOne",
    "insertMany",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany",
] as const;

function unsupported(field: string, reason: string): never {
    throw new PermissionCoreError(
        "MONSQLIZE_CONTRACT_UNSUPPORTED",
        `MonSQLize contract is missing ${field}: ${reason}.`,
        { details: { kind: "validation", field, reason } },
    );
}

function nativeOptions(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Internal MongoDB options must be an object.");
    }
    const {
        cache: _cache,
        autoInvalidate: _autoInvalidate,
        ...options
    } = value as Record<string, unknown>;
    return options;
}

function assertCursor(value: unknown): asserts value is InternalFindCursor {
    if (value === null || typeof value !== "object") {
        unsupported("monsqlize.collection.raw().find", "must return a native find cursor");
    }
    const cursor = value as unknown as Record<string, unknown>;
    for (const method of ["sort", "limit", "toArray"] as const) {
        if (typeof cursor[method] !== "function") {
            unsupported(`monsqlize.collection.raw().find().${method}`, "function is required");
        }
    }
}

function assertNativeCollection(value: unknown): asserts value is NativeCollectionHandle {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        unsupported("monsqlize.collection.raw", "must return a native MongoDB collection");
    }
    const native = value as unknown as Record<string, unknown>;
    for (const method of NATIVE_METHODS) {
        if (typeof native[method] !== "function") {
            unsupported(`monsqlize.collection.raw().${method}`, "function is required");
        }
    }
}

function writeResult<T>(value: unknown, operation: string): T {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        unsupported(`monsqlize.collection.raw().${operation}`, "must return a MongoDB write result");
    }
    return value as T;
}

export function validateFindMaxLimit(value: unknown) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        unsupported("monsqlize.getDefaults().findMaxLimit", "must be a positive safe integer");
    }
    return value as number;
}

export function readFindMaxLimit(monsqlize: MonSQLizeInstance) {
    let defaults: unknown;
    try {
        defaults = monsqlize.getDefaults();
    } catch (cause) {
        throw new PermissionCoreError(
            "MONSQLIZE_CONTRACT_UNSUPPORTED",
            "MonSQLize getDefaults() failed while resolving the internal query budget.",
            {
                details: { kind: "validation", field: "monsqlize.getDefaults", reason: "call failed" },
                cause,
            },
        );
    }
    if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
        unsupported("monsqlize.getDefaults", "must return an object snapshot");
    }
    return validateFindMaxLimit((defaults as Record<string, unknown>).findMaxLimit);
}

export function createInternalPermissionCollection(
    wrapper: Collection<Record<string, unknown>>,
): InternalPermissionCollection {
    let raw: unknown;
    try {
        raw = wrapper.raw();
    } catch (cause) {
        throw new PermissionCoreError(
            "MONSQLIZE_CONTRACT_UNSUPPORTED",
            "MonSQLize collection.raw() failed during capability probing.",
            {
                details: { kind: "validation", field: "monsqlize.collection.raw", reason: "call failed" },
                cause,
            },
        );
    }
    assertNativeCollection(raw);
    const native = raw;

    return Object.freeze({
        getNamespace: () => wrapper.getNamespace(),
        findOne: (query?: unknown, options?: unknown) => native.findOne(query, nativeOptions(options)),
        find(query?: unknown, options?: unknown) {
            const cursor = native.find(query, nativeOptions(options));
            assertCursor(cursor);
            return cursor;
        },
        async explain(query?: unknown, options?: unknown) {
            const normalized = nativeOptions(options) ?? {};
            const { verbosity, ...findOptions } = normalized;
            const cursor = native.find(query, findOptions);
            if (
                cursor === null
                || typeof cursor !== "object"
                || typeof (cursor as Record<string, unknown>).explain !== "function"
            ) {
                unsupported("monsqlize.collection.raw().find().explain", "function is required");
            }
            return (cursor as { explain(value?: unknown): Promise<unknown> }).explain(verbosity);
        },
        count: (query?: unknown, options?: unknown) => native.countDocuments(query, nativeOptions(options)),
        async insertOne(document?: unknown, options?: unknown) {
            return writeResult<Awaited<ReturnType<InternalPermissionCollection["insertOne"]>>>(
                await native.insertOne(document, nativeOptions(options)),
                "insertOne",
            );
        },
        async insertMany(documents?: unknown[], options?: unknown) {
            return writeResult<Awaited<ReturnType<InternalPermissionCollection["insertMany"]>>>(
                await native.insertMany(documents, nativeOptions(options)),
                "insertMany",
            );
        },
        async updateOne(filter?: unknown, update?: unknown, options?: unknown) {
            return writeResult<Awaited<ReturnType<InternalPermissionCollection["updateOne"]>>>(
                await native.updateOne(filter, update, nativeOptions(options)),
                "updateOne",
            );
        },
        async updateMany(filter?: unknown, update?: unknown, options?: unknown) {
            return writeResult<Awaited<ReturnType<InternalPermissionCollection["updateMany"]>>>(
                await native.updateMany(filter, update, nativeOptions(options)),
                "updateMany",
            );
        },
        async deleteOne(filter?: unknown, options?: unknown) {
            return writeResult<Awaited<ReturnType<InternalPermissionCollection["deleteOne"]>>>(
                await native.deleteOne(filter, nativeOptions(options)),
                "deleteOne",
            );
        },
        async deleteMany(filter?: unknown, options?: unknown) {
            return writeResult<Awaited<ReturnType<InternalPermissionCollection["deleteMany"]>>>(
                await native.deleteMany(filter, nativeOptions(options)),
                "deleteMany",
            );
        },
        createIndexes: (specs: Array<{ key: unknown } & Record<string, unknown>>) => wrapper.createIndexes(specs),
        async listIndexes() {
            const indexes = await wrapper.listIndexes();
            if (!Array.isArray(indexes)) {
                unsupported("monsqlize.collection.listIndexes", "must return an array");
            }
            return indexes as Record<string, unknown>[];
        },
    });
}
