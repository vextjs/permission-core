import { types as utilTypes } from "node:util";
import type { MonSQLizeInstance } from "monsqlize";
import MonSQLize from "monsqlize";
import type { AuthorizedCollectionOptions, PermissionCoreOptions } from "../../types";
import {
    isPermissionCoreError,
    PermissionCoreError,
} from "../../core/errors";
import { normalizeDataPath, pathsOverlap } from "../../data/path";
import { normalizeDeclaredPath } from "../../menu/validation";
import type { VextPluginContext } from "vextjs";
import type {
    PermissionVextDataOptions,
    PermissionVextPluginOptions,
} from "./types";

const OPTION_KEYS = [
    "monsqlize",
    "resolveMonSQLize",
    "databasePlugin",
    "authPlugin",
    "routes",
    "core",
    "subject",
    "data",
    "resolveSubject",
] as const;
const SUBJECT_OPTION_KEYS = ["resolve"] as const;
const ROUTE_DEFAULT_OPTION_KEYS = ["protect", "public"] as const;
const DATA_OPTION_KEYS = ["exposeAs", "transparent", "scopeFields", "collections"] as const;
const DATA_COLLECTION_OPTION_KEYS = ["resource", "scopeFields"] as const;
const SCOPE_FIELD_KEYS = ["tenantId", "appId", "moduleId", "namespace"] as const;
const CORE_OPTION_KEYS = [
    "collectionPrefix",
    "cache",
    "closeDrainTimeoutMs",
    "tokenSecret",
    "resourceSchemes",
] as const;
const CACHE_OPTION_KEYS = ["enabled", "ttlMs", "consistency"] as const;
const MONSQLIZE_CAPABILITIES = [
    "health",
    "getDefaults",
    "collection",
    "db",
    "withTransaction",
] as const;
const PLUGIN_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const DB_RESOURCE = /^db:[A-Za-z_-][A-Za-z0-9_-]{0,63}$/u;
const MAX_DATA_COLLECTION_OVERRIDES = 128;
const MAX_ROUTE_DEFAULT_PATTERNS = 128;
const MAX_ROUTE_DEFAULT_PATTERN_BYTES = 1024;

export interface ResolvedPermissionVextPluginOptions {
    readonly monsqlize?: MonSQLizeInstance;
    readonly resolveMonSQLize?: NonNullable<PermissionVextPluginOptions["resolveMonSQLize"]>;
    readonly databasePlugin?: string;
    readonly authPlugin: string;
    readonly routes: ResolvedPermissionVextRouteDefaultsOptions;
    readonly dependencies: readonly string[];
    readonly core: Omit<PermissionCoreOptions, "monsqlize">;
    readonly resolveSubject?: NonNullable<PermissionVextPluginOptions["resolveSubject"]>;
    readonly data?: ResolvedPermissionVextDataOptions;
}

export interface ResolvedPermissionVextDataCollectionOptions {
    readonly resource?: string;
    readonly scopeFields?: AuthorizedCollectionOptions["scopeFields"];
}

export interface ResolvedPermissionVextDataOptions {
    readonly exposeAs?: false | "monsqlize" | "db";
    readonly transparent: boolean;
    readonly scopeFields: AuthorizedCollectionOptions["scopeFields"];
    readonly collections: Readonly<Record<string, ResolvedPermissionVextDataCollectionOptions>>;
}

export interface ResolvedPermissionVextRoutePattern {
    readonly kind: "exact" | "prefix";
    readonly value: string;
}

export interface ResolvedPermissionVextRouteDefaultsOptions {
    readonly protect: readonly ResolvedPermissionVextRoutePattern[];
    readonly public: readonly ResolvedPermissionVextRoutePattern[];
}

function configurationError(field: string, reason: string, cause?: unknown) {
    return new PermissionCoreError("INVALID_CONFIGURATION", `Invalid ${field}: ${reason}.`, {
        details: { kind: "validation", field, reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function dataRecord(value: unknown, field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
        throw configurationError(field, "must be a non-Proxy plain object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw configurationError(field, "must be a plain object");
    }
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
            throw configurationError(field, "cannot contain symbol keys");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw configurationError(`${field}.${key}`, "must be an enumerable defined data property");
        }
        copy[key] = descriptor.value;
    }
    return copy;
}

function exactRecord(value: unknown, allowed: readonly string[], field: string) {
    const record = dataRecord(value, field);
    const unsupported = Object.keys(record).find((key) => !allowed.includes(key));
    if (unsupported) {
        throw configurationError(`${field}.${unsupported}`, "is not supported");
    }
    return record;
}

function dataArray(value: unknown, field: string, maximum: number) {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        throw configurationError(field, "must be a non-Proxy dense array");
    }
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
        throw configurationError(field, `must contain 0..${maximum} items`);
    }
    const copy = new Array<unknown>(length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            throw configurationError(field, "cannot contain non-index properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw configurationError(`${field}[${key}]`, "must be an enumerable defined data property");
        }
        copy[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== length) {
        throw configurationError(field, "cannot be sparse");
    }
    return Object.freeze(copy);
}

function pluginName(value: unknown, field: string) {
    if (typeof value !== "string" || !PLUGIN_NAME.test(value)) {
        throw configurationError(field, "must match the Vext plugin name grammar");
    }
    return value;
}

function routePattern(value: unknown, field: string): ResolvedPermissionVextRoutePattern {
    if (
        typeof value !== "string"
        || !value.startsWith("/")
        || !value
        || Buffer.byteLength(value, "utf8") > MAX_ROUTE_DEFAULT_PATTERN_BYTES
        || /[\u0000-\u001f\u007f?#]/u.test(value)
    ) {
        throw configurationError(field, "must be an absolute route path or prefix pattern");
    }
    if (value === "/**") {
        return Object.freeze({ kind: "prefix", value: "/" });
    }
    if (value.endsWith("/**")) {
        const prefix = value.slice(0, -3);
        if (!prefix || prefix.endsWith("/")) {
            throw configurationError(field, "must use a non-empty prefix before /**");
        }
        try {
            return Object.freeze({ kind: "prefix", value: normalizeDeclaredPath(prefix, field) });
        } catch (cause) {
            throw configurationError(field, "must contain a valid route prefix before /**", cause);
        }
    }
    if (value.includes("*")) {
        throw configurationError(field, "only a trailing /** wildcard is supported");
    }
    try {
        return Object.freeze({ kind: "exact", value: normalizeDeclaredPath(value, field) });
    } catch (cause) {
        throw configurationError(field, "must be a valid route path", cause);
    }
}

function routePatternArray(value: unknown, field: string) {
    return dataArray(value, field, MAX_ROUTE_DEFAULT_PATTERNS)
        .map((entry, index) => routePattern(entry, `${field}[${index}]`));
}

function snapshotRouteDefaults(value: unknown): ResolvedPermissionVextRouteDefaultsOptions {
    const input = exactRecord(value, ROUTE_DEFAULT_OPTION_KEYS, "options.routes");
    return Object.freeze({
        protect: Object.freeze(Object.hasOwn(input, "protect")
            ? routePatternArray(input.protect, "options.routes.protect")
            : []),
        public: Object.freeze(Object.hasOwn(input, "public")
            ? routePatternArray(input.public, "options.routes.public")
            : []),
    });
}

function assertNoScopePathOverlap(scopeFields: AuthorizedCollectionOptions["scopeFields"], field: string) {
    const paths = Object.values(scopeFields);
    for (let left = 0; left < paths.length; left += 1) {
        for (let right = left + 1; right < paths.length; right += 1) {
            if (pathsOverlap(paths[left], paths[right])) {
                throw configurationError(field, `contains overlapping paths ${paths[left]} and ${paths[right]}`);
            }
        }
    }
}

function snapshotScopeFields(value: unknown, field: string): AuthorizedCollectionOptions["scopeFields"] {
    const input = exactRecord(value, SCOPE_FIELD_KEYS, field);
    if (!Object.hasOwn(input, "tenantId")) {
        throw configurationError(`${field}.tenantId`, "is required");
    }
    const output: Partial<Record<typeof SCOPE_FIELD_KEYS[number], string>> = {};
    for (const key of SCOPE_FIELD_KEYS) {
        if (!Object.hasOwn(input, key)) continue;
        try {
            output[key] = normalizeDataPath(input[key], `${field}.${key}`);
        } catch (cause) {
            throw configurationError(`${field}.${key}`, "must be a safe data path", cause);
        }
    }
    const frozen = Object.freeze(output) as AuthorizedCollectionOptions["scopeFields"];
    assertNoScopePathOverlap(frozen, field);
    return frozen;
}

function snapshotDataCollectionOptions(
    value: unknown,
    field: string,
): ResolvedPermissionVextDataCollectionOptions {
    const input = exactRecord(value, DATA_COLLECTION_OPTION_KEYS, field);
    const copy: {
        resource?: string;
        scopeFields?: AuthorizedCollectionOptions["scopeFields"];
    } = {};
    if (Object.hasOwn(input, "resource")) {
        if (typeof input.resource !== "string" || !DB_RESOURCE.test(input.resource)) {
            throw configurationError(`${field}.resource`, "must be an exact built-in db:<logical-resource> base resource");
        }
        copy.resource = input.resource;
    }
    if (Object.hasOwn(input, "scopeFields")) {
        copy.scopeFields = snapshotScopeFields(input.scopeFields, `${field}.scopeFields`);
    }
    return Object.freeze(copy);
}

function snapshotDataOptions(value: unknown): ResolvedPermissionVextDataOptions {
    const input = exactRecord(value, DATA_OPTION_KEYS, "options.data");
    if (!Object.hasOwn(input, "scopeFields")) {
        throw configurationError("options.data.scopeFields", "is required when data is enabled");
    }
    const exposeAs = Object.hasOwn(input, "exposeAs") ? input.exposeAs : undefined;
    if (exposeAs !== undefined && exposeAs !== false && exposeAs !== "monsqlize" && exposeAs !== "db") {
        throw configurationError("options.data.exposeAs", "must be false, 'monsqlize', or 'db'");
    }
    const transparent = Object.hasOwn(input, "transparent") ? input.transparent : false;
    if (typeof transparent !== "boolean") {
        throw configurationError("options.data.transparent", "must be a boolean");
    }
    const collections: Record<string, ResolvedPermissionVextDataCollectionOptions> = {};
    if (Object.hasOwn(input, "collections")) {
        const collectionInput = dataRecord(input.collections, "options.data.collections");
        const names = Object.keys(collectionInput);
        if (names.length > MAX_DATA_COLLECTION_OVERRIDES) {
            throw configurationError("options.data.collections", `must contain at most ${MAX_DATA_COLLECTION_OVERRIDES} entries`);
        }
        for (const name of names) {
            if (name === "__proto__" || name === "prototype" || name === "constructor") {
                throw configurationError("options.data.collections", `contains unsupported key ${name}`);
            }
            collections[name] = snapshotDataCollectionOptions(
                collectionInput[name],
                `options.data.collections.${name}`,
            );
        }
    }
    return Object.freeze({
        ...(exposeAs === undefined ? {} : { exposeAs: exposeAs as false | "monsqlize" | "db" }),
        transparent,
        scopeFields: snapshotScopeFields(input.scopeFields, "options.data.scopeFields"),
        collections: Object.freeze(collections),
    });
}

function snapshotCoreOptions(value: unknown): Omit<PermissionCoreOptions, "monsqlize"> {
    const input = exactRecord(value, CORE_OPTION_KEYS, "options.core");
    const copy: Record<string, unknown> = { ...input };
    if (Object.hasOwn(input, "cache")) {
        copy.cache = Object.freeze(exactRecord(input.cache, CACHE_OPTION_KEYS, "options.core.cache"));
    }
    if (Object.hasOwn(input, "tokenSecret") && typeof input.tokenSecret === "object" && input.tokenSecret !== null) {
        if (utilTypes.isProxy(input.tokenSecret)) {
            throw configurationError("options.core.tokenSecret", "cannot be a Proxy");
        }
        if (input.tokenSecret instanceof Uint8Array) {
            copy.tokenSecret = new Uint8Array(input.tokenSecret);
        }
    }
    if (Object.hasOwn(input, "resourceSchemes")) {
        copy.resourceSchemes = Object.freeze(
            dataArray(input.resourceSchemes, "options.core.resourceSchemes", 32).map((value, index) => {
                const field = `options.core.resourceSchemes[${index}]`;
                const definition = exactRecord(value, ["scheme", "version", "probes", "validate", "match"], field);
                const probes = dataArray(definition.probes, `${field}.probes`, 16).map((probe, probeIndex) =>
                    Object.freeze(exactRecord(
                        probe,
                        ["pattern", "resource", "expected"],
                        `${field}.probes[${probeIndex}]`,
                    )));
                return Object.freeze({
                    scheme: definition.scheme,
                    version: definition.version,
                    probes: Object.freeze(probes),
                    validate: definition.validate,
                    match: definition.match,
                });
            }),
        );
    }
    return Object.freeze(copy) as Omit<PermissionCoreOptions, "monsqlize">;
}

export function resolvePermissionVextPluginOptions(
    value?: PermissionVextPluginOptions,
): ResolvedPermissionVextPluginOptions {
    const input = exactRecord(value === undefined ? {} : value, OPTION_KEYS, "options");
    if (Object.hasOwn(input, "monsqlize") && Object.hasOwn(input, "resolveMonSQLize")) {
        throw configurationError("options", "monsqlize and resolveMonSQLize are mutually exclusive");
    }
    if (Object.hasOwn(input, "subject") && Object.hasOwn(input, "resolveSubject")) {
        throw configurationError("options", "subject.resolve and resolveSubject are mutually exclusive");
    }
    if (
        Object.hasOwn(input, "monsqlize")
        && (input.monsqlize === null || (typeof input.monsqlize !== "object" && typeof input.monsqlize !== "function"))
    ) {
        throw configurationError("options.monsqlize", "must be a MonSQLize instance");
    }
    if (Object.hasOwn(input, "monsqlize") && utilTypes.isProxy(input.monsqlize)) {
        throw configurationError("options.monsqlize", "cannot be a Proxy");
    }
    for (const key of ["resolveMonSQLize", "resolveSubject"] as const) {
        if (Object.hasOwn(input, key) && typeof input[key] !== "function") {
            throw configurationError(`options.${key}`, "must be a function");
        }
    }
    let subjectResolver: PermissionVextPluginOptions["resolveSubject"];
    if (Object.hasOwn(input, "subject")) {
        const subject = exactRecord(input.subject, SUBJECT_OPTION_KEYS, "options.subject");
        if (typeof subject.resolve !== "function") {
            throw configurationError("options.subject.resolve", "must be a function");
        }
        const resolve = subject.resolve as NonNullable<PermissionVextPluginOptions["subject"]>["resolve"];
        subjectResolver = (_auth, req) => resolve(req);
    } else if (Object.hasOwn(input, "resolveSubject")) {
        subjectResolver = input.resolveSubject as NonNullable<PermissionVextPluginOptions["resolveSubject"]>;
    }
    const databasePlugin = Object.hasOwn(input, "databasePlugin")
        ? pluginName(input.databasePlugin, "options.databasePlugin")
        : undefined;
    const authPlugin = Object.hasOwn(input, "authPlugin")
        ? pluginName(input.authPlugin, "options.authPlugin")
        : "authentication";
    const dependencies = Object.freeze([...new Set([
        ...(databasePlugin === undefined ? [] : [databasePlugin]),
        authPlugin,
    ])]);
    return Object.freeze({
        ...(Object.hasOwn(input, "monsqlize") ? { monsqlize: input.monsqlize as MonSQLizeInstance } : {}),
        ...(Object.hasOwn(input, "resolveMonSQLize")
            ? { resolveMonSQLize: input.resolveMonSQLize as NonNullable<PermissionVextPluginOptions["resolveMonSQLize"]> }
            : {}),
        ...(databasePlugin === undefined ? {} : { databasePlugin }),
        authPlugin,
        routes: Object.hasOwn(input, "routes")
            ? snapshotRouteDefaults(input.routes)
            : Object.freeze({ protect: Object.freeze([]), public: Object.freeze([]) }),
        dependencies,
        core: Object.hasOwn(input, "core") ? snapshotCoreOptions(input.core) : Object.freeze({}),
        ...(subjectResolver === undefined ? {} : { resolveSubject: subjectResolver }),
        ...(Object.hasOwn(input, "data") ? { data: snapshotDataOptions(input.data) } : {}),
    });
}

function monsqlizeRequired(reason: string) {
    return new PermissionCoreError("VEXT_MONSQLIZE_REQUIRED", "Vext permission plugin requires a host-owned MonSQLize 3.1.0 instance.", {
        details: { kind: "validation", field: "monsqlize", reason },
    });
}

function monsqlizeIncompatible(reason: string, cause?: unknown) {
    return new PermissionCoreError("VEXT_MONSQLIZE_INCOMPATIBLE", "The resolved Vext MonSQLize instance is incompatible with permission-core.", {
        details: { kind: "validation", field: "monsqlize", reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function assertCandidate(value: unknown, field: string, requireCache: boolean) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        throw monsqlizeIncompatible(`${field} did not return an object instance`);
    }
    if (utilTypes.isProxy(value)) {
        throw monsqlizeIncompatible(`${field} returned a Proxy`);
    }
    const capabilities = requireCache
        ? [...MONSQLIZE_CAPABILITIES, "getCache"] as const
        : MONSQLIZE_CAPABILITIES;
    for (const capability of capabilities) {
        let owner: object | null = value as object;
        let found = false;
        while (owner !== null) {
            if (utilTypes.isProxy(owner)) {
                throw monsqlizeIncompatible(`${field}.${capability} has a Proxy in its prototype chain`);
            }
            const descriptor = Object.getOwnPropertyDescriptor(owner, capability);
            if (descriptor) {
                if (!("value" in descriptor) || typeof descriptor.value !== "function") {
                    throw monsqlizeIncompatible(`${field}.${capability} must be a data method`);
                }
                found = true;
                break;
            }
            owner = Object.getPrototypeOf(owner);
        }
        if (!found) {
            throw monsqlizeIncompatible(`${field}.${capability} is required`);
        }
    }
    return value as MonSQLizeInstance;
}

export async function resolvePluginMonSQLize(
    app: VextPluginContext,
    options: ResolvedPermissionVextPluginOptions,
) {
    const requireCache = options.core.cache?.enabled === true;
    if (options.monsqlize) return assertCandidate(options.monsqlize, "options.monsqlize", requireCache);
    if (options.resolveMonSQLize) {
        try {
            return assertCandidate(await options.resolveMonSQLize(app), "options.resolveMonSQLize", requireCache);
        } catch (cause) {
            if (isPermissionCoreError(cause) && cause.code === "VEXT_MONSQLIZE_INCOMPATIBLE") {
                throw cause;
            }
            throw monsqlizeIncompatible("options.resolveMonSQLize failed", cause);
        }
    }
    const descriptor = Object.getOwnPropertyDescriptor(app, "monsqlize");
    if (!descriptor) {
        throw monsqlizeRequired("app.monsqlize is missing");
    }
    if (!("value" in descriptor) || descriptor.value === undefined) {
        throw monsqlizeIncompatible("app.monsqlize must be an own data property");
    }
    try {
        if (utilTypes.isProxy(descriptor.value)) {
            throw monsqlizeIncompatible("app.monsqlize cannot be a Proxy");
        }
        if (!(descriptor.value instanceof MonSQLize)) {
            throw monsqlizeIncompatible("app.monsqlize does not share the required MonSQLize 3.1.0 constructor identity");
        }
    } catch (cause) {
        if (isPermissionCoreError(cause)) throw cause;
        throw monsqlizeIncompatible("app.monsqlize constructor identity could not be verified", cause);
    }
    return descriptor.value as MonSQLizeInstance;
}
