import { describe, expect, it } from "vitest";
import type { ResourceSchemeDefinition } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";

describe("ResourceSchemeRegistry", () => {
    it("keeps built-in resource kinds isolated", () => {
        const registry = new ResourceSchemeRegistry();
        expect(registry.match("*:/api/orders/*", "GET:/api/orders/42")).toBe(true);
        expect(registry.match("api:GET:/api/orders/:id", "api:GET:/api/orders/42")).toBe(true);
        expect(registry.match("db:orders:field:profile.*", "db:orders:field:profile.email")).toBe(true);
        expect(registry.match("db:*", "db:orders")).toBe(true);
        expect(registry.match("db:*", "db:orders:field:id")).toBe(false);
        expect(registry.match("ui:*", "ui:button:orders.refund")).toBe(true);
        expect(registry.match("api:GET:/api/orders", "GET:/api/orders")).toBe(false);
        expect(() => registry.validate("db:*", "resource")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
    });

    it("treats matched HTTP route templates as conservative request resources", () => {
        const registry = new ResourceSchemeRegistry();
        expect(() => registry.validate("GET:/orders/:id", "resource")).not.toThrow();
        expect(() => registry.validate("api:GET:/orders/:id", "resource")).not.toThrow();
        expect(registry.match("GET:/orders/:id", "GET:/orders/:id")).toBe(true);
        expect(registry.match("GET:/orders/*", "GET:/orders/:id")).toBe(true);
        expect(registry.match("GET:/orders/42", "GET:/orders/:id")).toBe(false);
        expect(registry.match("api:GET:/orders/:recordId", "api:GET:/orders/:id")).toBe(true);
    });

    it("copies custom metadata and verifies deterministic probes", () => {
        const definition: ResourceSchemeDefinition = {
            scheme: "tenant",
            version: "1.0.0",
            probes: [
                { pattern: "tenant:*", resource: "tenant:alpha", expected: true },
                { pattern: "tenant:beta", resource: "tenant:alpha", expected: false },
            ],
            validate: (resource) => /^tenant:[a-z*]+$/u.test(resource),
            match: (pattern, resource) => pattern === "tenant:*" || pattern === resource,
        };
        const registry = new ResourceSchemeRegistry([definition]);
        registry.verifyProbes();
        expect(registry.match("tenant:*", "tenant:alpha")).toBe(true);
        expect(registry.match("tenant:beta", "tenant:alpha")).toBe(false);
        expect(registry.schemeContractDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    });

    it("rejects reserved schemes and non-deterministic callbacks", () => {
        expect(() => new ResourceSchemeRegistry([{
            scheme: "db",
            version: "1",
            probes: [{ pattern: "db:*", resource: "db:x", expected: true }],
            validate: () => true,
            match: () => true,
        }])).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));

        let result = false;
        const registry = new ResourceSchemeRegistry([{
            scheme: "flip",
            version: "1",
            probes: [{ pattern: "flip:*", resource: "flip:x", expected: true }],
            validate: () => true,
            match: () => {
                result = !result;
                return result;
            },
        }]);
        expect(() => registry.verifyProbes()).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    });

    it("bounds the number of custom definitions", () => {
        const definitions = Array.from({ length: 33 }, (_, index): ResourceSchemeDefinition => ({
            scheme: `s${index}`,
            version: "1",
            probes: [{ pattern: `s${index}:*`, resource: `s${index}:ok`, expected: true }],
            validate: () => true,
            match: () => true,
        }));
        expect(() => new ResourceSchemeRegistry(definitions.slice(0, 32))).not.toThrow();
        expect(() => new ResourceSchemeRegistry(definitions)).toThrowError(expect.objectContaining({
            code: "INVALID_CONFIGURATION",
            details: expect.objectContaining({ field: "resourceSchemes" }),
        }));
    });

    it("rejects Proxy and accessor-backed definition arrays before executing traps", () => {
        let trapCalls = 0;
        const proxiedDefinitions = new Proxy([], {
            get() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });
        const accessorProbes: unknown[] = [];
        Object.defineProperty(accessorProbes, "0", {
            enumerable: true,
            get() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });

        expect(() => new ResourceSchemeRegistry(proxiedDefinitions as never)).toThrowError(expect.objectContaining({
            code: "INVALID_CONFIGURATION",
            details: expect.objectContaining({ field: "resourceSchemes" }),
        }));
        expect(() => new ResourceSchemeRegistry([{
            scheme: "custom",
            version: "1",
            probes: accessorProbes as never,
            validate: () => true,
            match: () => true,
        }])).toThrowError(expect.objectContaining({
            code: "INVALID_CONFIGURATION",
            details: expect.objectContaining({ field: "resourceSchemes[0].probes[0]" }),
        }));
        expect(trapCalls).toBe(0);
    });

    it("fails closed when a custom callback throws at runtime", () => {
        const registry = new ResourceSchemeRegistry([{
            scheme: "custom",
            version: "1",
            probes: [{ pattern: "custom:*", resource: "custom:ok", expected: true }],
            validate: () => true,
            match: (pattern, resource) => {
                if (resource === "custom:boom") {
                    throw new Error("boom");
                }
                return pattern === "custom:*";
            },
        }]);
        registry.verifyProbes();
        expect(() => registry.match("custom:*", "custom:boom")).toThrowError(expect.objectContaining({ code: "INVALID_RESOURCE" }));
    });

    it("does not trust a forged PermissionCoreError name from a callback", () => {
        const registry = new ResourceSchemeRegistry([{
            scheme: "forged",
            version: "1",
            probes: [{ pattern: "forged:*", resource: "forged:ok", expected: true }],
            validate: () => true,
            match: (pattern, resource) => {
                if (resource === "forged:boom") {
                    const error = new Error("forged");
                    error.name = "PermissionCoreError";
                    throw error;
                }
                return pattern === "forged:*";
            },
        }]);
        registry.verifyProbes();

        expect(() => registry.match("forged:*", "forged:boom")).toThrowError(expect.objectContaining({
            name: "PermissionCoreError",
            code: "INVALID_RESOURCE",
        }));
    });

    it("rejects malformed Unicode in built-in resources and custom probes", () => {
        const registry = new ResourceSchemeRegistry();
        expect(() => registry.validate("GET:/orders/\ud800", "resource")).toThrowError(expect.objectContaining({
            code: "INVALID_RESOURCE",
        }));
        expect(() => new ResourceSchemeRegistry([{
            scheme: "custom",
            version: "1",
            probes: [{ pattern: "custom:*", resource: "custom:\ud800", expected: true }],
            validate: () => true,
            match: () => true,
        }])).toThrowError(expect.objectContaining({
            code: "INVALID_CONFIGURATION",
            details: expect.objectContaining({ field: "resourceSchemes[0].probes[0].resource" }),
        }));
    });
});
