import { createRequire } from "node:module";
import MonSQLize from "monsqlize";
import { describe, expect, it, vi } from "vitest";
import type {
    VextHookHandler,
    VextHookName,
    VextHookPayloadMap,
    VextMiddleware,
    VextPluginContext,
    VextRequest,
    VextRouteHookInfo,
} from "vextjs";
import { PermissionCore } from "../../src/core/permission-core";
import { permissionPlugin } from "../../src/plugins/vext/plugin";
import { resolvePermissionVextPluginOptions } from "../../src/plugins/vext/options";
import { createMonSQLizeStub } from "./helpers/monsqlize-stub";

class TestHttpError extends Error {
    readonly name = "HttpError";
    constructor(
        readonly status: number,
        message: string,
        readonly code?: string | number,
    ) {
        super(message);
    }
}

interface FakeHostOptions {
    failHookAt?: number;
    failUse?: boolean;
    failExtend?: boolean;
    failOnClose?: boolean;
}

function fakeHost(options: FakeHostOptions = {}) {
    const handlers = new Map<VextHookName, Set<(payload: unknown) => unknown>>();
    const middlewares: VextMiddleware[] = [];
    const closeHooks: Array<() => Promise<void> | void> = [];
    let hookRegistrations = 0;
    const app = {
        logger: {
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            fatal: vi.fn(),
            child: vi.fn(),
        },
        throw(input: { status: number; message: string; code?: string | number }) {
            throw new TestHttpError(input.status, input.message, input.code);
        },
        config: {},
        services: {},
        adapter: {},
        cache: {},
        fetch: vi.fn(),
        hooks: {
            on(name: VextHookName, handler: (payload: unknown) => unknown) {
                hookRegistrations += 1;
                if (options.failHookAt === hookRegistrations) {
                    throw new Error(`hook-${hookRegistrations}-failed`);
                }
                const set = handlers.get(name) ?? new Set();
                set.add(handler);
                handlers.set(name, set);
                return () => {
                    set.delete(handler);
                    if (set.size === 0) handlers.delete(name);
                };
            },
            has(name: VextHookName) {
                return (handlers.get(name)?.size ?? 0) > 0;
            },
        },
        use(middleware: VextMiddleware) {
            if (options.failUse) throw new Error("use-failed");
            middlewares.push(middleware);
        },
        extend(key: string, value: unknown) {
            if (options.failExtend) throw new Error("extend-failed");
            if (key in app) throw new Error("occupied");
            (app as Record<string, unknown>)[key] = value;
        },
        onClose(handler: () => Promise<void> | void) {
            if (options.failOnClose) throw new Error("on-close-failed");
            closeHooks.push(handler);
        },
    } as unknown as VextPluginContext & Record<string, unknown>;

    async function emit<K extends VextHookName>(name: K, payload: VextHookPayloadMap[K]) {
        let result: unknown;
        for (const handler of [...(handlers.get(name) ?? [])]) {
            const value = await handler(payload);
            if (value !== undefined) result = value;
        }
        return result;
    }

    async function run(req: VextRequest, terminal: () => Promise<void>) {
        let index = -1;
        const dispatch = async (nextIndex: number): Promise<void> => {
            if (nextIndex <= index) throw new Error("next called more than once");
            index = nextIndex;
            const middleware = middlewares[nextIndex];
            if (middleware) {
                await middleware(req, {} as never, () => dispatch(nextIndex + 1));
                return;
            }
            await terminal();
        };
        await dispatch(0);
    }

    async function close() {
        for (const handler of [...closeHooks].reverse()) await handler();
    }

    return { app, handlers, middlewares, closeHooks, emit, run, close };
}

function route(method: string, path: string, permission?: unknown): VextRouteHookInfo {
    return routeWithOptions(method, path, permission === undefined ? {} : { permission: permission as never });
}

function routeWithOptions(method: string, path: string, options: Record<string, unknown>): VextRouteHookInfo {
    return {
        method,
        path,
        options: options as never,
        sourceFile: "src/routes/test.ts",
    };
}

function req(app: VextPluginContext, method: string, path: string, auth?: unknown) {
    return {
        app,
        method,
        path,
        route: path,
        requestId: "req-1",
        params: {},
        ...(auth === undefined ? {} : { auth }),
    } as unknown as VextRequest;
}

describe("permissionPlugin contract", () => {
    it("returns an immutable native plugin with deterministic dependencies", () => {
        const plugin = permissionPlugin({
            monsqlize: createMonSQLizeStub().instance,
            databasePlugin: "permission-database",
            authPlugin: "permission-database",
        });

        expect(plugin.name).toBe("permission-core");
        expect(plugin.dependencies).toEqual(["permission-database"]);
        expect(typeof plugin.setup).toBe("function");
        expect(Object.isFrozen(plugin)).toBe(true);
        expect(Object.isFrozen(plugin.dependencies)).toBe(true);
    });

    it("rejects unknown, accessor, Proxy, ambiguous database, and invalid dependency options before setup", () => {
        let trapCalls = 0;
        const proxy = new Proxy({}, {
            get() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });
        const accessor = {};
        Object.defineProperty(accessor, "authPlugin", {
            enumerable: true,
            get() {
                trapCalls += 1;
                return "authentication";
            },
        });
        const stub = createMonSQLizeStub();

        for (const options of [
            { unknown: true },
            accessor,
            proxy,
            { monsqlize: stub.instance, resolveMonSQLize: () => stub.instance },
            { monsqlize: proxy },
            { monsqlize: stub.instance, authPlugin: "not valid" },
            { monsqlize: stub.instance, core: { monsqlize: stub.instance } },
        ]) {
            expect(() => permissionPlugin(options as never)).toThrowError(expect.objectContaining({
                code: "INVALID_CONFIGURATION",
            }));
        }
        expect(trapCalls).toBe(0);
    });

    it("snapshots nested core options and rejects structural configuration smuggling", () => {
        const tokenSecret = new Uint8Array(32).fill(7);
        const probe = { pattern: "doc:*", resource: "doc:42", expected: true };
        const definition = {
            scheme: "doc",
            version: "1",
            probes: [probe],
            validate: (resource: string) => resource.startsWith("doc:"),
            match: (pattern: string, resource: string) => pattern === "doc:*" || pattern === resource,
        };
        const resolved = resolvePermissionVextPluginOptions({
            monsqlize: createMonSQLizeStub().instance,
            core: {
                cache: { enabled: true, ttlMs: 500, consistency: "ordered-bounded-stale" },
                tokenSecret,
                resourceSchemes: [definition],
            },
        });

        expect(resolved.dependencies).toEqual(["authentication"]);
        expect(Object.isFrozen(resolved)).toBe(true);
        expect(Object.isFrozen(resolved.core)).toBe(true);
        expect(Object.isFrozen(resolved.core.cache)).toBe(true);
        expect(Object.isFrozen(resolved.core.resourceSchemes)).toBe(true);
        expect(Object.isFrozen(resolved.core.resourceSchemes?.[0])).toBe(true);
        expect(Object.isFrozen(resolved.core.resourceSchemes?.[0]?.probes)).toBe(true);
        expect(resolved.core.tokenSecret).not.toBe(tokenSecret);
        tokenSecret[0] = 9;
        probe.resource = "doc:changed";
        expect((resolved.core.tokenSecret as Uint8Array)[0]).toBe(7);
        expect(resolved.core.resourceSchemes?.[0]?.probes[0]?.resource).toBe("doc:42");

        const arrayWithProperty = [] as unknown[] & { extra?: boolean };
        arrayWithProperty.extra = true;
        const sparse = new Array(1);
        const symbolCore = { [Symbol("hidden")]: true };
        const undefinedCore = {};
        Object.defineProperty(undefinedCore, "collectionPrefix", { value: undefined, enumerable: true });
        const accessorProbe = { pattern: "doc:*", resource: "doc:42" };
        Object.defineProperty(accessorProbe, "expected", {
            enumerable: true,
            get() {
                throw new Error("must not execute");
            },
        });
        const proxiedSecret = new Proxy(new Uint8Array(32), {});
        for (const options of [
            null,
            { core: null },
            { core: Object.create({ inherited: true }) },
            { core: symbolCore },
            { core: undefinedCore },
            { core: { cache: null } },
            { core: { tokenSecret: proxiedSecret } },
            { core: { resourceSchemes: {} } },
            { core: { resourceSchemes: arrayWithProperty } },
            { core: { resourceSchemes: sparse } },
            { core: { resourceSchemes: [{ ...definition, probes: [accessorProbe] }] } },
            { monsqlize: 1 },
            { resolveMonSQLize: true },
            { resolveSubject: "resolver" },
            { validateRouteManifest: {} },
        ]) {
            expect(() => permissionPlugin(options as never)).toThrowError(expect.objectContaining({
                code: "INVALID_CONFIGURATION",
            }));
        }
    });

    it("snapshots subject and protected data facade options", async () => {
        const stub = createMonSQLizeStub();
        const resolved = resolvePermissionVextPluginOptions({
            monsqlize: stub.instance,
            routes: {
                protect: ["/api/**"],
                public: ["/api/auth/**", "/api/health"],
            },
            subject: {
                resolve: (request) => ({
                    userId: String(request.headers["x-user-id"] ?? "u-1"),
                    scope: { tenantId: "t-1" },
                }),
            },
            data: {
                exposeAs: "monsqlize",
                transparent: true,
                scopeFields: { tenantId: "tenantId" },
                collections: {
                    order_records: {
                        resource: "db:orders",
                        scopeFields: { tenantId: "tenant_id" },
                    },
                },
            },
        });

        expect(Object.isFrozen(resolved.data)).toBe(true);
        expect(Object.isFrozen(resolved.routes)).toBe(true);
        expect(Object.isFrozen(resolved.routes.protect)).toBe(true);
        expect(Object.isFrozen(resolved.routes.public)).toBe(true);
        expect(Object.isFrozen(resolved.data?.scopeFields)).toBe(true);
        expect(Object.isFrozen(resolved.data?.collections)).toBe(true);
        expect(Object.isFrozen(resolved.data?.collections.order_records)).toBe(true);
        expect(resolved.routes).toEqual({
            protect: [{ kind: "prefix", value: "/api" }],
            public: [{ kind: "prefix", value: "/api/auth" }, { kind: "exact", value: "/api/health" }],
        });
        expect(resolved.data).toMatchObject({
            exposeAs: "monsqlize",
            transparent: true,
            scopeFields: { tenantId: "tenantId" },
            collections: {
                order_records: {
                    resource: "db:orders",
                    scopeFields: { tenantId: "tenant_id" },
                },
            },
        });
        await expect(Promise.resolve(resolved.resolveSubject?.(
            { isAuthenticated: true },
            { headers: { "x-user-id": "u-subject" } } as never,
        ))).resolves.toEqual({ userId: "u-subject", scope: { tenantId: "t-1" } });
    });

    it("rejects invalid subject and protected data facade options before setup", () => {
        const stub = createMonSQLizeStub();
        const symbolCollections = { [Symbol("hidden")]: {} };
        const accessorScopeFields = {};
        Object.defineProperty(accessorScopeFields, "tenantId", {
            enumerable: true,
            get() {
                throw new Error("must not execute");
            },
        });
        for (const options of [
            { monsqlize: stub.instance, subject: {} },
            { monsqlize: stub.instance, subject: { resolve: "resolver" } },
            { monsqlize: stub.instance, subject: { resolve: () => ({ userId: "u-1", scope: { tenantId: "t-1" } }) }, resolveSubject: () => ({ userId: "u-1", scope: { tenantId: "t-1" } }) },
            { monsqlize: stub.instance, routes: null },
            { monsqlize: stub.instance, routes: { protect: ["/api/*"] } },
            { monsqlize: stub.instance, routes: { protect: ["api/**"] } },
            { monsqlize: stub.instance, routes: { public: ["/api?\u003fx=1"] } },
            { monsqlize: stub.instance, data: {} },
            { monsqlize: stub.instance, data: { exposeAs: "database", scopeFields: { tenantId: "tenantId" } } },
            { monsqlize: stub.instance, data: { transparent: "yes", scopeFields: { tenantId: "tenantId" } } },
            { monsqlize: stub.instance, data: { scopeFields: {} } },
            { monsqlize: stub.instance, data: { scopeFields: accessorScopeFields } },
            { monsqlize: stub.instance, data: { scopeFields: { tenantId: "tenantId" }, collections: symbolCollections } },
            { monsqlize: stub.instance, data: { scopeFields: { tenantId: "tenantId" }, collections: { constructor: {} } } },
            { monsqlize: stub.instance, data: { scopeFields: { tenantId: "tenantId" }, collections: { orders: { resource: "api:GET:/orders" } } } },
            { monsqlize: stub.instance, data: { scopeFields: { tenantId: "tenantId" }, collections: { orders: { scopeFields: {} } } } },
            { monsqlize: stub.instance, data: { scopeFields: { tenantId: "tenantId", appId: "tenantId" } } },
        ]) {
            expect(() => permissionPlugin(options as never)).toThrowError(expect.objectContaining({
                code: "INVALID_CONFIGURATION",
            }));
        }
    });

    it("checks app.permission and missing/incompatible auto databases before host mutation", async () => {
        const resolver = vi.fn(() => createMonSQLizeStub().instance);
        const occupied = fakeHost();
        occupied.app.permission = {};
        await expect(permissionPlugin({ resolveMonSQLize: resolver }).setup(occupied.app))
            .rejects.toMatchObject({ code: "VEXT_APP_EXTENSION_CONFLICT" });
        expect(resolver).not.toHaveBeenCalled();
        expect(occupied.middlewares).toHaveLength(0);
        expect(occupied.handlers.size).toBe(0);

        const missing = fakeHost();
        await expect(permissionPlugin().setup(missing.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_REQUIRED" });
        expect(missing.middlewares).toHaveLength(0);
        expect(missing.handlers.size).toBe(0);

        const incompatible = fakeHost();
        incompatible.app.monsqlize = createMonSQLizeStub().instance;
        await expect(permissionPlugin().setup(incompatible.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });
        expect(incompatible.middlewares).toHaveLength(0);
    });

    it("validates explicit and resolver MonSQLize capabilities without executing accessors", async () => {
        const explicit = fakeHost();
        await expect(permissionPlugin({ monsqlize: {} as never }).setup(explicit.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });
        expect(explicit.middlewares).toHaveLength(0);
        expect(explicit.handlers.size).toBe(0);

        let accessorCalls = 0;
        const accessorCandidate = Object.create(null);
        Object.defineProperty(accessorCandidate, "health", {
            enumerable: true,
            get() {
                accessorCalls += 1;
                return () => undefined;
            },
        });
        const resolver = vi.fn(async () => accessorCandidate as never);
        const resolved = fakeHost();
        await expect(permissionPlugin({ resolveMonSQLize: resolver }).setup(resolved.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });
        expect(resolver).toHaveBeenCalledTimes(1);
        expect(accessorCalls).toBe(0);
        expect(resolved.middlewares).toHaveLength(0);
        expect(resolved.handlers.size).toBe(0);

        const noCache = createMonSQLizeStub();
        delete (noCache.instance as unknown as Record<string, unknown>).getCache;
        const defaultBypass = fakeHost();
        await permissionPlugin({ monsqlize: noCache.instance }).setup(defaultBypass.app);
        await defaultBypass.close();

        const cacheRequired = fakeHost();
        await expect(permissionPlugin({
            monsqlize: noCache.instance,
            core: { cache: { enabled: true, consistency: "ordered-bounded-stale" } },
        }).setup(cacheRequired.app)).rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });
        expect(cacheRequired.middlewares).toHaveLength(0);
        expect(cacheRequired.handlers.size).toBe(0);
    });

    it("accepts prototype data methods and rejects resolver, auto-property, and prototype hazards", async () => {
        const stub = createMonSQLizeStub();
        const prototype = Object.create(null) as Record<string, unknown>;
        for (const capability of ["health", "getDefaults", "collection", "db", "withTransaction"] as const) {
            prototype[capability] = (stub.instance as unknown as Record<string, unknown>)[capability];
        }
        const inheritedCandidate = Object.create(prototype);
        const inheritedHost = fakeHost();
        await permissionPlugin({ monsqlize: inheritedCandidate }).setup(inheritedHost.app);
        await inheritedHost.close();

        const resolverFailure = fakeHost();
        await expect(permissionPlugin({
            resolveMonSQLize: async () => {
                throw new Error("database plugin unavailable");
            },
        }).setup(resolverFailure.app)).rejects.toMatchObject({
            code: "VEXT_MONSQLIZE_INCOMPATIBLE",
            cause: expect.any(Error),
        });

        let getterCalls = 0;
        const accessorHost = fakeHost();
        Object.defineProperty(accessorHost.app, "monsqlize", {
            enumerable: true,
            get() {
                getterCalls += 1;
                return stub.instance;
            },
        });
        await expect(permissionPlugin().setup(accessorHost.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });
        expect(getterCalls).toBe(0);

        const undefinedHost = fakeHost();
        Object.defineProperty(undefinedHost.app, "monsqlize", { value: undefined, enumerable: true });
        await expect(permissionPlugin().setup(undefinedHost.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });

        const proxyHost = fakeHost();
        proxyHost.app.monsqlize = new Proxy(stub.instance as object, {});
        await expect(permissionPlugin().setup(proxyHost.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });

        const proxyPrototypeHost = fakeHost();
        const proxyPrototype = new Proxy(Object.create(null), {});
        const candidate = Object.create(proxyPrototype);
        await expect(permissionPlugin({ monsqlize: candidate }).setup(proxyPrototypeHost.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });
    });

    it("rejects Vext's nested MonSQLize 2.x on the automatic path", async () => {
        const nestedRequire = createRequire(createRequire(import.meta.url).resolve("vextjs"));
        const nestedModule = nestedRequire("monsqlize") as unknown;
        const NestedMonSQLize = (typeof nestedModule === "function"
            ? nestedModule
            : (nestedModule as { default?: unknown; MonSQLize?: unknown }).default
                ?? (nestedModule as { MonSQLize?: unknown }).MonSQLize) as new (
                    options: Record<string, unknown>,
                ) => unknown;
        const host = fakeHost();
        host.app.monsqlize = new NestedMonSQLize({
            type: "mongodb",
            databaseName: "vext-nested-contract",
            config: { uri: "mongodb://127.0.0.1:1/vext-nested-contract" },
        });

        await expect(permissionPlugin().setup(host.app))
            .rejects.toMatchObject({ code: "VEXT_MONSQLIZE_INCOMPATIBLE" });
        expect(host.handlers.size).toBe(0);
        expect(host.middlewares).toHaveLength(0);
    });

    it("accepts required-peer constructor identity on auto before normal core health checks", async () => {
        const host = fakeHost();
        host.app.monsqlize = new MonSQLize({
            type: "mongodb",
            databaseName: "vext-auto-contract",
            config: { uri: "mongodb://127.0.0.1:1/vext-auto-contract" },
        });

        await expect(permissionPlugin().setup(host.app)).rejects.not.toMatchObject({
            code: "VEXT_MONSQLIZE_INCOMPATIBLE",
        });
        expect(host.handlers.size).toBe(0);
        expect(host.middlewares).toHaveLength(0);
    });

    it("closes its own core when initialization fails without mutating the host database", async () => {
        const stub = createMonSQLizeStub();
        stub.spies.health.mockRejectedValueOnce(new Error("database-health-failed"));
        const host = fakeHost();
        const closeSpy = vi.spyOn(PermissionCore.prototype, "close");

        try {
            await expect(permissionPlugin({ monsqlize: stub.instance }).setup(host.app))
                .rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
            expect(closeSpy).toHaveBeenCalledTimes(1);
            expect(host.middlewares).toHaveLength(0);
            expect(host.handlers.size).toBe(0);
            expect(host.closeHooks).toHaveLength(0);
            expect(stub.spies.connect).not.toHaveBeenCalled();
            expect(stub.spies.close).not.toHaveBeenCalled();
        } finally {
            closeSpy.mockRestore();
        }
    });

    it("initializes one core, commits the route snapshot, and never closes host MonSQLize", async () => {
        const stub = createMonSQLizeStub();
        const host = fakeHost();
        await permissionPlugin({
            monsqlize: stub.instance,
            authPlugin: "authentication",
        }).setup(host.app);

        expect(host.middlewares).toHaveLength(1);
        expect(host.closeHooks).toHaveLength(1);
        expect(host.app.permission).toBeInstanceOf(PermissionCore);
        expect(stub.spies.connect).not.toHaveBeenCalled();
        expect(stub.spies.close).not.toHaveBeenCalled();
        expect([...host.handlers.keys()].sort()).toEqual([
            "error:beforeResponse",
            "route:matched",
            "routes:ready",
            "server:beforeListen",
        ]);

        const routes = [route("GET", "/public"), route("GET", "/orders/:id", true)];
        await host.emit("routes:ready", { count: routes.length, routes });
        await host.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} });

        const publicRequest = req(host.app, "GET", "/public");
        await host.run(publicRequest, () => host.emit("route:matched", {
            req: publicRequest,
            route: routes[0]!,
            params: {},
            requestId: "req-public",
        }).then(() => undefined));

        const protectedRequest = req(host.app, "GET", "/orders/42", {
            isAuthenticated: true,
            userId: "u-1",
            scope: { tenantId: "t-1" },
        });
        await expect(host.run(protectedRequest, () => host.emit("route:matched", {
            req: protectedRequest,
            route: routes[1]!,
            params: { id: "42" },
            requestId: "req-protected",
        }).then(() => undefined))).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });

        await host.close();
        expect((await (host.app.permission as PermissionCore).health()).lifecycle).toBe("closed");
        expect(stub.spies.close).not.toHaveBeenCalled();
        expect(host.handlers.size).toBe(0);
    });

    it("short-circuits any/all route checks in declaration order", async () => {
        const calls: string[] = [];
        const subjectSpy = vi.spyOn(PermissionCore.prototype, "forSubject").mockImplementation(() => ({
            can: async (action: string, resource: string) => {
                calls.push(`${action}:${resource}`);
                if (resource === "ui:page:any") return action === "manage";
                if (resource === "ui:page:all") return action === "read";
                return false;
            },
        }) as never);
        const host = fakeHost();
        try {
            await permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(host.app);
            const anyRoute = route("GET", "/any", {
                mode: "any",
                requirements: [
                    { action: "read", resource: "ui:page:any" },
                    { action: "manage", resource: "ui:page:any" },
                    { action: "delete", resource: "ui:page:any" },
                ],
            });
            const anyDeniedRoute = route("GET", "/any-denied", {
                mode: "any",
                requirements: [
                    { action: "read", resource: "ui:page:denied" },
                    { action: "manage", resource: "ui:page:denied" },
                ],
            });
            const allRoute = route("GET", "/all", {
                mode: "all",
                requirements: [
                    { action: "read", resource: "ui:page:all" },
                    { action: "manage", resource: "ui:page:all" },
                    { action: "delete", resource: "ui:page:all" },
                ],
            });
            const routes = [anyRoute, anyDeniedRoute, allRoute];
            await host.emit("routes:ready", { count: routes.length, routes });
            await host.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} });
            const auth = { isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } };

            const anyRequest = req(host.app, "GET", "/any", { ...auth });
            await host.run(anyRequest, () => host.emit("route:matched", {
                req: anyRequest,
                route: anyRoute,
                params: {},
                requestId: "req-any",
            }).then(() => undefined));
            expect(calls).toEqual(["read:ui:page:any", "manage:ui:page:any"]);

            calls.length = 0;
            const anyDeniedRequest = req(host.app, "GET", "/any-denied", { ...auth });
            await expect(host.run(anyDeniedRequest, () => host.emit("route:matched", {
                req: anyDeniedRequest,
                route: anyDeniedRoute,
                params: {},
                requestId: "req-any-denied",
            }).then(() => undefined))).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
            expect(calls).toEqual(["read:ui:page:denied", "manage:ui:page:denied"]);

            calls.length = 0;
            const allRequest = req(host.app, "GET", "/all", { ...auth });
            await expect(host.run(allRequest, () => host.emit("route:matched", {
                req: allRequest,
                route: allRoute,
                params: {},
                requestId: "req-all",
            }).then(() => undefined))).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
            expect(calls).toEqual(["read:ui:page:all", "manage:ui:page:all"]);
        } finally {
            await host.close();
            subjectSpy.mockRestore();
        }
    });

    it("fails closed when permission-protected Vext routes enable route cache", async () => {
        const host = fakeHost();
        await permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(host.app);
        const routes = [routeWithOptions("GET", "/cached-orders", { permission: true, cache: 1_000 })];
        await host.emit("routes:ready", { count: routes.length, routes });
        await expect(host.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} }))
            .rejects.toMatchObject({
                code: "VEXT_ROUTE_PERMISSION_INVALID",
            });
        expect((await (host.app.permission as PermissionCore).health()).lifecycle).toBe("closed");
        await host.close();
    });

    it("fails closed on matched-route drift and after runtime disposal", async () => {
        const host = fakeHost();
        await permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(host.app);
        const initial = route("GET", "/public");
        await host.emit("routes:ready", { count: 1, routes: [initial] });
        await host.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} });

        const drifted = route("GET", "/public", true);
        const driftRequest = req(host.app, "GET", "/public");
        await expect(host.run(driftRequest, () => host.emit("route:matched", {
            req: driftRequest,
            route: drifted,
            params: {},
            requestId: "req-drift",
        }).then(() => undefined))).rejects.toMatchObject({
            status: 503,
            code: "VEXT_ROUTE_RESTART_REQUIRED",
        });

        const blockedRequest = req(host.app, "GET", "/public");
        await expect(host.run(blockedRequest, () => host.emit("route:matched", {
            req: blockedRequest,
            route: initial,
            params: {},
            requestId: "req-after-drift",
        }).then(() => undefined))).rejects.toMatchObject({
            status: 503,
            code: "VEXT_ROUTE_RESTART_REQUIRED",
        });

        const retainedHandler = [...host.handlers.get("route:matched")!][0]!;
        await host.close();
        const disposedRequest = req(host.app, "GET", "/public");
        await expect(retainedHandler({
            req: disposedRequest,
            route: initial,
            params: {},
            requestId: "req-disposed",
        })).rejects.toMatchObject({ status: 503, code: "VEXT_ROUTE_RESTART_REQUIRED" });
    });

    it("poisons the runtime when matched route metadata is malformed", async () => {
        const host = fakeHost();
        await permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(host.app);
        const initial = route("GET", "/public");
        await host.emit("routes:ready", { count: 1, routes: [initial] });
        await host.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} });

        const malformed = route("GET", "/public");
        Object.defineProperty(malformed.options, "permission", {
            enumerable: true,
            get() {
                throw new Error("route-option-accessor-must-not-run");
            },
        });
        const malformedRequest = req(host.app, "GET", "/public");
        await expect(host.run(malformedRequest, () => host.emit("route:matched", {
            req: malformedRequest,
            route: malformed,
            params: {},
            requestId: "req-malformed",
        }).then(() => undefined))).rejects.toMatchObject({
            status: 503,
            code: "VEXT_ROUTE_RESTART_REQUIRED",
        });

        const subsequentRequest = req(host.app, "GET", "/public");
        await expect(host.run(subsequentRequest, () => host.emit("route:matched", {
            req: subsequentRequest,
            route: initial,
            params: {},
            requestId: "req-after-malformed",
        }).then(() => undefined))).rejects.toMatchObject({
            status: 503,
            code: "VEXT_ROUTE_RESTART_REQUIRED",
        });
        await host.close();
    });

    it("stores routes:ready errors and blocks beforeListen without trusting emitSafe propagation", async () => {
        const stub = createMonSQLizeStub();
        const host = fakeHost();
        await permissionPlugin({ monsqlize: stub.instance }).setup(host.app);

        await expect(host.emit("routes:ready", {
            count: 1,
            routes: [route("GET", "/broken", { mode: "any", requirements: [] })],
        })).resolves.toBeUndefined();
        await expect(host.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} }))
            .rejects.toMatchObject({ code: "VEXT_ROUTE_PERMISSION_INVALID" });
        expect((await (host.app.permission as PermissionCore).health()).lifecycle).toBe("closed");
        expect(stub.spies.close).not.toHaveBeenCalled();
    });

    it("blocks missing route candidates before listen", async () => {
        const missingHost = fakeHost();
        await permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(missingHost.app);
        await expect(missingHost.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} }))
            .rejects.toMatchObject({ code: "VEXT_ROUTE_PERMISSION_INVALID" });
        expect((await (missingHost.app.permission as PermissionCore).health()).lifecycle).toBe("closed");
    });

    it("deduplicates concurrent startup commits and rejects route changes after commit", async () => {
        const concurrentHost = fakeHost();
        await permissionPlugin({
            monsqlize: createMonSQLizeStub().instance,
        }).setup(concurrentHost.app);
        const initial = route("GET", "/public");
        await concurrentHost.emit("routes:ready", { count: 1, routes: [initial] });
        const firstCommit = concurrentHost.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} });
        const secondCommit = concurrentHost.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} });
        await expect(Promise.all([firstCommit, secondCommit])).resolves.toHaveLength(2);
        await concurrentHost.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} });
        await concurrentHost.emit("routes:ready", { count: 1, routes: [route("GET", "/changed")] });
        await expect(concurrentHost.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} }))
            .rejects.toMatchObject({ code: "VEXT_ROUTE_RESTART_REQUIRED" });
        await concurrentHost.close();
    });

    it("turns every route into 503 after any post-commit routes:ready event", async () => {
        const host = fakeHost();
        await permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(host.app);
        const initial = route("GET", "/public");
        await host.emit("routes:ready", { count: 1, routes: [initial] });
        await host.emit("server:beforeListen", { host: "127.0.0.1", port: 0, adapter: {} });
        await host.emit("routes:ready", { count: 1, routes: [initial] });

        const request = req(host.app, "GET", "/public");
        await expect(host.run(request, () => host.emit("route:matched", {
            req: request,
            route: initial,
            params: {},
            requestId: "req-reload",
        }).then(() => undefined))).rejects.toMatchObject({
            status: 503,
            code: "VEXT_ROUTE_RESTART_REQUIRED",
        });
        await host.close();
    });

    it("unsubscribes reversible hooks and classifies every irreversible commit failure", async () => {
        const closeSpy = vi.spyOn(PermissionCore.prototype, "close");
        try {
            const hookFailure = fakeHost({ failHookAt: 3 });
            await expect(permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(hookFailure.app))
                .rejects.toThrow("hook-3-failed");
            expect(hookFailure.handlers.size).toBe(0);
            expect(hookFailure.middlewares).toHaveLength(0);

            const useFailure = fakeHost({ failUse: true });
            await expect(permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(useFailure.app))
                .rejects.toMatchObject({ code: "VEXT_APP_EXTENSION_CONFLICT" });
            expect(useFailure.handlers.size).toBe(0);
            expect(useFailure.middlewares).toHaveLength(0);
            expect(useFailure.app).not.toHaveProperty("permission");

            const extendFailure = fakeHost({ failExtend: true });
            await expect(permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(extendFailure.app))
                .rejects.toMatchObject({ code: "VEXT_APP_EXTENSION_CONFLICT" });
            expect(extendFailure.handlers.size).toBe(0);
            expect(extendFailure.middlewares).toHaveLength(1);
            expect(extendFailure.app).not.toHaveProperty("permission");

            const closeHookFailure = fakeHost({ failOnClose: true });
            await expect(permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(closeHookFailure.app))
                .rejects.toMatchObject({ code: "VEXT_APP_EXTENSION_CONFLICT" });
            expect(closeHookFailure.middlewares).toHaveLength(1);
            expect(closeHookFailure.app.permission).toBeInstanceOf(PermissionCore);
            expect((await (closeHookFailure.app.permission as PermissionCore).health()).lifecycle).toBe("closed");
            expect(closeHookFailure.handlers.size).toBe(0);
            expect(closeSpy).toHaveBeenCalledTimes(4);
        } finally {
            closeSpy.mockRestore();
        }
    });

    it("keeps close idempotent and preserves the original setup error when cleanup fails", async () => {
        const normalHost = fakeHost();
        const normalStub = createMonSQLizeStub();
        const closeSpy = vi.spyOn(PermissionCore.prototype, "close");
        try {
            await permissionPlugin({ monsqlize: normalStub.instance }).setup(normalHost.app);
            await normalHost.close();
            await normalHost.close();
            expect(closeSpy).toHaveBeenCalledTimes(1);
            expect(normalStub.spies.close).not.toHaveBeenCalled();
        } finally {
            closeSpy.mockRestore();
        }

        const cleanupHost = fakeHost({ failHookAt: 1 });
        const cleanupCloseSpy = vi.spyOn(PermissionCore.prototype, "close")
            .mockRejectedValueOnce(new Error("core-close-failed"));
        try {
            await expect(permissionPlugin({ monsqlize: createMonSQLizeStub().instance }).setup(cleanupHost.app))
                .rejects.toThrow("hook-1-failed");
            expect(cleanupHost.app.logger.error).toHaveBeenCalledWith(
                { err: expect.objectContaining({ message: "core-close-failed" }) },
                "[permission-core] failed to close permission runtime after startup failure",
            );
        } finally {
            cleanupCloseSpy.mockRestore();
        }
    });
});
