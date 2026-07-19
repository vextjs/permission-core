import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import {
    createClaimsFingerprint,
    createContextFingerprint,
    createScopeKey,
    normalizePolicyContext,
    normalizeScope,
    normalizeSubject,
} from "../../src/scope";
import {
    assertNonNegativeSafeInteger,
    assertPositiveSafeInteger,
    normalizeDescription,
    normalizeRbacId,
    normalizeRoleLabel,
} from "../../src/rbac/validation";
import {
    DetailBudgetAllocator,
    fitAuthorizationPage,
    rbacEtag,
    revisionVector,
} from "../../src/rbac/result";

function expectPermissionError(run: () => unknown, code?: string) {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionCoreError);
    if (code) expect(caught).toMatchObject({ code });
}

describe("RBAC scalar validation boundaries", () => {
    it("normalizes canonical identifiers and rejects unsafe representations", () => {
        expect(normalizeRbacId(" reader ", "roleId")).toBe("reader");
        for (const value of [null, "\ud800", " ", "reader\u0000", "__proto__", "prototype", "constructor"]) {
            expectPermissionError(() => normalizeRbacId(value, "roleId"));
        }
        expectPermissionError(() => normalizeRbacId("x".repeat(129), "roleId"), "LIMIT_EXCEEDED");
    });

    it("counts labels/descriptions by Unicode characters and enforces their limits", () => {
        expect(normalizeRoleLabel(" Operator ")).toBe("Operator");
        expect(normalizeDescription(" description ")).toBe(" description ");
        for (const value of [null, "\ud800", " "]) {
            expectPermissionError(() => normalizeRoleLabel(value));
        }
        expectPermissionError(() => normalizeRoleLabel("x".repeat(257)), "LIMIT_EXCEEDED");
        expectPermissionError(() => normalizeDescription(null));
        expectPermissionError(() => normalizeDescription("\ud800"));
        expectPermissionError(() => normalizeDescription("x".repeat(4_097)), "LIMIT_EXCEEDED");
    });

    it("requires exact safe integer domains", () => {
        expect(assertNonNegativeSafeInteger(0, "revision")).toBe(0);
        expect(assertPositiveSafeInteger(1, "pageSize")).toBe(1);
        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
            expectPermissionError(() => assertNonNegativeSafeInteger(value, "revision"));
        }
        for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
            expectPermissionError(() => assertPositiveSafeInteger(value, "pageSize"));
        }
    });
});

describe("scope and subject boundaries", () => {
    it("normalizes complete scope/subject/context and produces stable fingerprints", () => {
        const scope = normalizeScope({ tenantId: " tenant-a ", appId: "admin", moduleId: "orders", namespace: "prod" });
        const subject = normalizeSubject({ userId: " user-1 ", scope, claims: { merchantId: "m-1" } });
        expect(scope).toEqual({ tenantId: "tenant-a", appId: "admin", moduleId: "orders", namespace: "prod" });
        expect(subject).toMatchObject({ userId: "user-1", claims: { merchantId: "m-1" } });
        expect(createScopeKey(scope)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(createClaimsFingerprint(subject)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(createContextFingerprint({ request: { channel: "admin" } })).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(normalizePolicyContext()).toEqual({});
    });

    it("rejects non-string and oversized scope/subject identifiers", () => {
        expectPermissionError(() => normalizeScope({ tenantId: 1 } as never), "INVALID_SUBJECT");
        expectPermissionError(() => normalizeScope({ tenantId: "x".repeat(129) }), "INVALID_SUBJECT");
        expectPermissionError(() => normalizeSubject({ userId: 1, scope: { tenantId: "tenant-a" } } as never), "INVALID_SUBJECT");
        expectPermissionError(() => normalizeSubject({ userId: "x".repeat(129), scope: { tenantId: "tenant-a" } }), "INVALID_SUBJECT");
    });
});

describe("bounded authorization result helpers", () => {
    it("allocates one shared detail budget and restores nested limits after failures", () => {
        const allocator = new DetailBudgetAllocator();
        expect(() => allocator.withRemainingLimit(-1, () => undefined)).toThrow(TypeError);
        expect(() => allocator.withRemainingLimit(101, () => undefined)).toThrow(TypeError);
        expect(() => allocator.sample([1, 2], 1)).toThrow(TypeError);

        expect(() => allocator.withRemainingLimit(1, () => {
            expect(allocator.bounded(["a", "b"]).items).toEqual(["a"]);
            throw new Error("restore");
        })).toThrow("restore");
        expect(allocator.bounded(["c", "d"]).items).toEqual(["c", "d"]);
        expect(allocator.finish({ complete: true })).toMatchObject({ returned: 3, truncated: true, limit: 100 });
    });

    it("sorts revision vectors and rejects overflow or duplicate identities", () => {
        const state = { revision: 4, rbacRevision: 3, menuRevision: 2, auditRevision: 1 } as never;
        expect(revisionVector(state, [
            { kind: "role", id: "z", revision: 1 },
            { kind: "role", id: "a", revision: 2 },
        ]).entities.map((entry) => entry.id)).toEqual(["a", "z"]);
        expectPermissionError(() => revisionVector(state, Array.from({ length: 66 }, (_, index) => ({
            kind: "role" as const,
            id: `role-${index}`,
            revision: 1,
        }))), "LIMIT_EXCEEDED");
        expectPermissionError(() => revisionVector(state, [
            { kind: "role", id: "reader", revision: 1 },
            { kind: "role", id: "reader", revision: 2 },
        ]), "PERSISTED_STATE_INVALID");
        expect(rbacEtag(3, "query")).toBe('W/"pc-rbac-3-query"');
    });

    it("fits the largest response page and preserves unrelated failures", () => {
        expect(() => fitAuthorizationPage(-1, () => 0)).toThrow(TypeError);
        expect(fitAuthorizationPage(0, (count) => count)).toBe(0);
        expect(fitAuthorizationPage(8, (count) => {
            if (count > 5) {
                throw new PermissionCoreError("LIMIT_EXCEEDED", "too large", {
                    details: {
                        kind: "limit-exceeded",
                        origin: "persisted-authorization-state",
                        limitName: "public-response-bytes",
                        current: count,
                        max: 5,
                        unit: "items",
                    },
                });
            }
            return count;
        })).toBe(5);
        expect(() => fitAuthorizationPage(2, () => {
            throw new Error("unrelated");
        })).toThrow("unrelated");
    });
});
