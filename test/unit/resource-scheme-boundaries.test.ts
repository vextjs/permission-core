import { describe, expect, it } from "vitest";
import { PermissionCoreError, type ResourceSchemeDefinition } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";

function definition(overrides: Partial<ResourceSchemeDefinition> = {}): ResourceSchemeDefinition {
    return {
        scheme: "custom",
        version: "1",
        probes: [{ pattern: "custom:*", resource: "custom:ok", expected: true }],
        validate: (resource) => resource.startsWith("custom:"),
        match: (pattern, resource) => pattern === "custom:*" || pattern === resource,
        ...overrides,
    };
}

function expectConfigurationError(run: () => unknown) {
    expect(run).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
}

describe("custom resource scheme structural boundaries", () => {
    it("rejects malformed definition and probe containers", () => {
        expectConfigurationError(() => new ResourceSchemeRegistry({} as never));
        const tagged = [definition()] as ResourceSchemeDefinition[] & { extra?: boolean };
        tagged.extra = true;
        expectConfigurationError(() => new ResourceSchemeRegistry(tagged));
        expectConfigurationError(() => new ResourceSchemeRegistry([null] as never));
        expectConfigurationError(() => new ResourceSchemeRegistry([new Proxy(definition(), {})]));
        expectConfigurationError(() => new ResourceSchemeRegistry([definition({ probes: [] })]));
        expectConfigurationError(() => new ResourceSchemeRegistry([definition({ probes: new Array(1) as never })]));
    });

    it("rejects invalid scheme/version/callback and probe field contracts", () => {
        const invalid: ResourceSchemeDefinition[] = [
            definition({ scheme: "Bad" }),
            definition({ version: "bad version" }),
            definition({ validate: true as never }),
            definition({ match: true as never }),
            definition({ probes: [{ pattern: "", resource: "custom:ok", expected: true }] }),
            definition({ probes: [{ pattern: "custom:\ud800", resource: "custom:ok", expected: true }] }),
            definition({ probes: [{ pattern: "custom:*", resource: "", expected: true }] }),
            definition({ probes: [{ pattern: "custom:*", resource: "custom:ok", expected: "yes" as never }] }),
            definition({ probes: [
                { pattern: "custom:*", resource: "custom:ok", expected: true },
                { pattern: "custom:*", resource: "custom:ok", expected: true },
            ] }),
            definition({ probes: [{ pattern: "other:*", resource: "custom:ok", expected: true }] }),
        ];
        for (const value of invalid) expectConfigurationError(() => new ResourceSchemeRegistry([value]));
        expectConfigurationError(() => new ResourceSchemeRegistry([definition(), definition()]));
    });
});

describe("custom resource scheme callback boundaries", () => {
    it("rejects nonboolean, false, nondeterministic, and throwing probe callbacks", () => {
        const invalid = [
            definition({ validate: () => "yes" as never }),
            definition({ validate: () => false }),
            definition({ match: () => "yes" as never }),
            definition({ match: () => false }),
            definition({ validate: () => { throw new Error("validate"); } }),
            definition({ match: () => { throw new Error("match"); } }),
        ];
        for (const value of invalid) {
            const registry = new ResourceSchemeRegistry([value]);
            expectConfigurationError(() => registry.verifyProbes());
        }
    });

    it("fails closed for invalid runtime custom validation and matching", () => {
        const rejected = new ResourceSchemeRegistry([definition({ validate: (resource) => resource !== "custom:bad" })]);
        expect(() => rejected.validate("custom:bad", "resource")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));

        const throwingValidation = new ResourceSchemeRegistry([definition({
            validate: (resource) => {
                if (resource === "custom:boom") throw new Error("boom");
                return true;
            },
        })]);
        expect(() => throwingValidation.validate("custom:boom", "resource")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));

        const nonBooleanMatch = new ResourceSchemeRegistry([definition({ match: () => "yes" as never })]);
        expect(() => nonBooleanMatch.match("custom:*", "custom:ok")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
        const crossScheme = new ResourceSchemeRegistry([
            definition(),
            definition({
                scheme: "other",
                probes: [{ pattern: "other:*", resource: "other:ok", expected: true }],
                validate: (resource) => resource.startsWith("other:"),
                match: (pattern, resource) => pattern === "other:*" || pattern === resource,
            }),
        ]);
        expect(crossScheme.match("custom:*", "other:ok")).toBe(false);
    });

    it("enforces wildcard, built-in grammar, unknown scheme, and byte limits", () => {
        const registry = new ResourceSchemeRegistry();
        expect(registry.match("*", "db:orders")).toBe(true);
        expect(() => registry.validate("*", "resource")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
        expect(() => registry.validate("", "resource")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
        expect(() => registry.validate("x".repeat(1_025), "resource")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
        expect(() => registry.validate("db:bad:shape:extra", "resource")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
        expect(() => registry.validate("unknown:value", "resource")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
    });

    it("makes HTTP, database-field, and UI grammar boundaries explicit", () => {
        const registry = new ResourceSchemeRegistry();
        const invalidResources = [
            "GET:\ud800",
            "GET:",
            "GET:/orders/",
            "GET:/orders/:9bad",
            "GET:/ord*ers",
            "*:/orders",
            "db:\ud800",
            "db:bad name",
            "db:orders:field:",
            "db:orders:field:*",
            "ui:\ud800:orders",
            "ui:menu",
            "ui:menu:",
            "ui:menu:*",
        ] as const;
        for (const resource of invalidResources) {
            expect(() => registry.validate(resource, "resource")).toThrowError(
                expect.objectContaining({ code: "INVALID_RESOURCE" }),
            );
        }

        expect(() => registry.validate("GET:/", "resource")).not.toThrow();
        expect(registry.match("*:/orders", "GET:/orders")).toBe(true);
        expect(registry.match("GET:/orders/*", "GET:/orders/1")).toBe(true);
        expect(() => registry.match("GET:/orders/*/edit", "GET:/orders/1/edit")).toThrowError(
            expect.objectContaining({ code: "INVALID_RESOURCE" }),
        );
        expect(registry.match("db:*", "db:orders")).toBe(true);
        expect(registry.match("db:orders:field:*", "db:orders:field:id")).toBe(true);
        expect(registry.match("db:orders:field:profile.*", "db:orders:field:profile.name")).toBe(true);
        expect(registry.match("ui:menu:*", "ui:menu:orders")).toBe(true);
    });

    it("preserves an actual PermissionCoreError thrown by a callback", () => {
        const expected = new PermissionCoreError("INVALID_RESOURCE", "callback failure");
        const registry = new ResourceSchemeRegistry([definition({
            validate: (resource) => {
                if (resource === "custom:boom") throw expected;
                return true;
            },
        })]);
        expect(() => registry.validate("custom:boom", "resource")).toThrow(expected);
    });
});
