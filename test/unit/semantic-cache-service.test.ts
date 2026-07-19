import type { CacheLike } from "monsqlize";
import { describe, expect, it, vi } from "vitest";
import { PermissionSemanticCache } from "../../src/cache";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import { authorizationCacheTargets } from "../../src/menu/impact-support";

function cacheDouble() {
    const methods = {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        del: vi.fn(async () => false),
        delPattern: vi.fn(async () => 0),
        getStats: vi.fn(() => ({ hits: 1, misses: 2, entries: 3 })),
    };
    return { methods, cache: methods as unknown as CacheLike };
}

describe("PermissionSemanticCache invalidation and health", () => {
    it("maps exact user and scope targets only inside the fixed permission prefix", async () => {
        const backend = cacheDouble();
        const namespace = digestCanonical({ namespace: "cache-test" });
        const scopeHash = digestCanonical({ tenantId: "tenant:*:[]" });
        const userHash = digestCanonical({ userId: "user:*:[]" });
        const service = new PermissionSemanticCache(backend.cache, namespace, 1_000, new ResourceSchemeRegistry());

        await expect(service.invalidate([`scope:${scopeHash}:user:${userHash}`])).resolves.toBe("completed");
        expect(backend.methods.del).toHaveBeenCalledWith(
            `permission-core:v2:${namespace}:scope:${scopeHash}:user:${userHash}:permissions`,
        );
        expect((backend.methods.delPattern.mock.calls as unknown as [string][]).map(([pattern]) => pattern)).toEqual([
            `permission-core:v2:${namespace}:scope:${scopeHash}:user:${userHash}:menu-tree:*`,
            `permission-core:v2:${namespace}:scope:${scopeHash}:user:${userHash}:button-map:*`,
            `permission-core:v2:${namespace}:scope:${scopeHash}:user:${userHash}:route-state:*`,
        ]);

        await service.invalidate([`scope:${scopeHash}:menu`]);
        expect(backend.methods.delPattern).toHaveBeenLastCalledWith(
            `permission-core:v2:${namespace}:scope:${scopeHash}:*`,
        );
        expect(backend.methods.delPattern.mock.calls.flat().join("\n")).not.toContain("tenant:*:[]");
        expect(backend.methods.delPattern.mock.calls.flat().join("\n")).not.toContain("user:*:[]");
    });

    it("rejects malformed targets before cache I/O and records a bounded stale incident", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(10_000);
            const backend = cacheDouble();
            const service = new PermissionSemanticCache(
                backend.cache,
                digestCanonical({ namespace: "cache-test" }),
                500,
                new ResourceSchemeRegistry(),
            );
            await expect(service.invalidate(["scope:raw-tenant:user:raw-user"])).rejects.toThrow(/invalid shape/u);
            expect(backend.methods.del).not.toHaveBeenCalled();
            expect(backend.methods.delPattern).not.toHaveBeenCalled();
            expect(service.snapshotHealth(false)).toMatchObject({
                invalidationIncidentActive: true,
                invalidationRiskUntil: 10_500,
                invalidationFailures: 1,
                lastDegradedAt: 10_000,
            });

            const scopeHash = digestCanonical({ tenantId: "tenant" });
            await service.invalidate([`scope:${scopeHash}`]);
            expect(service.snapshotHealth(false).invalidationIncidentActive).toBe(true);
            vi.setSystemTime(10_500);
            await service.invalidate([`scope:${scopeHash}`]);
            expect(service.snapshotHealth(false)).toMatchObject({ invalidationIncidentActive: false });
            expect(service.snapshotHealth(false).invalidationRiskUntil).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps the precise invalidation target set bounded at 1000", () => {
        const scopeHash = digestCanonical({ tenantId: "tenant" });
        const affected = (total: number) => ({
            total,
            evaluated: Array.from({ length: total }, (_, index) => ({ userId: `user-${index}` } as never)),
            sampleIds: [],
            digest: digestCanonical({ total }),
        });
        const precise = authorizationCacheTargets(scopeHash, affected(999));
        expect(precise).toHaveLength(1_000);
        expect(precise[0]).toBe(`scope:${scopeHash}:menu`);
        expect(precise.slice(1).every((target) => /^scope:[A-Za-z0-9_-]{43}:user:[A-Za-z0-9_-]{43}$/u.test(target))).toBe(true);
        expect(precise.join("\n")).not.toContain("user-998");
        expect(authorizationCacheTargets(scopeHash, affected(1_000))).toEqual([`scope:${scopeHash}`]);
    });

    it("rejects more than 1000 aggregate targets before cache I/O", async () => {
        const backend = cacheDouble();
        const service = new PermissionSemanticCache(
            backend.cache,
            digestCanonical({ namespace: "cache-test" }),
            1_000,
            new ResourceSchemeRegistry(),
        );
        const scopeHash = digestCanonical({ tenantId: "tenant" });
        const targets = Array.from(
            { length: 1_001 },
            (_, index) => `scope:${scopeHash}:user:${digestCanonical({ userId: `user-${index}` })}`,
        );
        await expect(service.invalidate(targets)).rejects.toThrow(/1000 targets/u);
        expect(backend.methods.del).not.toHaveBeenCalled();
        expect(backend.methods.delPattern).not.toHaveBeenCalled();
    });

    it("exposes only finite non-negative backend stats and detaches without destroying the backend", () => {
        const backend = cacheDouble();
        const service = new PermissionSemanticCache(
            backend.cache,
            digestCanonical({ namespace: "cache-test" }),
            1_000,
            new ResourceSchemeRegistry(),
        );
        expect(service.snapshotHealth(true).backendStats).toEqual({ hits: 1, misses: 2, entries: 3 });
        backend.methods.getStats.mockReturnValueOnce({ hits: Number.NaN, misses: 2, entries: 3 });
        expect(service.snapshotHealth(true).backendStats).toBeUndefined();
        let accessorCalls = 0;
        const accessorStats = {};
        Object.defineProperty(accessorStats, "hits", {
            enumerable: true,
            get() {
                accessorCalls += 1;
                return 1;
            },
        });
        backend.methods.getStats.mockReturnValueOnce(accessorStats as never);
        expect(service.snapshotHealth(true).backendStats).toBeUndefined();
        expect(accessorCalls).toBe(0);
        service.detach();
        expect(service.snapshotHealth(true).backendStats).toBeUndefined();
    });

    it("contains cache serialization failures without changing the caller result", async () => {
        const backend = cacheDouble();
        const service = new PermissionSemanticCache(
            backend.cache,
            digestCanonical({ namespace: "cache-test" }),
            1_000,
            new ResourceSchemeRegistry(),
        );
        const value = new Proxy({}, {}) as never;
        await expect(service.setMenuTree(
            { userId: "u-1", scope: { tenantId: "t-1" } },
            {},
            { rbacRevision: 1, menuRevision: 1 },
            undefined,
            value,
        )).resolves.toBe(false);
        expect(backend.methods.set).not.toHaveBeenCalled();
        expect(service.snapshotMetrics()).toMatchObject({ writeFailures: 1, lastDegradedAt: expect.any(Number) });
    });

    it("exposes stale reappearance when a backend violates the awaited set ordering attestation", async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000);
            const store = new Map<string, unknown>();
            const methods = {
                get: vi.fn(async (key: string) => store.get(key)),
                set: vi.fn(async (key: string, value: unknown) => {
                    setTimeout(() => store.set(key, value), 10);
                }),
                del: vi.fn(async (key: string) => store.delete(key)),
                delPattern: vi.fn(async (pattern: string) => {
                    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
                    let deleted = 0;
                    for (const key of [...store.keys()]) {
                        if (key.startsWith(prefix) && store.delete(key)) deleted += 1;
                    }
                    return deleted;
                }),
            };
            const service = new PermissionSemanticCache(
                methods as unknown as CacheLike,
                digestCanonical({ namespace: "cache-test" }),
                1_000,
                new ResourceSchemeRegistry(),
            );
            const subject = { userId: "u-1", scope: { tenantId: "t-1" } } as const;
            const revisions = { rbacRevision: 1, menuRevision: 1 } as const;
            const result = {
                data: [],
                detailBudget: { limit: 100 as const, returned: 0, truncated: false, digest: digestCanonical([]) },
            };

            await expect(service.setMenuTree(subject, {}, revisions, undefined, result)).resolves.toBe(true);
            await service.invalidate([`scope:${digestCanonical(subject.scope)}:menu`]);
            await vi.advanceTimersByTimeAsync(10);
            await expect(service.getMenuTree(subject, {}, revisions, undefined)).resolves.toEqual(result);
        } finally {
            vi.useRealTimers();
        }
    });
});
