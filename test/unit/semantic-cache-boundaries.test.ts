import type { CacheLike } from "monsqlize";
import { describe, expect, it, vi } from "vitest";
import {
    MAX_SEMANTIC_CACHE_VALUE_BYTES,
    PermissionSemanticCache,
} from "../../src/cache";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import { loadEffectiveAuthorization } from "../../src/rbac/effective";
import { createVirtualUserRoleSet } from "../../src/rbac/materialize";
import { createScopeKey } from "../../src/scope/scope";

const subject = { userId: "cache-user", scope: { tenantId: "cache-tenant" } } as const;
const revisions = { rbacRevision: 3, menuRevision: 5 } as const;
const namespace = digestCanonical({ namespace: "semantic-cache-boundaries" });
const emptyDigest = digestCanonical([]);

function result<T>(data: T, returned = 0) {
    return {
        data,
        detailBudget: { limit: 100 as const, returned, truncated: false, digest: emptyDigest },
    };
}

function memoryBackend() {
    const values = new Map<string, unknown>();
    const methods = {
        get: vi.fn(async (key: string) => values.get(key)),
        set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
        del: vi.fn(async (key: string) => values.delete(key)),
        delPattern: vi.fn(async (pattern: string) => {
            const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
            let deleted = 0;
            for (const key of [...values.keys()]) {
                if (key.startsWith(prefix) && values.delete(key)) deleted += 1;
            }
            return deleted;
        }),
        getStats: vi.fn<() => unknown>(() => ({ entries: values.size })),
    };
    return { values, methods, cache: methods as unknown as CacheLike };
}

function service(backend: CacheLike) {
    return new PermissionSemanticCache(backend, namespace, 1_000, new ResourceSchemeRegistry());
}

describe("PermissionSemanticCache service boundaries", () => {
    it("rejects an unbound namespace digest", () => {
        expect(() => new PermissionSemanticCache({} as never, "raw-namespace", 1_000, new ResourceSchemeRegistry()))
            .toThrow(/canonical SHA-256 digest/u);
    });

    it("round-trips menu, button, route, and virtual permission snapshots", async () => {
        const backend = memoryBackend();
        const cache = service(backend.cache);
        const tree = result([]);
        const buttons = result({
            save: {
                visible: true,
                enabled: true,
                reason: "allowed" as const,
                action: "invoke",
                resource: "ui:button:save",
                apiRisks: { total: 0, items: [], truncated: false, digest: emptyDigest },
            },
        });
        const route = result({
            allowed: true,
            reason: "allowed" as const,
            nodeId: "orders",
            action: "read",
            resource: "ui:page:orders",
            matchedPath: "/orders",
            apiRisks: { total: 0, items: [], truncated: false, digest: emptyDigest },
            navigationReachable: true,
            navigationReason: "reachable" as const,
        });

        await expect(cache.setMenuTree(subject, { locale: "en" }, revisions, undefined, tree)).resolves.toBe(true);
        await expect(cache.getMenuTree(subject, { locale: "en" }, revisions, undefined)).resolves.toEqual(tree);
        await expect(cache.setButtonMap(subject, {}, revisions, "orders", buttons)).resolves.toBe(true);
        await expect(cache.getButtonMap(subject, {}, revisions, "orders")).resolves.toEqual(buttons);
        await expect(cache.setRouteState(subject, {}, revisions, "/orders", route)).resolves.toBe(true);
        await expect(cache.getRouteState(subject, {}, revisions, "/orders")).resolves.toEqual(route);

        const scopeKey = createScopeKey(subject.scope);
        const direct = createVirtualUserRoleSet(subject.scope, scopeKey, subject.userId);
        const state = await loadEffectiveAuthorization({
            async readRoles() { return new Map(); },
            async readRulesForRoles() { return []; },
            async resolveRulesForAuthorization() { return { rules: [], sourceViews: new Map() }; },
        }, direct);
        await expect(cache.setPermissions(subject, revisions, state)).resolves.toBe(true);
        await expect(cache.getPermissions(subject)).resolves.toMatchObject({
            rbacRevision: 3,
            menuRevision: 5,
            state: { direct: { persisted: false, roleIds: [] } },
        });
        expect(cache.snapshotMetrics()).toMatchObject({ hits: 4, misses: 0, writeFailures: 0 });
    });

    it("treats missing, expired-revision, corrupt, rejected, and detached reads as fallbacks", async () => {
        const backend = memoryBackend();
        const cache = service(backend.cache);
        await expect(cache.getMenuTree(subject, {}, revisions, undefined)).resolves.toBeUndefined();
        expect(cache.snapshotHealth(false)).toMatchObject({ misses: 1, readIncidentActive: false });

        await cache.setMenuTree(subject, {}, revisions, undefined, result([]));
        await expect(cache.getMenuTree(subject, {}, { ...revisions, menuRevision: 6 }, undefined))
            .resolves.toBeUndefined();
        expect(cache.snapshotHealth(false).misses).toBe(2);

        const key = [...backend.values.keys()][0]!;
        backend.values.set(key, { corrupt: true });
        await expect(cache.getMenuTree(subject, {}, revisions, undefined)).resolves.toBeUndefined();
        expect(cache.snapshotHealth(false)).toMatchObject({ readFallbacks: 1, readIncidentActive: true });

        backend.methods.get.mockRejectedValueOnce(new Error("backend unavailable"));
        await expect(cache.getMenuTree(subject, {}, revisions, undefined)).resolves.toBeUndefined();
        expect(cache.snapshotHealth(false).readFallbacks).toBe(2);

        cache.detach();
        await expect(cache.getMenuTree(subject, {}, revisions, undefined)).resolves.toBeUndefined();
        expect(cache.snapshotHealth(false).readFallbacks).toBe(3);
    });

    it("contains detached, rejected, serialization, and oversized writes", async () => {
        const detachedBackend = memoryBackend();
        const detached = service(detachedBackend.cache);
        detached.detach();
        await expect(detached.setMenuTree(subject, {}, revisions, undefined, result([]))).resolves.toBe(false);
        expect(detached.snapshotMetrics().writeFailures).toBe(1);

        const rejectedBackend = memoryBackend();
        rejectedBackend.methods.set.mockRejectedValueOnce(new Error("write failed"));
        const rejected = service(rejectedBackend.cache);
        await expect(rejected.setMenuTree(subject, {}, revisions, undefined, result([]))).resolves.toBe(false);
        expect(rejected.snapshotMetrics().writeFailures).toBe(1);

        const invalid = service(memoryBackend().cache);
        await expect(invalid.setMenuTree(subject, {}, revisions, undefined, new Proxy({}, {}) as never))
            .resolves.toBe(false);
        expect(invalid.snapshotMetrics().writeFailures).toBe(1);

        const oversizedBackend = memoryBackend();
        const oversized = service(oversizedBackend.cache);
        await expect(oversized.setMenuTree(subject, {}, revisions, undefined, result([{
            id: "root",
            parentId: null,
            type: "directory" as const,
            title: "x".repeat(MAX_SEMANTIC_CACHE_VALUE_BYTES),
            order: 0,
            visible: true,
            enabled: true,
            reason: "allowed" as const,
            apiRisks: { total: 0, items: [], truncated: false, digest: emptyDigest },
            children: [],
        }]))).resolves.toBe(false);
        expect(oversizedBackend.methods.set).not.toHaveBeenCalled();
        expect(oversized.snapshotMetrics().oversizedSkips).toBe(1);
    });

    it("invalidates exact subjects and reports detached or backend failures", async () => {
        const backend = memoryBackend();
        const cache = service(backend.cache);
        await cache.setMenuTree(subject, {}, revisions, undefined, result([]));
        await expect(cache.invalidateSubject(subject)).resolves.toBe("completed");
        expect(backend.values.size).toBe(0);

        backend.methods.delPattern.mockRejectedValueOnce(new Error("delete failed"));
        await expect(cache.invalidate([`scope:${createScopeKey(subject.scope)}:rbac`])).rejects.toThrow("delete failed");
        expect(cache.snapshotHealth(false)).toMatchObject({
            invalidationIncidentActive: true,
            invalidationFailures: 1,
        });

        cache.detach();
        await expect(cache.invalidate([`scope:${createScopeKey(subject.scope)}`])).rejects.toThrow(/detached/u);
        await expect(cache.invalidate([1 as never])).rejects.toThrow(/must be a string/u);
    });

    it("accepts only bounded plain finite backend statistics", () => {
        const backend = memoryBackend();
        const cache = service(backend.cache);
        expect(cache.snapshotHealth(true).backendStats).toEqual({ entries: 0 });

        const cases: unknown[] = [
            null,
            [],
            new Proxy({}, {}),
            new Date(),
            Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, index])),
            { [Symbol("count")]: 1 },
            { constructor: 1 },
            { count: "1" },
            { count: Number.POSITIVE_INFINITY },
            { count: -1 },
        ];
        for (const value of cases) {
            backend.methods.getStats.mockReturnValueOnce(value);
            expect(cache.snapshotHealth(true).backendStats).toBeUndefined();
        }
        const hidden = {};
        Object.defineProperty(hidden, "count", { value: 1, enumerable: false });
        backend.methods.getStats.mockReturnValueOnce(hidden);
        expect(cache.snapshotHealth(true).backendStats).toBeUndefined();
        backend.methods.getStats.mockImplementationOnce(() => { throw new Error("stats failed"); });
        expect(cache.snapshotHealth(true).backendStats).toBeUndefined();
        expect(cache.snapshotHealth(false).backendStats).toBeUndefined();
    });
});
