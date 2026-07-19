import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { MonSQLizeInstance } from "monsqlize";
import type {
    PermissionCoreOptions,
    ResourceSchemeDefinition,
} from "../types";
import { isWellFormedUnicode } from "../internal/unicode";
import { validationError } from "./errors";

export const DEFAULT_COLLECTION_PREFIX = "permission_core";
export const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 30_000;
export const DEFAULT_PERMISSION_CACHE_TTL_MS = 30_000;

export interface ResolvedPermissionCoreOptions {
    readonly monsqlize: MonSQLizeInstance;
    readonly collectionPrefix: string;
    readonly usesDefaultCollectionPrefix: boolean;
    readonly cache:
        | { readonly enabled: false }
        | {
            readonly enabled: true;
            readonly ttlMs: number;
            readonly consistency: "ordered-bounded-stale";
        };
    readonly closeDrainTimeoutMs: number;
    readonly tokenSecret: Uint8Array;
    readonly tokenKeySource: "ephemeral" | "configured";
    readonly resourceSchemes: readonly ResourceSchemeDefinition[];
}

function configError(field: string, reason: string): never {
    throw validationError("INVALID_CONFIGURATION", field, reason);
}

function exactDataRecord(value: unknown, allowedKeys: readonly string[], field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        configError(field, "must be a plain object");
    }
    if (utilTypes.isProxy(value)) {
        configError(field, "cannot be a Proxy");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        configError(field, "must be a plain object");
    }
    const allowed = new Set(allowedKeys);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowed.has(key)) {
            configError(field, `contains unsupported key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            configError(`${field}.${key}`, "must be an enumerable data property");
        }
    }
    return value as Record<string, unknown>;
}

function resolveCache(value: unknown): ResolvedPermissionCoreOptions["cache"] {
    if (value === undefined) {
        return Object.freeze({ enabled: false });
    }
    const record = exactDataRecord(value, ["enabled", "ttlMs", "consistency"], "cache");
    if (typeof record.enabled !== "boolean") {
        configError("cache.enabled", "must be explicitly true or false");
    }
    if (!record.enabled) {
        if (Object.hasOwn(record, "ttlMs") || Object.hasOwn(record, "consistency")) {
            configError("cache", "disabled cache cannot declare ttlMs or consistency");
        }
        return Object.freeze({ enabled: false });
    }
    if (record.consistency !== "ordered-bounded-stale") {
        configError("cache.consistency", "must be ordered-bounded-stale when cache is enabled");
    }
    const ttlMs = record.ttlMs ?? DEFAULT_PERMISSION_CACHE_TTL_MS;
    if (!Number.isInteger(ttlMs) || (ttlMs as number) < 100 || (ttlMs as number) > 86_400_000) {
        configError("cache.ttlMs", "must be an integer between 100 and 86400000");
    }
    return Object.freeze({
        enabled: true,
        ttlMs: ttlMs as number,
        consistency: "ordered-bounded-stale" as const,
    });
}

function resolveTokenSecret(value: unknown) {
    if (value === undefined) {
        return { bytes: new Uint8Array(randomBytes(32)), source: "ephemeral" as const };
    }
    if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
        configError("tokenSecret", "cannot be a Proxy");
    }
    if (typeof value !== "string" && !(value instanceof Uint8Array)) {
        configError("tokenSecret", "must be a string or Uint8Array");
    }
    if (typeof value === "string" && !isWellFormedUnicode(value)) {
        configError("tokenSecret", "cannot contain an unpaired UTF-16 surrogate");
    }
    const bytes = typeof value === "string"
        ? new Uint8Array(Buffer.from(value, "utf8"))
        : new Uint8Array(value);
    if (bytes.byteLength < 32) {
        configError("tokenSecret", "must contain at least 32 bytes");
    }
    return { bytes, source: "configured" as const };
}

function snapshotConfigurationArray(value: unknown, field: string, maxItems: number) {
    if (!Array.isArray(value)) {
        configError(field, "must be an array");
    }
    if (utilTypes.isProxy(value)) {
        configError(field, "cannot be a Proxy");
    }
    const length = (Object.getOwnPropertyDescriptor(value, "length") as PropertyDescriptor).value as number;
    if (length > maxItems) {
        configError(field, `cannot contain more than ${maxItems} items`);
    }

    const snapshot = new Array<unknown>(length);
    let indexCount = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") {
            continue;
        }
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            configError(field, "cannot contain non-index array properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            configError(`${field}[${key}]`, "must be an enumerable data property");
        }
        snapshot[Number(key)] = descriptor.value;
        indexCount += 1;
    }
    if (indexCount !== length) {
        configError(field, "cannot be a sparse array");
    }
    return snapshot;
}

export function resolvePermissionCoreOptions(options: PermissionCoreOptions): ResolvedPermissionCoreOptions {
    const record = exactDataRecord(options, [
        "monsqlize",
        "collectionPrefix",
        "cache",
        "closeDrainTimeoutMs",
        "tokenSecret",
        "resourceSchemes",
    ], "options");

    if (record.monsqlize === null || (typeof record.monsqlize !== "object" && typeof record.monsqlize !== "function")) {
        configError("monsqlize", "is required and must be a MonSQLize instance");
    }

    const collectionPrefix = record.collectionPrefix ?? DEFAULT_COLLECTION_PREFIX;
    if (typeof collectionPrefix !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(collectionPrefix)) {
        configError("collectionPrefix", "must match ^[A-Za-z_][A-Za-z0-9_-]{0,63}$");
    }

    const closeDrainTimeoutMs = record.closeDrainTimeoutMs ?? DEFAULT_CLOSE_DRAIN_TIMEOUT_MS;
    if (!Number.isInteger(closeDrainTimeoutMs) || (closeDrainTimeoutMs as number) < 1_000 || (closeDrainTimeoutMs as number) > 300_000) {
        configError("closeDrainTimeoutMs", "must be an integer between 1000 and 300000");
    }

    const resourceSchemes = snapshotConfigurationArray(
        record.resourceSchemes ?? [],
        "resourceSchemes",
        32,
    ) as ResourceSchemeDefinition[];
    const tokenSecret = resolveTokenSecret(record.tokenSecret);

    return Object.freeze({
        monsqlize: record.monsqlize as MonSQLizeInstance,
        collectionPrefix,
        usesDefaultCollectionPrefix: collectionPrefix === DEFAULT_COLLECTION_PREFIX,
        cache: resolveCache(record.cache),
        closeDrainTimeoutMs: closeDrainTimeoutMs as number,
        tokenSecret: tokenSecret.bytes,
        tokenKeySource: tokenSecret.source,
        resourceSchemes: Object.freeze(resourceSchemes) as readonly ResourceSchemeDefinition[],
    });
}
