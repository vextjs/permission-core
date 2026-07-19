import type { CacheLike } from "monsqlize";
import { describe, expect, it, vi } from "vitest";
import { PermissionCore } from "../../src";
import { createMonSQLizeStub } from "./helpers/monsqlize-stub";

const subject = Object.freeze({
    userId: "cache-user:*:[]",
    scope: Object.freeze({ tenantId: "cache-tenant:*:[]" }),
});

function installMapBackend(cache: CacheLike) {
    const store = new Map<string, unknown>();
    const methods = cache as unknown as {
        get: ReturnType<typeof vi.fn>;
        set: ReturnType<typeof vi.fn>;
        del: ReturnType<typeof vi.fn>;
        delPattern: ReturnType<typeof vi.fn>;
    };
    methods.get.mockImplementation(async (key: string) => store.get(key));
    methods.set.mockImplementation(async (key: string, value: unknown) => {
        store.set(key, value);
    });
    methods.del.mockImplementation(async (key: string) => store.delete(key));
    methods.delPattern.mockImplementation(async (pattern: string) => {
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
        let deleted = 0;
        for (const key of [...store.keys()]) {
            if (key.startsWith(prefix) && store.delete(key)) deleted += 1;
        }
        return deleted;
    });
    return { store, methods };
}

describe("PermissionCore semantic cache contract", () => {
    it("performs zero cache calls for the default path across init, read, health and close", async () => {
        const stub = createMonSQLizeStub();
        const core = new PermissionCore({ monsqlize: stub.instance });
        await core.init();
        await expect(core.can(subject, "read", "db:orders")).resolves.toBe(false);
        await core.health();
        await core.close();

        expect(stub.spies.getCache).not.toHaveBeenCalled();
        expect(stub.cache.get).not.toHaveBeenCalled();
        expect(stub.cache.set).not.toHaveBeenCalled();
        expect(stub.cache.del).not.toHaveBeenCalled();
        expect(stub.cache.delPattern).not.toHaveBeenCalled();
    });

    it("fills once and serves a permission hit without another scope-state read", async () => {
        const stub = createMonSQLizeStub();
        const backend = installMapBackend(stub.cache);
        const core = new PermissionCore({
            monsqlize: stub.instance,
            cache: { enabled: true, consistency: "ordered-bounded-stale", ttlMs: 30_000 },
        });
        await core.init();
        const scopeState = stub.collections.get("permission_core_scope_state")!;
        const findOne = scopeState.findOne as ReturnType<typeof vi.fn>;
        findOne.mockClear();

        await expect(core.can(subject, "read", "db:orders")).resolves.toBe(false);
        const coldReads = findOne.mock.calls.length;
        expect(coldReads).toBeGreaterThan(0);
        expect(backend.methods.set).toHaveBeenCalledTimes(1);
        await expect(core.can(subject, "read", "db:orders")).resolves.toBe(false);

        expect(findOne).toHaveBeenCalledTimes(coldReads);
        expect(backend.methods.get).toHaveBeenCalledTimes(2);
        const health = await core.health();
        expect(health.cache).toMatchObject({ hits: 1, misses: 1, readFallbacks: 0 });
        const keys = [...backend.store.keys()];
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^permission-core:v2:[A-Za-z0-9_-]{43}:scope:[A-Za-z0-9_-]{43}:user:[A-Za-z0-9_-]{43}:permissions$/u);
        expect(keys[0]).not.toContain(subject.userId);
        expect(keys[0]).not.toContain(subject.scope.tenantId);
        const serializedValue = JSON.stringify(backend.store.get(keys[0]!));
        expect(serializedValue).not.toContain(subject.userId);
        expect(serializedValue).not.toContain(subject.scope.tenantId);
    });

    it("falls back on get failure, clears the read incident after a successful get, and ignores set failure", async () => {
        const stub = createMonSQLizeStub();
        const get = stub.cache.get as ReturnType<typeof vi.fn>;
        const set = stub.cache.set as ReturnType<typeof vi.fn>;
        get.mockRejectedValueOnce(new Error("cache read failed"));
        set.mockRejectedValue(new Error("cache write failed"));
        const core = new PermissionCore({
            monsqlize: stub.instance,
            cache: { enabled: true, consistency: "ordered-bounded-stale", ttlMs: 30_000 },
        });
        await core.init();

        await expect(core.can(subject, "read", "db:orders")).resolves.toBe(false);
        expect(await core.health()).toMatchObject({
            status: "degraded",
            cache: { readIncidentActive: true, readFallbacks: 1, lastDegradedAt: expect.any(Number) },
        });
        await expect(core.can(subject, "read", "db:orders")).resolves.toBe(false);
        expect(await core.health()).toMatchObject({
            status: "up",
            cache: { readIncidentActive: false, misses: 1, readFallbacks: 1, lastDegradedAt: expect.any(Number) },
        });
        expect(set).toHaveBeenCalledTimes(2);
    });

    it("treats a malformed cached authorization value as untrusted and falls back fail closed", async () => {
        const stub = createMonSQLizeStub();
        const backend = installMapBackend(stub.cache);
        const core = new PermissionCore({
            monsqlize: stub.instance,
            cache: { enabled: true, consistency: "ordered-bounded-stale", ttlMs: 30_000 },
        });
        await core.init();
        await expect(core.can(subject, "read", "db:orders")).resolves.toBe(false);
        const [key] = [...backend.store.keys()];
        if (key === undefined) throw new Error("Expected a permission cache fill.");
        backend.store.set(key, { version: 1, family: "permissions", snapshot: { allow: true } });

        await expect(core.can(subject, "read", "db:orders")).resolves.toBe(false);
        await expect(core.health()).resolves.toMatchObject({
            status: "degraded",
            cache: { readIncidentActive: true, readFallbacks: 1 },
        });
        await core.close();
    });

    it("never clears or destroys the host-owned cache during close", async () => {
        const stub = createMonSQLizeStub();
        const clear = vi.fn();
        const destroy = vi.fn();
        Object.assign(stub.cache as object, { clear, destroy });
        const core = new PermissionCore({
            monsqlize: stub.instance,
            cache: { enabled: true, consistency: "ordered-bounded-stale" },
        });
        await core.init();
        await core.close();
        expect(clear).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
        expect(stub.spies.close).not.toHaveBeenCalled();
        expect(stub.spies.getCache).toHaveBeenCalledTimes(1);
    });
});
