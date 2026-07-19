import { describe, expect, it } from "vitest";
import type { PermissionCoreOptions } from "../../src";
import { resolvePermissionCoreOptions } from "../../src/core/config";

const monsqlize = {} as PermissionCoreOptions["monsqlize"];

function resolve(overrides: Readonly<Record<string, unknown>> = {}) {
    return resolvePermissionCoreOptions({ monsqlize, ...overrides } as PermissionCoreOptions);
}

function expectConfigurationError(run: () => unknown) {
    expect(run).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
}

describe("PermissionCore configuration boundaries", () => {
    it("rejects non-plain option containers and accessor-backed fields", () => {
        expectConfigurationError(() => resolvePermissionCoreOptions(null as never));

        const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
        inherited.monsqlize = monsqlize;
        expectConfigurationError(() => resolvePermissionCoreOptions(inherited as unknown as PermissionCoreOptions));

        const accessor = {} as Record<string, unknown>;
        Object.defineProperty(accessor, "monsqlize", {
            enumerable: true,
            get: () => monsqlize,
        });
        expectConfigurationError(() => resolvePermissionCoreOptions(accessor as unknown as PermissionCoreOptions));
    });

    it("distinguishes an explicitly disabled cache from an invalid disabled cache", () => {
        expect(resolve({ cache: { enabled: false } }).cache).toEqual({ enabled: false });
        expectConfigurationError(() => resolve({ cache: { enabled: false, ttlMs: 1_000 } }));
    });

    it("accepts both configured secret representations and rejects other values", () => {
        const text = "permission-core-configured-secret-at-least-32-bytes";
        const bytes = new Uint8Array(Buffer.from(text, "utf8"));

        expect(resolve({ tokenSecret: text })).toMatchObject({ tokenKeySource: "configured" });
        const resolvedBytes = resolve({ tokenSecret: bytes });
        expect(resolvedBytes.tokenKeySource).toBe("configured");
        expect(resolvedBytes.tokenSecret).toEqual(bytes);
        expect(resolvedBytes.tokenSecret).not.toBe(bytes);
        expectConfigurationError(() => resolve({ tokenSecret: 42 }));
    });

    it("snapshots bounded resource-scheme arrays and rejects invalid containers", () => {
        const scheme = { scheme: "custom" };
        const resolved = resolve({ resourceSchemes: [scheme] });
        expect(resolved.resourceSchemes).toEqual([scheme]);
        expect(Object.isFrozen(resolved.resourceSchemes)).toBe(true);

        expectConfigurationError(() => resolve({ resourceSchemes: {} }));
        expectConfigurationError(() => resolve({ resourceSchemes: new Array(33).fill(scheme) }));
    });

    it("requires a MonSQLize object or function", () => {
        expectConfigurationError(() => resolvePermissionCoreOptions({ monsqlize: null } as never));
    });
});
