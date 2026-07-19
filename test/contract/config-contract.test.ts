import { describe, expect, it } from "vitest";
import {
    PermissionCore,
    PermissionCoreError,
} from "../../src";
import { createMonSQLizeStub } from "./helpers/monsqlize-stub";

function expectConfigurationFailure(run: () => unknown, field: string) {
    expect(run).toThrowError(expect.objectContaining({
        name: "PermissionCoreError",
        code: "INVALID_CONFIGURATION",
        details: expect.objectContaining({ kind: "validation", field }),
    }));
}

describe("PermissionCore configuration", () => {
    it("constructs from the minimal configuration without host I/O", () => {
        const stub = createMonSQLizeStub();
        const core = new PermissionCore({ monsqlize: stub.instance });

        expect(core).toBeInstanceOf(PermissionCore);
        expect(stub.spies.connect).not.toHaveBeenCalled();
        expect(stub.spies.collection).not.toHaveBeenCalled();
        expect(stub.spies.getCache).not.toHaveBeenCalled();
        expect(stub.spies.health).not.toHaveBeenCalled();
    });

    it("rejects legacy aliases and incomplete cache states", () => {
        const stub = createMonSQLizeStub();
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, storage: {} } as never),
            "options",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, cache: {} } as never),
            "cache.enabled",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, cache: { enabled: false, ttlMs: 100 } } as never),
            "cache",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, cache: { enabled: true } } as never),
            "cache.consistency",
        );
        expectConfigurationFailure(
            () => new PermissionCore({
                monsqlize: stub.instance,
                cache: { enabled: true, consistency: "ordered-bounded-stale", ttlMs: 99 },
            }),
            "cache.ttlMs",
        );
        expect(() => new PermissionCore({
            monsqlize: stub.instance,
            cache: { enabled: true, consistency: "ordered-bounded-stale", ttlMs: 100 },
        })).not.toThrow();
        expect(() => new PermissionCore({
            monsqlize: stub.instance,
            cache: { enabled: true, consistency: "ordered-bounded-stale", ttlMs: 86_400_000 },
        })).not.toThrow();
        expectConfigurationFailure(
            () => new PermissionCore({
                monsqlize: stub.instance,
                cache: { enabled: true, consistency: "ordered-bounded-stale", ttlMs: 86_400_001 },
            }),
            "cache.ttlMs",
        );
        expectConfigurationFailure(
            () => new PermissionCore({
                monsqlize: stub.instance,
                cache: { enabled: true, consistency: "ordered-bounded-stale", unknown: true },
            } as never),
            "cache",
        );
        expectConfigurationFailure(
            () => new PermissionCore(new Proxy({ monsqlize: stub.instance }, {}) as never),
            "options",
        );
    });

    it("rejects unsafe prefixes, timeouts, and short token secrets", () => {
        const stub = createMonSQLizeStub();
        expect(() => new PermissionCore({
            monsqlize: stub.instance,
            collectionPrefix: "a".repeat(64),
        })).not.toThrow();
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, collectionPrefix: "bad.prefix" }),
            "collectionPrefix",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, collectionPrefix: "a".repeat(65) }),
            "collectionPrefix",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, closeDrainTimeoutMs: 999 }),
            "closeDrainTimeoutMs",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, tokenSecret: "too-short" }),
            "tokenSecret",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, tokenSecret: "\ud800".repeat(32) }),
            "tokenSecret",
        );
    });

    it("rejects Proxy secrets and malformed scheme arrays without executing traps", () => {
        const stub = createMonSQLizeStub();
        let trapCalls = 0;
        const proxiedSecret = new Proxy(new Uint8Array(32), {
            get() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });
        const proxiedSchemes = new Proxy([], {
            get() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });
        const accessorSchemes: unknown[] = [];
        Object.defineProperty(accessorSchemes, "0", {
            enumerable: true,
            get() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });
        const extendedSchemes = [] as unknown[] & { extra?: boolean };
        extendedSchemes.extra = true;

        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, tokenSecret: proxiedSecret }),
            "tokenSecret",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, resourceSchemes: proxiedSchemes }),
            "resourceSchemes",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, resourceSchemes: accessorSchemes as never }),
            "resourceSchemes[0]",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, resourceSchemes: new Array(1) as never }),
            "resourceSchemes",
        );
        expectConfigurationFailure(
            () => new PermissionCore({ monsqlize: stub.instance, resourceSchemes: extendedSchemes as never }),
            "resourceSchemes",
        );
        expect(trapCalls).toBe(0);
    });

    it("enforces required error detail discriminators", () => {
        expect(() => new PermissionCoreError("LIMIT_EXCEEDED", "bad")).toThrow(TypeError);
        const error = new PermissionCoreError("LIMIT_EXCEEDED", "bounded", {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: "items",
                current: 2,
                max: 1,
                unit: "items",
            },
        });
        expect(error.retryable).toBe(false);
        expect(error.details?.kind).toBe("limit-exceeded");
        expect(Object.isFrozen(error.details)).toBe(true);

        const details = { kind: "validation" as const, reason: "original" };
        const snapshot = new PermissionCoreError("INVALID_ARGUMENT", "snapshot", { details });
        details.reason = "mutated";
        expect(snapshot.details).toEqual({ kind: "validation", reason: "original" });
    });
});
