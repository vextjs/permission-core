import { describe, expect, it } from "vitest";
import type { VextRouteHookInfo } from "vextjs";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import {
    buildVextRouteSnapshot,
    matchVextRouteContract,
    toApiBindingInputs,
} from "../../src/plugins/vext/manifest";
import type { VextRoutePermissionManifest } from "../../src/plugins/vext/types";

const schemes = new ResourceSchemeRegistry();

function route(
    method: string,
    path: string,
    permission?: unknown,
    sourceFile = "src/routes/orders.ts",
): VextRouteHookInfo {
    return {
        method,
        path,
        options: permission === undefined ? {} : { permission: permission as never },
        sourceFile,
    };
}

describe("Vext route manifest", () => {
    it("normalizes public, true, single, any, and all route permissions", () => {
        const snapshot = buildVextRouteSnapshot(5, [
            route("get", "/public"),
            route("get", "/orders/:id", true),
            route("post", "/orders", { action: "create" }),
            route("patch", "/orders/:id", {
                mode: "any",
                requirements: [
                    { action: "update" },
                    { action: "manage", resource: "ui:button:orders.override" },
                ],
            }),
            route("delete", "/orders/:id", {
                mode: "all",
                requirements: [{ action: "delete" }, { action: "manage" }],
            }),
        ], schemes);

        expect(snapshot.manifest.schemaVersion).toBe(1);
        expect(snapshot.manifest.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(snapshot.manifest.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
            "DELETE /orders/:id",
            "GET /orders/:id",
            "GET /public",
            "PATCH /orders/:id",
            "POST /orders",
        ]);
        expect(snapshot.manifest.routes.find(({ path }) => path === "/public")?.authorization).toBeNull();
        expect(snapshot.manifest.routes.find(({ method }) => method === "GET")?.authorization).toEqual({
            mode: "all",
            permissions: [{ action: "invoke", resource: "GET:/orders/:id" }],
        });
        const post = snapshot.manifest.routes.find(({ method }) => method === "POST")!;
        expect(post.authorization).toEqual({
            mode: "all",
            permissions: [{ action: "create", resource: "POST:/orders" }],
        });
        const patch = snapshot.manifest.routes.find(({ method }) => method === "PATCH")!;
        expect(patch.authorization).toEqual({
            mode: "any",
            permissions: expect.arrayContaining([
                { action: "update", resource: "PATCH:/orders/:id" },
                { action: "manage", resource: "ui:button:orders.override" },
            ]),
        });
        expect(snapshot.apiBindings).toHaveLength(4);
        expect(snapshot.apiBindings.every((binding) => (
            binding.id.startsWith("vext:")
            && binding.purpose === "entry"
            && binding.owners?.length === 0
            && binding.description === `Vext route ${binding.method} ${binding.path}`
        ))).toBe(true);
        expect(Object.isFrozen(snapshot.manifest)).toBe(true);
        expect(Object.isFrozen(snapshot.apiBindings)).toBe(true);
        expect(Object.isFrozen(snapshot.contracts)).toBe(true);
        expect("set" in snapshot.contracts).toBe(false);
        const contractKeys = [...snapshot.contracts.keys()];
        expect(contractKeys).toHaveLength(5);
        expect(snapshot.contracts.has(contractKeys[0]!)).toBe(true);
        expect([...snapshot.contracts.entries()]).toEqual([...snapshot.contracts]);
        expect([...snapshot.contracts.values()]).toHaveLength(5);
        let callbackMap: ReadonlyMap<string, unknown> | undefined;
        snapshot.contracts.forEach((_value, _key, map) => {
            callbackMap = map;
        });
        expect(callbackMap).toBe(snapshot.contracts);
    });

    it("keeps portable digests independent from source paths and route enumeration order", () => {
        const first = buildVextRouteSnapshot(2, [
            route("GET", "/a", true, "C:/work/one.ts"),
            route("POST", "/b", { action: "create" }, "C:/work/two.ts"),
        ], schemes);
        const second = buildVextRouteSnapshot(2, [
            route("POST", "/b", { action: "create" }, "/different/two.ts"),
            route("GET", "/a", true, "/different/one.ts"),
        ], schemes);

        expect(first.manifest.digest).toBe(second.manifest.digest);
        expect([...first.contracts.values()].map(({ contractDigest }) => contractDigest))
            .toEqual([...second.contracts.values()].map(({ contractDigest }) => contractDigest));
        expect(first.manifest.routes.map(({ sourceFile }) => sourceFile))
            .not.toEqual(second.manifest.routes.map(({ sourceFile }) => sourceFile));
    });

    it("uses the stable route template when a requirement omits resource", () => {
        const contract = matchVextRouteContract(route("GET", "/orders/:id", {
            mode: "all",
            requirements: [
                { action: "read" },
                { action: "read", resource: "GET:/orders/:id" },
                { action: "manage", resource: "ui:page:orders" },
            ],
        }), schemes);

        expect(contract.evaluation?.requirements).toEqual(expect.arrayContaining([
            { action: "read", resource: "GET:/orders/:id" },
            { action: "manage", resource: "ui:page:orders" },
        ]));
    });

    it("rejects duplicate normalized routes, count drift, and malformed aggregate declarations", () => {
        expect(() => buildVextRouteSnapshot(2, [
            route("get", "//orders/", true),
            route("GET", "/orders", true),
        ], schemes)).toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
        expect(() => buildVextRouteSnapshot(2, [route("GET", "/orders")], schemes))
            .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
        for (const permission of [
            { mode: "any", requirements: [] },
            { mode: "some", requirements: [{ action: "read" }] },
            { mode: "all", requirements: [{ resource: "GET:/orders" }] },
            { mode: "all", requirements: [{ action: "read" }], extra: true },
        ]) {
            expect(() => buildVextRouteSnapshot(1, [route("GET", "/orders/:id", permission)], schemes))
                .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
        }
    });

    it("rejects Proxy, accessor, sparse, and oversized requirement inputs without executing traps", () => {
        let trapCalls = 0;
        const proxy = new Proxy({}, {
            get() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });
        const accessor = { action: "read" };
        Object.defineProperty(accessor, "resource", {
            enumerable: true,
            get() {
                trapCalls += 1;
                return "GET:/orders";
            },
        });
        const sparse = new Array(1);
        const oversized = Array.from({ length: 33 }, () => ({ action: "read" }));

        for (const permission of [
            proxy,
            accessor,
            { mode: "all", requirements: sparse },
            { mode: "all", requirements: oversized },
        ]) {
            expect(() => buildVextRouteSnapshot(1, [route("GET", "/orders", permission)], schemes))
                .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
        }
        expect(trapCalls).toBe(0);
    });

    it("rejects structural route metadata hazards and malformed route labels", () => {
        const symbolRoute = { ...route("GET", "/orders"), [Symbol("hidden")]: true };
        const inheritedRoute = Object.assign(Object.create({ inherited: true }), route("GET", "/orders"));
        const undefinedMethod = { ...route("GET", "/orders"), method: undefined };
        const nonEnumerableMethod = { ...route("GET", "/orders") };
        Object.defineProperty(nonEnumerableMethod, "method", { value: "GET", enumerable: false });
        const accessorOptions = { permission: true };
        Object.defineProperty(accessorOptions, "permission", {
            enumerable: true,
            get() {
                throw new Error("must not execute");
            },
        });
        const pollutedRoutes = [route("GET", "/orders")];
        Object.defineProperty(pollutedRoutes, "extra", { value: true, enumerable: true });
        const nonEnumerableRoutes = [route("GET", "/orders")];
        Object.defineProperty(nonEnumerableRoutes, "0", {
            value: nonEnumerableRoutes[0],
            enumerable: false,
        });

        for (const entry of [
            symbolRoute,
            inheritedRoute,
            undefinedMethod,
            nonEnumerableMethod,
            { ...route("GET", "/orders"), options: accessorOptions },
            route(1 as never, "/orders"),
            route("G ET", "/orders"),
            route("\ud800", "/orders"),
            route("GET", "orders"),
            route("GET", "/orders", { action: "read", resource: 42 }),
            route("GET", "/orders", { action: "read", resource: "unknown:value" }),
            { ...route("GET", "/orders"), sourceFile: "" },
            { ...route("GET", "/orders"), sourceFile: "src/\u0000orders.ts" },
            { ...route("GET", "/orders"), sourceFile: "x".repeat(4097) },
        ]) {
            expect(() => buildVextRouteSnapshot(1, [entry as VextRouteHookInfo], schemes))
                .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
        }
        for (const routes of [
            new Proxy([route("GET", "/orders")], {}),
            pollutedRoutes,
            nonEnumerableRoutes,
        ]) {
            expect(() => buildVextRouteSnapshot(1, routes, schemes))
                .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
        }
    });

    it("rejects route inventories beyond 20,000 items before normalization", () => {
        const routes = Array.from({ length: 20_001 }, (_, index) => route("GET", `/r/${index}`));
        expect(() => buildVextRouteSnapshot(routes.length, routes, schemes))
            .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
    });

    it("rejects manifest snapshots beyond the 8 MiB canonical budget", () => {
        const source = `src/${"x".repeat(4075)}.ts`;
        const routes = Array.from({ length: 2_100 }, (_, index) => route("GET", `/r/${index}`, false, source));
        expect(() => buildVextRouteSnapshot(routes.length, routes, schemes))
            .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
    });

    it("validates public manifests again before producing detached API binding inputs", () => {
        const snapshot = buildVextRouteSnapshot(1, [route("GET", "/orders", true)], schemes);
        const bindings = toApiBindingInputs(snapshot.manifest);
        expect(bindings).toEqual(snapshot.apiBindings);
        expect(bindings).not.toBe(snapshot.apiBindings);

        const tampered = {
            ...snapshot.manifest,
            routes: snapshot.manifest.routes.map((entry) => ({ ...entry, path: "/admin" })),
        } as VextRoutePermissionManifest;
        expect(() => toApiBindingInputs(tampered))
            .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));

        const portable = snapshot.manifest.routes.map(({ sourceFile: _sourceFile, ...entry }) => entry);
        const wrongDigest = {
            ...snapshot.manifest,
            digest: digestCanonical({ schemaVersion: 1, routes: portable, unexpected: true }),
        };
        expect(() => toApiBindingInputs(wrongDigest))
            .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
    });

    it("rejects malformed public manifest contracts before creating API bindings", () => {
        const snapshot = buildVextRouteSnapshot(1, [route("GET", "/orders", true)], schemes);
        const baseRoute = { ...snapshot.manifest.routes[0]! };
        const manifestFor = (routes: Record<string, unknown>[], overrides: Record<string, unknown> = {}) => {
            const portable = routes.map(({ sourceFile: _sourceFile, ...entry }) => entry);
            return {
                schemaVersion: 1,
                digest: digestCanonical({ schemaVersion: 1, routes: portable }),
                routes,
                ...overrides,
            } as unknown as VextRoutePermissionManifest;
        };
        const permission = { mode: "all", permissions: [{ action: "invoke", resource: "GET:/orders" }] };
        const invalidManifests = [
            manifestFor([baseRoute], { schemaVersion: 2 }),
            manifestFor([baseRoute], { digest: "invalid" }),
            manifestFor([{ ...baseRoute, method: "get" }]),
            manifestFor([{ ...baseRoute, path: "//orders/" }]),
            manifestFor([{ ...baseRoute, routeKey: "wrong" }]),
            manifestFor([{ ...baseRoute, authorization: { ...permission, mode: "some" } }]),
            manifestFor([{ ...baseRoute, authorization: { mode: "all", permissions: [] } }]),
            manifestFor([{ ...baseRoute, authorization: { mode: "all", permissions: [{}] } }]),
            manifestFor([{ ...baseRoute, authorization: { mode: "all", permissions: [{ action: "invoke" }] } }]),
            manifestFor([{ ...baseRoute, authorization: { mode: "all", permissions: [{ action: "invoke", resource: "" }] } }]),
            manifestFor([{ ...baseRoute, sourceFile: "" }]),
            manifestFor([baseRoute, { ...baseRoute }]),
        ];
        for (const manifest of invalidManifests) {
            expect(() => toApiBindingInputs(manifest))
                .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
        }

        const sparsePermissions = new Array(1);
        const sparseManifest = {
            schemaVersion: 1,
            digest: snapshot.manifest.digest,
            routes: [{
                ...baseRoute,
                authorization: { mode: "all", permissions: sparsePermissions },
            }],
        } as unknown as VextRoutePermissionManifest;
        expect(() => toApiBindingInputs(sparseManifest))
            .toThrowError(expect.objectContaining({ code: "VEXT_ROUTE_PERMISSION_INVALID" }));
    });
});
