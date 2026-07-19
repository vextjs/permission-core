import { types as utilTypes } from "node:util";
import type {
    ApiAuthorization,
    ApiBindingCreateInput,
    PermissionAction,
} from "../../types";
import type { VextRouteHookInfo } from "vextjs";
import { ResourceSchemeRegistry } from "../../check/resource-schemes";
import { PermissionCoreError } from "../../core/errors";
import {
    canonicalByteLength,
    compareUtf8,
    digestCanonical,
} from "../../internal/canonical";
import { deepFreeze } from "../../internal/plain-data";
import { isWellFormedUnicode } from "../../internal/unicode";
import { normalizeDeclaredPath } from "../../menu/validation";
import { normalizePermissionAction } from "../../policy/action";
import type {
    VextRoutePermission,
    VextRoutePermissionManifest,
    VextRouteManifestEntry,
} from "./types";

const MAX_ROUTE_COUNT = 20_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_REQUIREMENTS = 32;
const MAX_SOURCE_FILE_BYTES = 4096;
const HTTP_METHOD = /^[A-Z][A-Z0-9-]{0,31}$/u;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;

interface RuntimeRequirement {
    readonly action: PermissionAction;
    readonly resource: string;
}

export interface VextRouteRuntimeContract {
    readonly routeKey: string;
    readonly contractDigest: string;
    readonly method: string;
    readonly path: string;
    readonly authorization: ApiAuthorization | null;
    readonly evaluation: null | {
        readonly mode: "all" | "any";
        readonly requirements: readonly RuntimeRequirement[];
    };
}

export interface VextRouteSnapshot {
    readonly manifest: VextRoutePermissionManifest;
    readonly apiBindings: readonly ApiBindingCreateInput[];
    readonly contracts: ReadonlyMap<string, VextRouteRuntimeContract>;
}

function readonlyMapView<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
    const view = {
        size: source.size,
        get: (key: K) => source.get(key),
        has: (key: K) => source.has(key),
        entries: () => source.entries(),
        keys: () => source.keys(),
        values: () => source.values(),
        forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
            for (const [key, value] of source) {
                callback.call(thisArg, value, key, view);
            }
        },
        [Symbol.iterator]: () => source[Symbol.iterator](),
    } satisfies ReadonlyMap<K, V>;
    return Object.freeze(view);
}

function invalidRoute(field: string, reason: string, cause?: unknown): PermissionCoreError {
    return new PermissionCoreError(
        "VEXT_ROUTE_PERMISSION_INVALID",
        `Invalid Vext route permission at ${field}: ${reason}.`,
        {
            details: { kind: "validation", field, reason },
            ...(cause === undefined ? {} : { cause }),
        },
    );
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
        throw invalidRoute(field, "must be a non-Proxy plain object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw invalidRoute(field, "must be a plain object");
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
            throw invalidRoute(field, "cannot contain symbol keys");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw invalidRoute(`${field}.${key}`, "must be an enumerable defined data property");
        }
    }
    return value as Record<string, unknown>;
}

function exactRecord(value: unknown, allowed: readonly string[], field: string) {
    const record = plainRecord(value, field);
    const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
    if (unexpected !== undefined) {
        throw invalidRoute(`${field}.${unexpected}`, "is not supported");
    }
    return record;
}

function denseArray(value: unknown, field: string, maximum: number): readonly unknown[] {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        throw invalidRoute(field, "must be a non-Proxy dense array");
    }
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
        throw invalidRoute(field, `must contain 0..${maximum} items`);
    }
    const copy = new Array<unknown>(length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            throw invalidRoute(field, "cannot contain non-index properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw invalidRoute(`${field}[${key}]`, "must be an enumerable defined data property");
        }
        copy[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== length) {
        throw invalidRoute(field, "cannot be sparse");
    }
    return copy;
}

function normalizeMethod(value: unknown, field: string) {
    if (typeof value !== "string" || !isWellFormedUnicode(value)) {
        throw invalidRoute(field, "must be a well-formed string");
    }
    const method = value.toUpperCase();
    if (!HTTP_METHOD.test(method)) {
        throw invalidRoute(field, "does not match the HTTP method grammar");
    }
    return method;
}

function normalizePath(value: unknown, field: string) {
    try {
        return normalizeDeclaredPath(value, field);
    } catch (cause) {
        throw invalidRoute(field, "does not match the declared route path grammar", cause);
    }
}

function normalizeSourceFile(value: unknown, field: string) {
    if (
        typeof value !== "string"
        || !value
        || !isWellFormedUnicode(value)
        || Buffer.byteLength(value, "utf8") > MAX_SOURCE_FILE_BYTES
        || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
        throw invalidRoute(field, `must be a non-empty path label of at most ${MAX_SOURCE_FILE_BYTES} UTF-8 bytes`);
    }
    return value;
}

function normalizeAction(value: unknown, field: string) {
    try {
        return normalizePermissionAction(value);
    } catch (cause) {
        throw invalidRoute(field, "does not match the permission action grammar", cause);
    }
}

function validateExplicitResource(
    schemes: ResourceSchemeRegistry,
    value: unknown,
    field: string,
) {
    if (typeof value !== "string") {
        throw invalidRoute(field, "must be a string");
    }
    try {
        schemes.validate(value, "resource");
    } catch (cause) {
        throw invalidRoute(field, "must be a concrete permission resource", cause);
    }
    return value;
}

function normalizeRequirement(
    value: unknown,
    defaultResource: string,
    schemes: ResourceSchemeRegistry,
    field: string,
): RuntimeRequirement {
    const input = exactRecord(value, ["action", "resource"], field);
    if (!Object.hasOwn(input, "action")) {
        throw invalidRoute(`${field}.action`, "is required");
    }
    return deepFreeze({
        action: normalizeAction(input.action, `${field}.action`),
        resource: !Object.hasOwn(input, "resource")
            ? defaultResource
            : validateExplicitResource(schemes, input.resource, `${field}.resource`),
    });
}

function normalizeRoutePermission(
    value: VextRoutePermission | undefined,
    defaultResource: string,
    schemes: ResourceSchemeRegistry,
    field: string,
) {
    if (value === undefined || value === false) {
        return null;
    }

    let mode: "all" | "any" = "all";
    let requirements: RuntimeRequirement[];
    if (value === true) {
        requirements = [deepFreeze({
            action: "invoke",
            resource: defaultResource,
        })];
    } else {
        const input = plainRecord(value, field);
        const aggregate = Object.hasOwn(input, "mode") || Object.hasOwn(input, "requirements");
        if (!aggregate) {
            requirements = [normalizeRequirement(input, defaultResource, schemes, field)];
        } else {
            const group = exactRecord(input, ["mode", "requirements"], field);
            if ((group.mode !== "all" && group.mode !== "any") || !Object.hasOwn(group, "requirements")) {
                throw invalidRoute(field, "requires mode all/any and requirements");
            }
            mode = group.mode;
            const values = denseArray(group.requirements, `${field}.requirements`, MAX_REQUIREMENTS);
            if (values.length === 0) {
                throw invalidRoute(`${field}.requirements`, "must contain 1..32 requirements");
            }
            requirements = values.map((entry, index) => normalizeRequirement(
                entry,
                defaultResource,
                schemes,
                `${field}.requirements[${index}]`,
            ));
        }
    }

    const unique = new Map<string, RuntimeRequirement>();
    for (const requirement of requirements) {
        const key = digestCanonical(requirement);
        if (!unique.has(key)) unique.set(key, requirement);
    }
    const normalizedRequirements = Object.freeze([...unique.values()]);
    const uniquePermissions = new Map(normalizedRequirements.map(({ action, resource }) => {
        const permission = deepFreeze({ action, resource });
        return [digestCanonical(permission), permission] as const;
    }));
    const permissions = Object.freeze(
        [...uniquePermissions.entries()]
            .sort(([left], [right]) => compareUtf8(left, right))
            .map(([, permission]) => permission),
    );
    return deepFreeze({
        authorization: deepFreeze({ mode, permissions }) as ApiAuthorization,
        evaluation: deepFreeze({ mode, requirements: normalizedRequirements }),
    });
}

function readPermissionOption(route: Record<string, unknown>, field: string) {
    const options = route.options;
    if (options === undefined) return undefined;
    const record = plainRecord(options, `${field}.options`);
    if (!Object.hasOwn(record, "permission")) return undefined;
    return record.permission as VextRoutePermission;
}

function portableEntry(entry: Pick<VextRouteManifestEntry, "routeKey" | "method" | "path" | "authorization">) {
    return deepFreeze({
        routeKey: entry.routeKey,
        method: entry.method,
        path: entry.path,
        authorization: entry.authorization,
    });
}

function compareRoutes(
    left: Pick<VextRouteManifestEntry, "method" | "path">,
    right: Pick<VextRouteManifestEntry, "method" | "path">,
) {
    return compareUtf8(`${left.method}\u0000${left.path}`, `${right.method}\u0000${right.path}`);
}

function normalizeRoute(
    value: unknown,
    schemes: ResourceSchemeRegistry,
    field: string,
): { entry: VextRouteManifestEntry; contract: VextRouteRuntimeContract } {
    const route = plainRecord(value, field);
    const method = normalizeMethod(route.method, `${field}.method`);
    const path = normalizePath(route.path, `${field}.path`);
    const defaultResource = `${method}:${path}`;
    try {
        schemes.validate(defaultResource, "pattern");
    } catch (cause) {
        throw invalidRoute(`${field}.path`, "cannot form a valid route permission resource", cause);
    }
    const routeKey = digestCanonical({ method, path });
    const permission = normalizeRoutePermission(
        readPermissionOption(route, field),
        defaultResource,
        schemes,
        `${field}.options.permission`,
    );
    const entry = deepFreeze({
        routeKey,
        method,
        path,
        authorization: permission?.authorization ?? null,
        ...(Object.hasOwn(route, "sourceFile")
            ? { sourceFile: normalizeSourceFile(route.sourceFile, `${field}.sourceFile`) }
            : {}),
    });
    const contractDigest = digestCanonical(portableEntry(entry));
    return {
        entry,
        contract: deepFreeze({
            routeKey,
            contractDigest,
            method,
            path,
            authorization: entry.authorization,
            evaluation: permission?.evaluation ?? null,
        }),
    };
}

function assertByteLimit(value: unknown, field: string) {
    try {
        canonicalByteLength(value, MAX_MANIFEST_BYTES);
    } catch (cause) {
        throw invalidRoute(field, `exceeds ${MAX_MANIFEST_BYTES} canonical UTF-8 bytes`, cause);
    }
}

function cloneManifestPermission(value: unknown, field: string): ApiAuthorization {
    const input = exactRecord(value, ["mode", "permissions"], field);
    if ((input.mode !== "all" && input.mode !== "any") || !Object.hasOwn(input, "permissions")) {
        throw invalidRoute(field, "requires mode all/any and permissions");
    }
    const values = denseArray(input.permissions, `${field}.permissions`, MAX_REQUIREMENTS);
    if (values.length === 0) {
        throw invalidRoute(`${field}.permissions`, "must contain 1..32 permissions");
    }
    const permissions = values.map((value, index) => {
        const permission = exactRecord(value, ["action", "resource"], `${field}.permissions[${index}]`);
        if (!Object.hasOwn(permission, "action") || !Object.hasOwn(permission, "resource")) {
            throw invalidRoute(`${field}.permissions[${index}]`, "requires action and resource");
        }
        const action = normalizeAction(permission.action, `${field}.permissions[${index}].action`);
        if (
            typeof permission.resource !== "string"
            || !permission.resource
            || !isWellFormedUnicode(permission.resource)
            || Buffer.byteLength(permission.resource, "utf8") > 1024
        ) {
            throw invalidRoute(`${field}.permissions[${index}].resource`, "must be a non-empty resource of at most 1024 UTF-8 bytes");
        }
        return deepFreeze({ action, resource: permission.resource });
    });
    const unique = new Map(permissions.map((permission) => [digestCanonical(permission), permission]));
    return deepFreeze({
        mode: input.mode,
        permissions: Object.freeze([...unique.entries()]
            .sort(([left], [right]) => compareUtf8(left, right))
            .map(([, permission]) => permission)),
    });
}

function normalizeManifest(value: VextRoutePermissionManifest): VextRoutePermissionManifest {
    const input = exactRecord(value, ["schemaVersion", "digest", "routes"], "manifest");
    if (input.schemaVersion !== 1 || typeof input.digest !== "string" || !DIGEST.test(input.digest)) {
        throw invalidRoute("manifest", "requires schemaVersion 1 and a canonical digest");
    }
    const routes = denseArray(input.routes, "manifest.routes", MAX_ROUTE_COUNT).map((value, index) => {
        const route = exactRecord(
            value,
            ["routeKey", "method", "path", "authorization", "sourceFile"],
            `manifest.routes[${index}]`,
        );
        const method = normalizeMethod(route.method, `manifest.routes[${index}].method`);
        const path = normalizePath(route.path, `manifest.routes[${index}].path`);
        if (method !== route.method || path !== route.path) {
            throw invalidRoute(`manifest.routes[${index}]`, "method and path must already be canonical");
        }
        const routeKey = digestCanonical({ method, path });
        if (route.routeKey !== routeKey) {
            throw invalidRoute(`manifest.routes[${index}].routeKey`, "does not match method/path");
        }
        return deepFreeze({
            routeKey,
            method,
            path,
            authorization: route.authorization === null
                ? null
                : cloneManifestPermission(route.authorization, `manifest.routes[${index}].authorization`),
            ...(Object.hasOwn(route, "sourceFile")
                ? { sourceFile: normalizeSourceFile(route.sourceFile, `manifest.routes[${index}].sourceFile`) }
                : {}),
        });
    }).sort(compareRoutes);
    const duplicate = routes.find((route, index) => (
        index > 0
        && route.method === routes[index - 1]!.method
        && route.path === routes[index - 1]!.path
    ));
    if (duplicate) {
        throw invalidRoute("manifest.routes", `contains duplicate route ${duplicate.method} ${duplicate.path}`);
    }
    const portable = routes.map(portableEntry);
    const digest = digestCanonical({ schemaVersion: 1, routes: portable });
    if (digest !== input.digest) {
        throw invalidRoute("manifest.digest", "does not match the portable route projection");
    }
    const manifest = deepFreeze({
        schemaVersion: 1 as const,
        digest,
        routes: Object.freeze(routes),
    });
    assertByteLimit(manifest, "manifest");
    return manifest;
}

export function toApiBindingInputs(
    manifestInput: VextRoutePermissionManifest,
): readonly ApiBindingCreateInput[] {
    const manifest = normalizeManifest(manifestInput);
    const bindings = manifest.routes
        .filter((route) => route.authorization !== null)
        .map((route) => deepFreeze({
            id: `vext:${route.routeKey}`,
            method: route.method,
            path: route.path,
            purpose: "entry" as const,
            authorization: route.authorization as ApiAuthorization,
            owners: Object.freeze([]),
            status: "enabled" as const,
            description: `Vext route ${route.method} ${route.path}`,
        }));
    const result = Object.freeze(bindings);
    assertByteLimit(result, "apiBindings");
    return result;
}

export function buildVextRouteSnapshot(
    count: number,
    routesInput: readonly VextRouteHookInfo[],
    schemes: ResourceSchemeRegistry,
): VextRouteSnapshot {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ROUTE_COUNT) {
        throw invalidRoute("routes.count", `must be a safe integer in 0..${MAX_ROUTE_COUNT}`);
    }
    const routes = denseArray(routesInput, "routes", MAX_ROUTE_COUNT);
    if (routes.length !== count) {
        throw invalidRoute("routes.count", "does not match the route inventory length");
    }
    const normalized = routes
        .map((route, index) => normalizeRoute(route, schemes, `routes[${index}]`))
        .sort((left, right) => compareRoutes(left.entry, right.entry));
    for (let index = 1; index < normalized.length; index += 1) {
        const previous = normalized[index - 1]!.entry;
        const current = normalized[index]!.entry;
        if (previous.method === current.method && previous.path === current.path) {
            throw invalidRoute("routes", `contains duplicate route ${current.method} ${current.path}`);
        }
    }
    const entries = Object.freeze(normalized.map(({ entry }) => entry));
    const digest = digestCanonical({ schemaVersion: 1, routes: entries.map(portableEntry) });
    const manifest = deepFreeze({
        schemaVersion: 1 as const,
        digest,
        routes: entries,
    });
    assertByteLimit(manifest, "manifest");
    const apiBindings = toApiBindingInputs(manifest);
    const contracts = new Map<string, VextRouteRuntimeContract>();
    for (const { contract } of normalized) {
        contracts.set(contract.routeKey, contract);
    }
    return Object.freeze({ manifest, apiBindings, contracts: readonlyMapView(contracts) });
}

export function matchVextRouteContract(
    route: VextRouteHookInfo,
    schemes: ResourceSchemeRegistry,
) {
    return normalizeRoute(route, schemes, "route").contract;
}
