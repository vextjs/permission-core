import { AsyncLocalStorage } from "node:async_hooks";
import { types as utilTypes } from "node:util";
import type {
    ApiResource,
    AuthorizedCollection,
    AuthorizedCollectionOptions,
    PermissionAction,
    PermissionSubject,
    PolicyContext,
    SubjectPermissionContext,
    SubjectRuntimeResult,
} from "../../types";
import { PermissionCore } from "../../core/permission-core";
import {
    isPermissionCoreError,
    PermissionCoreError,
} from "../../core/errors";
import { digestCanonical } from "../../internal/canonical";
import { normalizePolicyContext, normalizeSubject } from "../../scope/scope";
import type {
    VextMiddleware,
    VextRequest,
    VextResponse,
} from "vextjs";
import {
    throwVextPermissionError,
    vextPermissionHttpStatus,
} from "./errors";
import type {
    PermissionVextRequest,
    VextRequestDataApi,
    VextRequestPermissionApi,
} from "./types";
import type { ResolvedPermissionVextDataOptions } from "./options";

const REQUEST_PERMISSION_STATE = Symbol("permission-core.vext.request-state");
const permissionStates = new WeakSet<object>();
const permissionApiOwners = new WeakMap<object, VextRequest>();
const permissionDataApiOwners = new WeakMap<object, VextRequest>();
const responseProjectionOwners = new WeakMap<object, VextRequest>();
const activeRequests = new WeakSet<object>();
const requestContext = new AsyncLocalStorage<VextRequest>();
const MAX_CONTEXTS_PER_REQUEST = 32;
const AUTH_CONTRACT_KEYS = new Set([
    "isAuthenticated",
    "permissionSubject",
    "userId",
    "scope",
    "claims",
    "permission",
]);

interface RequestPermissionState {
    resolve(): Promise<VextRequestPermissionApi>;
    bindRoute(route: ResponseProjectionRoute): void;
    getRoute(): ResponseProjectionRoute | undefined;
    filterResponse(apiResource: ApiResource, payload: unknown): Promise<SubjectRuntimeResult<unknown>>;
}

interface ResponseProjectionRoute {
    readonly routeKey: string;
    readonly contractDigest: string;
    readonly apiResource: ApiResource;
}

type SubjectResolver = (
    auth: Readonly<Record<string, unknown>>,
    req: VextRequest,
) => PermissionSubject | Promise<PermissionSubject>;

function authRequired(reason: string) {
    return new PermissionCoreError("VEXT_AUTH_REQUIRED", "An authenticated permission subject is required.", {
        details: { kind: "validation", field: "req.auth", reason },
    });
}

function invalidSubject(field: string, reason: string, cause?: unknown) {
    return new PermissionCoreError("INVALID_SUBJECT", `Invalid ${field}: ${reason}.`, {
        details: { kind: "validation", field, reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function scopeConflict(reason: string) {
    return new PermissionCoreError("SCOPE_CONFLICT", "Resolved permission subject conflicts with authenticated scope.", {
        details: { kind: "validation", field: "subject", reason },
    });
}

function extensionConflict(reason: string, cause?: unknown, field = "req.auth.permission") {
    return new PermissionCoreError("VEXT_AUTH_EXTENSION_CONFLICT", "The request auth permission extension is unavailable.", {
        details: { kind: "validation", field, reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function weakMapKey(value: unknown): object | undefined {
    return value !== null && (typeof value === "object" || typeof value === "function")
        ? value
        : undefined;
}

function requestIdOf(req: VextRequest) {
    const value = (req as { requestId?: unknown }).requestId;
    return typeof value === "string" ? value : "";
}

function projectionFailureBody(error: unknown, requestId: string) {
    if (isPermissionCoreError(error)) {
        const status = vextPermissionHttpStatus(error);
        return {
            status,
            body: {
                code: error.code,
                message: status === 500 ? "Internal Server Error" : error.message,
                retryable: error.retryable,
                ...(error.details === undefined ? {} : { details: error.details }),
                ...(error.committed === undefined ? {} : { committed: error.committed }),
                ...(error.operationId === undefined ? {} : { operationId: error.operationId }),
                requestId,
            },
        };
    }
    return {
        status: 500,
        body: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal Server Error",
            retryable: false,
            requestId,
        },
    };
}

function setNoStore(res: VextResponse) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
}

function requestDataProperty(req: VextRequest, key: PropertyKey) {
    if (utilTypes.isProxy(req)) {
        throw invalidSubject("req", "cannot be a Proxy");
    }
    const descriptor = Object.getOwnPropertyDescriptor(req, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    return descriptor.value;
}

function snapshotAuth(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
        throw invalidSubject("req.auth", "must be a non-Proxy plain object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw invalidSubject("req.auth", "must be a plain object");
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
            throw invalidSubject(`req.auth.${String(key)}`, "must be a data property");
        }
        if (typeof key === "symbol") {
            continue;
        }
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
            throw invalidSubject("req.auth", "contains an unsupported property key");
        }
        if (!descriptor.enumerable) {
            if (AUTH_CONTRACT_KEYS.has(key)) {
                throw invalidSubject(`req.auth.${key}`, "must be enumerable");
            }
            continue;
        }
        Object.defineProperty(snapshot, key, {
            value: descriptor.value,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    return {
        source: value as Record<string, unknown>,
        snapshot: Object.freeze(snapshot) as Readonly<Record<string, unknown>>,
    };
}

function normalizeAuthSubject(value: unknown, field: string) {
    try {
        return normalizeSubject(value as PermissionSubject);
    } catch (cause) {
        if (isPermissionCoreError(cause) && cause.code === "INVALID_SUBJECT") {
            throw cause;
        }
        throw invalidSubject(field, "does not satisfy the permission subject contract", cause);
    }
}

function strictDefaultSubject(auth: Readonly<Record<string, unknown>>) {
    const hasSubject = Object.hasOwn(auth, "permissionSubject");
    const hasUser = Object.hasOwn(auth, "userId");
    const hasScope = Object.hasOwn(auth, "scope");
    const hasClaims = Object.hasOwn(auth, "claims");
    if (hasSubject && (hasUser || hasScope || hasClaims)) {
        throw invalidSubject("req.auth", "must use exactly one permission subject representation");
    }
    if (hasSubject) {
        return normalizeAuthSubject(auth.permissionSubject, "req.auth.permissionSubject");
    }
    if (!hasUser && !hasScope && !hasClaims) {
        throw invalidSubject("req.auth", "does not provide a permission subject");
    }
    if (!hasUser || !hasScope) {
        throw invalidSubject("req.auth", "userId and scope must be provided together");
    }
    return normalizeAuthSubject({
        userId: auth.userId,
        scope: auth.scope,
        ...(hasClaims ? { claims: auth.claims } : {}),
    }, "req.auth");
}

function optionalCanonicalHostSubject(auth: Readonly<Record<string, unknown>>) {
    const hasSubject = Object.hasOwn(auth, "permissionSubject");
    const hasUser = Object.hasOwn(auth, "userId");
    const hasScope = Object.hasOwn(auth, "scope");
    if (hasSubject && hasUser && hasScope) {
        throw invalidSubject("req.auth", "contains both canonical subject representations");
    }
    if (hasSubject) {
        return normalizeAuthSubject(auth.permissionSubject, "req.auth.permissionSubject");
    }
    if (hasUser && hasScope) {
        return normalizeAuthSubject({
            userId: auth.userId,
            scope: auth.scope,
            ...(Object.hasOwn(auth, "claims") ? { claims: auth.claims } : {}),
        }, "req.auth");
    }
    return undefined;
}

function sameSubjectOwner(left: Readonly<PermissionSubject>, right: Readonly<PermissionSubject>) {
    return digestCanonical({ userId: left.userId, scope: left.scope })
        === digestCanonical({ userId: right.userId, scope: right.scope });
}

async function resolvePermissionSubject(
    auth: Readonly<Record<string, unknown>>,
    req: VextRequest,
    resolver?: SubjectResolver,
) {
    if (auth.isAuthenticated !== true) {
        throw authRequired("isAuthenticated must be true");
    }
    if (!resolver) {
        return strictDefaultSubject(auth);
    }

    const hostSubject = optionalCanonicalHostSubject(auth);
    let resolved: PermissionSubject;
    try {
        resolved = normalizeSubject(await resolver(auth, req));
    } catch (cause) {
        if (isPermissionCoreError(cause) && cause.code === "INVALID_SUBJECT") {
            throw cause;
        }
        throw invalidSubject("resolveSubject result", "does not satisfy the permission subject contract", cause);
    }
    if (hostSubject && !sameSubjectOwner(hostSubject, resolved)) {
        throw scopeConflict("resolveSubject returned a different canonical user or scope");
    }
    return resolved;
}

function readExistingPermission(auth: Record<string, unknown>, req: VextRequest) {
    const descriptor = Object.getOwnPropertyDescriptor(auth, "permission");
    if (!descriptor) return undefined;
    const ownerKey = "value" in descriptor ? weakMapKey(descriptor.value) : undefined;
    if (
        !("value" in descriptor)
        || ownerKey === undefined
        || permissionApiOwners.get(ownerKey) !== req
    ) {
        throw extensionConflict("is already occupied by another extension");
    }
    return descriptor.value as VextRequestPermissionApi;
}

function readExistingDataAlias(req: VextRequest) {
    const descriptor = Object.getOwnPropertyDescriptor(req, "monsqlize");
    if (!descriptor) return undefined;
    const ownerKey = "value" in descriptor ? weakMapKey(descriptor.value) : undefined;
    if (
        !("value" in descriptor)
        || ownerKey === undefined
        || permissionDataApiOwners.get(ownerKey) !== req
    ) {
        throw extensionConflict("is already occupied by another extension", undefined, "req.monsqlize");
    }
    return descriptor.value as VextRequestDataApi;
}

function installDataAlias(
    req: VextRequest,
    data: VextRequestDataApi,
    dataOptions?: ResolvedPermissionVextDataOptions,
) {
    if (dataOptions?.exposeAs !== "monsqlize") return;
    const existing = readExistingDataAlias(req);
    if (existing) return;
    try {
        Object.defineProperty(req, "monsqlize", {
            value: data,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    } catch (cause) {
        throw extensionConflict("cannot be defined on req", cause, "req.monsqlize");
    }
}

function collectionOptionsFor(
    name: string,
    dataOptions: ResolvedPermissionVextDataOptions,
): AuthorizedCollectionOptions {
    const configured = dataOptions.collections[name];
    return Object.freeze({
        resource: configured?.resource ?? `db:${name}`,
        scopeFields: configured?.scopeFields ?? dataOptions.scopeFields,
    });
}

function wrapAuthorizedCollection<
    TDocument extends object,
    TCreate extends object = Omit<TDocument, "_id">,
>(
    collection: AuthorizedCollection<TDocument, TCreate>,
    req: VextRequest,
    assertOwner: () => void,
    execute: <T>(operation: () => Promise<T>) => Promise<T>,
): AuthorizedCollection<TDocument, TCreate> {
    const wrapped = Object.freeze({
        find: (filter, options) =>
            execute(() => {
                assertOwner();
                return collection.find(filter, options);
            }),
        findOne: (filter, options) =>
            execute(() => {
                assertOwner();
                return collection.findOne(filter, options);
            }),
        count: (filter, options) =>
            execute(() => {
                assertOwner();
                return collection.count(filter, options);
            }),
        findAndCount: (filter, options) =>
            execute(() => {
                assertOwner();
                return collection.findAndCount(filter, options);
            }),
        findPage: (query) =>
            execute(() => {
                assertOwner();
                return collection.findPage(query);
            }),
        insertOne: (document, options) =>
            execute(() => {
                assertOwner();
                return collection.insertOne(document, options);
            }),
        updateOne: (filter, update, options) =>
            execute(() => {
                assertOwner();
                return collection.updateOne(filter, update, options);
            }),
        updateMany: (filter, update, options) =>
            execute(() => {
                assertOwner();
                return collection.updateMany(filter, update, options);
            }),
        deleteOne: (filter, options) =>
            execute(() => {
                assertOwner();
                return collection.deleteOne(filter, options);
            }),
        deleteMany: (filter, options) =>
            execute(() => {
                assertOwner();
                return collection.deleteMany(filter, options);
            }),
    } satisfies AuthorizedCollection<TDocument, TCreate>);
    return wrapped;
}

function createProtectedDataApi(
    req: VextRequest,
    dataOptions: ResolvedPermissionVextDataOptions,
    contextFor: (context?: PolicyContext) => SubjectPermissionContext,
    assertOwner: () => void,
    execute: <T>(operation: () => Promise<T>) => Promise<T>,
): VextRequestDataApi {
    const data = Object.freeze({
        collection<
            TDocument extends object,
            TCreate extends object = Omit<TDocument, "_id">,
        >(name: string) {
            try {
                assertOwner();
                const collection = contextFor().data.collection<TDocument, TCreate>(
                    name,
                    collectionOptionsFor(name, dataOptions),
                );
                return wrapAuthorizedCollection(collection, req, assertOwner, execute);
            } catch (error) {
                return throwVextPermissionError(req.app, error);
            }
        },
    } satisfies VextRequestDataApi);
    permissionDataApiOwners.set(data, req);
    return data;
}

function createPermissionApi(
    core: PermissionCore,
    subject: Readonly<PermissionSubject>,
    req: VextRequest,
    dataOptions?: ResolvedPermissionVextDataOptions,
): VextRequestPermissionApi {
    const base = core.forSubject(subject);
    const contexts = new Map<string, SubjectPermissionContext>();
    const contextFor = (context?: PolicyContext) => {
        if (context === undefined) return base;
        const normalized = normalizePolicyContext(context);
        const key = digestCanonical(normalized);
        const existing = contexts.get(key);
        if (existing) return existing;
        const created = core.forSubject(subject, normalized);
        if (contexts.size < MAX_CONTEXTS_PER_REQUEST) contexts.set(key, created);
        return created;
    };
    const execute = async <T>(operation: () => Promise<T>) => {
        try {
            return await operation();
        } catch (error) {
            return throwVextPermissionError(req.app, error);
        }
    };
    const assertOwner = () => {
        if (requestContext.getStore() !== req || !activeRequests.has(req)) {
            throw extensionConflict("was used outside its owning request");
        }
    };
    const data = dataOptions === undefined
        ? undefined
        : createProtectedDataApi(req, dataOptions, contextFor, assertOwner, execute);
    return Object.freeze({
        subject,
        ...(data === undefined ? {} : { data }),
        can: (action: PermissionAction, resource: string, context?: PolicyContext) =>
            execute(() => {
                assertOwner();
                return contextFor(context).can(action, resource);
            }),
        assert: (action: PermissionAction, resource: string, context?: PolicyContext) =>
            execute(() => {
                assertOwner();
                return contextFor(context).assert(action, resource);
            }),
        filterResponse: (apiResource: ApiResource, payload: unknown, context?: PolicyContext) =>
            execute(() => {
                assertOwner();
                return contextFor(context).menus.filterResponse(apiResource, payload);
            }),
    });
}

async function installPermissionApi(
    core: PermissionCore,
    req: VextRequest,
    resolver?: SubjectResolver,
    dataOptions?: ResolvedPermissionVextDataOptions,
    onSubject?: (subject: Readonly<PermissionSubject>) => void,
) {
    const authValue = requestDataProperty(req, "auth");
    if (authValue === undefined) {
        throw authRequired("req.auth is missing");
    }
    const { source: auth, snapshot } = snapshotAuth(authValue);
    const existing = readExistingPermission(auth, req);
    if (existing) return existing;
    const subject = await resolvePermissionSubject(snapshot, req, resolver);
    if (requestDataProperty(req, "auth") !== auth) {
        throw invalidSubject("req.auth", "changed while resolving the permission subject");
    }
    if (Object.getOwnPropertyDescriptor(auth, "permission")) {
        throw extensionConflict("was occupied while resolving the permission subject");
    }
    if (dataOptions?.exposeAs === "monsqlize") {
        readExistingDataAlias(req);
    }
    const api = createPermissionApi(core, subject, req, dataOptions);
    permissionApiOwners.set(api, req);
    try {
        Object.defineProperty(auth, "permission", {
            value: api,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    } catch (cause) {
        throw extensionConflict("cannot be defined on req.auth", cause);
    }
    if (api.data) {
        installDataAlias(req, api.data, dataOptions);
    }
    onSubject?.(subject);
    return api;
}

function installResponseProjection(
    req: VextRequest,
    res: VextResponse,
    state: RequestPermissionState,
) {
    const existingOwner = responseProjectionOwners.get(res);
    if (existingOwner === req) return;
    if (existingOwner !== undefined) {
        throw extensionConflict("response projection is already occupied by another request");
    }
    if (typeof res.json !== "function" || typeof res.rawJson !== "function") {
        return;
    }
    const originalJson = res.json.bind(res);
    const originalRawJson = res.rawJson.bind(res);
    const projectedJson: VextResponse["json"] = (payload, status) => {
        const route = state.getRoute();
        if (route === undefined) {
            originalJson(payload, status);
            return;
        }
        setNoStore(res);
        void state.filterResponse(route.apiResource, payload)
            .then((result) => {
                originalJson(result.data, status);
            })
            .catch((error: unknown) => {
                const failure = projectionFailureBody(error, requestIdOf(req));
                setNoStore(res);
                originalRawJson(failure.body, failure.status);
            });
    };
    try {
        Object.defineProperty(res, "json", {
            value: projectedJson,
            enumerable: false,
            writable: false,
            configurable: false,
        });
    } catch (cause) {
        throw extensionConflict("cannot install response projection", cause);
    }
    responseProjectionOwners.set(res, req);
}

export function createPermissionRequestMiddleware(
    core: PermissionCore,
    resolver?: SubjectResolver,
    dataOptions?: ResolvedPermissionVextDataOptions,
): VextMiddleware {
    return async (req, res, next) => {
        const runNext = async () => {
            activeRequests.add(req);
            try {
                await requestContext.run(req, next);
            } finally {
                activeRequests.delete(req);
            }
        };
        const existing = Object.getOwnPropertyDescriptor(req, REQUEST_PERMISSION_STATE);
        if (existing) {
            if (!("value" in existing) || !permissionStates.has(existing.value as object)) {
                throw extensionConflict("internal request state is already occupied");
            }
            installResponseProjection(req, res, existing.value as RequestPermissionState);
            await runNext();
            return;
        }
        let pending: Promise<VextRequestPermissionApi> | undefined;
        let resolvedSubject: Readonly<PermissionSubject> | undefined;
        let route: ResponseProjectionRoute | undefined;
        const state: RequestPermissionState = Object.freeze({
            resolve() {
                pending ??= installPermissionApi(core, req, resolver, dataOptions, (subject) => {
                    resolvedSubject = subject;
                });
                return pending;
            },
            bindRoute(value: ResponseProjectionRoute) {
                route = value;
            },
            getRoute() {
                return route;
            },
            async filterResponse(apiResource: ApiResource, payload: unknown) {
                await state.resolve();
                if (resolvedSubject === undefined) {
                    throw authRequired("permission subject was not resolved");
                }
                return core.forSubject(resolvedSubject).menus.filterResponse(apiResource, payload);
            },
        });
        permissionStates.add(state);
        try {
            Object.defineProperty(req, REQUEST_PERMISSION_STATE, {
                value: state,
                enumerable: false,
                writable: false,
                configurable: false,
            });
        } catch (cause) {
            throw extensionConflict("cannot install the internal lazy request state", cause);
        }
        installResponseProjection(req, res, state);
        await runNext();
    };
}

export function bindPermissionResponseProjection(
    req: VextRequest,
    route: ResponseProjectionRoute,
) {
    const state = requestDataProperty(req, REQUEST_PERMISSION_STATE);
    if (state === null || typeof state !== "object" || !permissionStates.has(state)) {
        throw authRequired("permission middleware has not installed request state");
    }
    (state as RequestPermissionState).bindRoute(route);
}

export function hasPermissionContext(req: VextRequest): req is PermissionVextRequest {
    try {
        const auth = requestDataProperty(req, "auth");
        if (auth === null || typeof auth !== "object" || utilTypes.isProxy(auth)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(auth, "permission");
        const ownerKey = descriptor && "value" in descriptor ? weakMapKey(descriptor.value) : undefined;
        return Boolean(
            descriptor
            && "value" in descriptor
            && ownerKey !== undefined
            && permissionApiOwners.get(ownerKey) === req,
        );
    } catch {
        return false;
    }
}

export async function requirePermissionContext(
    req: VextRequest,
): Promise<VextRequestPermissionApi> {
    if (hasPermissionContext(req)) {
        return (requestDataProperty(req, "auth") as PermissionVextRequest["auth"]).permission;
    }
    try {
        const state = requestDataProperty(req, REQUEST_PERMISSION_STATE);
        if (state === null || typeof state !== "object" || !permissionStates.has(state)) {
            throw authRequired("permission middleware has not installed request state");
        }
        return await (state as RequestPermissionState).resolve();
    } catch (error) {
        return throwVextPermissionError(req.app, error);
    }
}
