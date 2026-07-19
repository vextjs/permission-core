import { types as utilTypes } from "node:util";
import type {
    AuthorizedBulkWriteOptions,
    AuthorizedCollectionOptions,
    AuthorizedPageQuery,
    AuthorizedReadOptions,
    PermissionScope,
    SafeMongoFilter,
} from "../types";
import type { Transaction } from "monsqlize";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalByteLength } from "../internal/canonical";
import { normalizeDataPath, pathsOverlap } from "./path";
import { normalizeMongoValue } from "./value";

const MAX_PROJECTION_PATHS = 256;
const MAX_SORT_PATHS = 32;
const MAX_READ_OPTIONS_BYTES = 64 * 1024;
const MAX_PAGE = 200;

export interface NormalizedCollectionOptions {
    readonly resource: string;
    readonly scopeFields: Readonly<Record<keyof PermissionScope, string>>;
    readonly scopePaths: readonly string[];
}

export interface NormalizedProjection {
    readonly mode: "all" | "include" | "exclude";
    readonly paths: readonly string[];
    readonly includeId?: boolean;
}

export interface NormalizedReadOptions {
    readonly projection: NormalizedProjection;
    readonly sort: Readonly<Record<string, 1 | -1>>;
    readonly sortEntries: readonly (readonly [string, 1 | -1])[];
    readonly callerSortPaths: readonly string[];
    readonly limit: number;
    readonly maxTimeMS: number;
    readonly transaction?: Transaction;
}

export interface NormalizedPageQuery extends NormalizedReadOptions {
    readonly direction: "forward" | "backward";
    readonly cursor?: string;
    readonly totals: boolean;
    readonly filter?: SafeMongoFilter;
}

function invalid(field: string, reason: string): never {
    throw validationError("INVALID_ARGUMENT", field, reason);
}

function exactRecord(value: unknown, field: string, allowed?: readonly string[]) {
    const candidate = value ?? {};
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) || utilTypes.isProxy(candidate)) {
        invalid(field, "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) invalid(field, "must be a plain object");
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key) || (allowed && !allowed.includes(key))) {
            invalid(field, `contains unsupported key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            invalid(`${field}.${key}`, "must be an enumerable defined data property");
        }
        output[key] = descriptor.value;
    }
    return output;
}

function exactArray(value: unknown, field: string, maximum: number) {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maximum) {
        invalid(field, `must be a dense array of at most ${maximum} items`);
    }
    const output = new Array<unknown>(value.length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
            invalid(field, "cannot contain non-index array properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            invalid(`${field}[${key}]`, "must be an enumerable data item");
        }
        output[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== value.length) invalid(field, "cannot be sparse");
    return output;
}

function assertNoPathOverlap(paths: readonly string[], field: string) {
    for (let left = 0; left < paths.length; left += 1) {
        for (let right = left + 1; right < paths.length; right += 1) {
            if (pathsOverlap(paths[left], paths[right])) invalid(field, `contains overlapping paths ${paths[left]} and ${paths[right]}`);
        }
    }
}

export function normalizeAuthorizedCollectionOptions(
    value: AuthorizedCollectionOptions,
    subjectScope: Readonly<PermissionScope>,
): NormalizedCollectionOptions {
    const input = exactRecord(value, "options", ["resource", "scopeFields"]);
    if (typeof input.resource !== "string" || !/^db:[A-Za-z_-][A-Za-z0-9_-]{0,63}$/u.test(input.resource)) {
        invalid("options.resource", "must be an exact built-in db:<logical-resource> base resource");
    }
    const scope = exactRecord(input.scopeFields, "options.scopeFields", ["tenantId", "appId", "moduleId", "namespace"]);
    if (!Object.hasOwn(scope, "tenantId")) invalid("options.scopeFields.tenantId", "is required");
    const normalized: Partial<Record<keyof PermissionScope, string>> = {};
    for (const key of ["tenantId", "appId", "moduleId", "namespace"] as const) {
        if (subjectScope[key] !== undefined && !Object.hasOwn(scope, key)) {
            throw new PermissionCoreError("SCOPE_FIELD_MAPPING_REQUIRED", `The ${key} scope field mapping is required.`, {
                details: { kind: "validation", field: `options.scopeFields.${key}`, reason: "mapping is required by the subject scope" },
            });
        }
        if (Object.hasOwn(scope, key)) normalized[key] = normalizeDataPath(scope[key], `options.scopeFields.${key}`);
    }
    const paths = Object.values(normalized);
    assertNoPathOverlap(paths, "options.scopeFields");
    return Object.freeze({
        resource: input.resource,
        scopeFields: Object.freeze(normalized) as Readonly<Record<keyof PermissionScope, string>>,
        scopePaths: Object.freeze(paths),
    });
}

function normalizeProjection(value: unknown): NormalizedProjection {
    if (value === undefined) return Object.freeze({ mode: "all", paths: Object.freeze([]) });
    if (Array.isArray(value)) {
        const projection = exactArray(value, "options.projection", MAX_PROJECTION_PATHS);
        const paths = projection.map((entry, index) => normalizeDataPath(entry, `options.projection[${index}]`));
        if (new Set(paths).size !== paths.length) invalid("options.projection", "cannot contain duplicate paths");
        assertNoPathOverlap(paths, "options.projection");
        return Object.freeze({ mode: "include", paths: Object.freeze(paths), includeId: paths.includes("_id") });
    }
    const record = exactRecord(value, "options.projection");
    const entries = Object.entries(record);
    if (entries.length > MAX_PROJECTION_PATHS) invalid("options.projection", `must contain at most ${MAX_PROJECTION_PATHS} paths`);
    if (entries.length === 0) return Object.freeze({ mode: "all", paths: Object.freeze([]) });
    const normalized = entries.map(([path, flag]) => {
        if (flag !== 0 && flag !== 1) invalid(`options.projection.${path}`, "must be 0 or 1");
        return [normalizeDataPath(path, `options.projection.${path}`), flag] as const;
    });
    const nonIdModes = new Set(normalized.filter(([path]) => path !== "_id").map(([, flag]) => flag));
    if (nonIdModes.size > 1) invalid("options.projection", "cannot mix inclusion and exclusion except for _id");
    const mode = (nonIdModes.values().next().value ?? normalized[0][1]) === 1 ? "include" : "exclude";
    const paths = normalized.filter(([, flag]) => flag === (mode === "include" ? 1 : 0)).map(([path]) => path);
    assertNoPathOverlap(paths, "options.projection");
    const id = normalized.find(([path]) => path === "_id")?.[1];
    return Object.freeze({
        mode,
        paths: Object.freeze(paths),
        ...(id === undefined ? {} : { includeId: id === 1 }),
    });
}

function normalizeSort(value: unknown) {
    const callerProvided = value !== undefined;
    const record = value === undefined ? { _id: 1 } : exactRecord(value, "options.sort");
    const entries = Object.entries(record);
    if (entries.length < 1 || entries.length > MAX_SORT_PATHS) invalid("options.sort", `must contain 1..${MAX_SORT_PATHS} fields`);
    const normalized = entries.map(([path, direction]) => {
        if (direction !== 1 && direction !== -1) invalid(`options.sort.${path}`, "must be 1 or -1");
        return [normalizeDataPath(path, `options.sort.${path}`), direction] as const;
    });
    const idIndex = normalized.findIndex(([path]) => path === "_id");
    if (idIndex >= 0 && idIndex !== normalized.length - 1) invalid("options.sort._id", "must be the final sort field");
    assertNoPathOverlap(normalized.map(([path]) => path), "options.sort");
    const callerSortPaths = callerProvided ? normalized.map(([path]) => path) : [];
    if (idIndex < 0) normalized.push(["_id", normalized.at(-1)![1]]);
    return Object.freeze({
        entries: Object.freeze(normalized),
        callerSortPaths: Object.freeze(callerSortPaths),
    });
}

export function assertActiveTransaction(value: unknown): asserts value is Transaction {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
        invalid("options.transaction", "must be an active MonSQLize transaction");
    }
    const transaction = value as unknown as Record<string, unknown>;
    const session = transaction.session;
    if (
        transaction.state !== "active"
        || typeof transaction.abort !== "function"
        || session === null
        || typeof session !== "object"
        || utilTypes.isProxy(session)
        || typeof (session as Record<string, unknown>).inTransaction !== "function"
        || !(session as { inTransaction(): boolean }).inTransaction()
    ) {
        invalid("options.transaction", "must be active and own an in-progress MongoDB session");
    }
}

export function normalizeReadOptions(
    value: AuthorizedReadOptions | undefined,
    limits: { readonly findMaxLimit: number; readonly maxTimeMS: number },
    allowLimit = true,
): NormalizedReadOptions {
    const input = exactRecord(value, "options", ["projection", "sort", "limit", "maxTimeMS", "transaction"]);
    if (!allowLimit && Object.hasOwn(input, "limit")) invalid("options.limit", "is not supported by this method");
    const maxLimit = Math.min(MAX_PAGE, limits.findMaxLimit);
    const defaultLimit = Math.min(50, maxLimit);
    const limitValue = input.limit ?? defaultLimit;
    if (!Number.isSafeInteger(limitValue) || (limitValue as number) < 1 || (limitValue as number) > maxLimit) {
        invalid("options.limit", `must be a safe integer from 1 to ${maxLimit}`);
    }
    const timeValue = input.maxTimeMS ?? limits.maxTimeMS;
    if (!Number.isSafeInteger(timeValue) || (timeValue as number) < 1 || (timeValue as number) > limits.maxTimeMS) {
        invalid("options.maxTimeMS", `must be a safe integer from 1 to ${limits.maxTimeMS}`);
    }
    if (input.transaction !== undefined) assertActiveTransaction(input.transaction);
    const projection = normalizeProjection(input.projection);
    const normalizedSort = normalizeSort(input.sort);
    const sortEntries = normalizedSort.entries;
    const sort = Object.freeze(Object.fromEntries(sortEntries) as Record<string, 1 | -1>);
    const canonicalOptions = normalizeMongoValue({
        projection,
        sortEntries,
        limit: limitValue,
        maxTimeMS: timeValue,
    }, "caller-input", "options", false).canonical;
    const bytes = canonicalByteLength(canonicalOptions);
    if (bytes > MAX_READ_OPTIONS_BYTES) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The read options exceed their byte limit.", {
            details: { kind: "limit-exceeded", origin: "caller-input", limitName: "read-options-bytes", current: bytes, max: MAX_READ_OPTIONS_BYTES, unit: "bytes" },
        });
    }
    return Object.freeze({
        projection,
        sort,
        sortEntries,
        callerSortPaths: normalizedSort.callerSortPaths,
        limit: limitValue as number,
        maxTimeMS: timeValue as number,
        ...(input.transaction === undefined ? {} : { transaction: input.transaction as Transaction }),
    });
}

export function normalizePageQuery(
    value: AuthorizedPageQuery | undefined,
    limits: { readonly findMaxLimit: number; readonly maxTimeMS: number },
): NormalizedPageQuery {
    const input = exactRecord(value, "query", ["filter", "totals", "projection", "sort", "maxTimeMS", "transaction", "first", "after", "last", "before"]);
    const backward = Object.hasOwn(input, "last") || Object.hasOwn(input, "before");
    if (backward && (Object.hasOwn(input, "first") || Object.hasOwn(input, "after"))) invalid("query", "cannot mix forward and backward pagination");
    if (Object.hasOwn(input, "before") && !Object.hasOwn(input, "last")) invalid("query.before", "requires last");
    if (Object.hasOwn(input, "after") && typeof input.after !== "string") invalid("query.after", "must be a cursor string");
    if (Object.hasOwn(input, "before") && typeof input.before !== "string") invalid("query.before", "must be a cursor string");
    if (input.totals !== undefined && typeof input.totals !== "boolean") invalid("query.totals", "must be a boolean");
    const count = backward ? input.last : (input.first ?? 50);
    const read = normalizeReadOptions({
        ...(input.projection === undefined ? {} : { projection: input.projection as never }),
        ...(input.sort === undefined ? {} : { sort: input.sort as never }),
        limit: count as number,
        ...(input.maxTimeMS === undefined ? {} : { maxTimeMS: input.maxTimeMS as number }),
        ...(input.transaction === undefined ? {} : { transaction: input.transaction as Transaction }),
    }, limits);
    return Object.freeze({
        ...read,
        direction: backward ? "backward" : "forward",
        ...(backward ? (input.before === undefined ? {} : { cursor: input.before as string }) : (input.after === undefined ? {} : { cursor: input.after as string })),
        totals: input.totals === true,
        ...(input.filter === undefined ? {} : { filter: input.filter as SafeMongoFilter }),
    });
}

export function normalizeCountOptions(
    value: Pick<AuthorizedReadOptions, "maxTimeMS" | "transaction"> | undefined,
    limits: { readonly findMaxLimit: number; readonly maxTimeMS: number },
) {
    const input = exactRecord(value, "options", ["maxTimeMS", "transaction"]);
    return normalizeReadOptions(input as AuthorizedReadOptions, limits, false);
}

export function normalizeTransactionOptions(
    value: { readonly transaction?: Transaction } | undefined,
): Readonly<{ transaction?: Transaction }> {
    const input = exactRecord(value, "options", ["transaction"]);
    if (input.transaction !== undefined) assertActiveTransaction(input.transaction);
    return Object.freeze(input.transaction === undefined ? {} : { transaction: input.transaction as Transaction });
}

export function normalizeBulkOptions(value: AuthorizedBulkWriteOptions) {
    const input = exactRecord(value, "options", ["maxAffected", "transaction"]);
    if (!Number.isSafeInteger(input.maxAffected) || (input.maxAffected as number) < 1 || (input.maxAffected as number) > 1000) {
        invalid("options.maxAffected", "must be a safe integer from 1 to 1000");
    }
    if (input.transaction !== undefined) assertActiveTransaction(input.transaction);
    return Object.freeze({
        maxAffected: input.maxAffected as number,
        ...(input.transaction === undefined ? {} : { transaction: input.transaction as Transaction }),
    });
}
