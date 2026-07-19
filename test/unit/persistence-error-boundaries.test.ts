import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src/core/errors";
import {
    assertAuditChangeBudget,
    assertCanonicalBudget,
    assertInternalDocumentBudget,
    assertRoleMenuGrantBudget,
} from "../../src/persistence/documents";
import {
    mapDatabaseReadError,
    mapDatabaseWriteError,
} from "../../src/persistence/repository";

describe("database error classification", () => {
    it.each([
        { code: 6 },
        { code: "econnreset" },
        { codeName: "NetworkTimeout" },
        { name: "MongoServerSelectionError" },
        { cause: { cause: { code: 91 } } },
        { message: "server selection timed out" },
        { cause: { message: "connection refused by host" } },
    ])("maps unavailable read causes without losing the original cause", (cause) => {
        const mapped = mapDatabaseReadError("read failed", cause);
        expect(mapped).toMatchObject({
            code: "DATABASE_UNAVAILABLE",
            details: { kind: "database-failure", stage: "read" },
            cause,
        });
    });

    it("distinguishes ordinary read/write failures and preserves domain errors", () => {
        expect(mapDatabaseReadError("read failed", new Error("bad BSON"))).toMatchObject({
            code: "DATABASE_ERROR",
            details: { kind: "database-failure", stage: "read" },
        });
        expect(mapDatabaseWriteError("write failed", { code: "ETIMEDOUT" })).toMatchObject({
            code: "DATABASE_UNAVAILABLE",
            details: { kind: "database-failure", stage: "write" },
        });
        expect(mapDatabaseWriteError("write failed", "plain failure")).toMatchObject({
            code: "DATABASE_ERROR",
            details: { kind: "database-failure", stage: "write" },
        });

        const domain = new PermissionCoreError("INVALID_ARGUMENT", "invalid", {
            details: { kind: "validation", field: "roleId", reason: "invalid" },
        });
        expect(mapDatabaseReadError("unused", domain)).toBe(domain);
        expect(mapDatabaseWriteError("unused", domain)).toBe(domain);
    });
});

describe("persisted document budgets", () => {
    it("returns canonical byte counts and retains the requested failure origin", () => {
        expect(assertCanonicalBudget({ ok: true }, "tiny", 32, "caller-input")).toBeGreaterThan(0);
        expect(() => assertCanonicalBudget("abcd", "tiny", 5, "preview-budget")).toThrow(expect.objectContaining({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ origin: "preview-budget", limitName: "tiny" }),
        }));
    });

    it("maps canonical and BSON encoding failures to persisted-state errors", () => {
        expect(() => assertCanonicalBudget({ value: Number.POSITIVE_INFINITY }, "invalid", 100))
            .toThrow(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
        expect(() => assertCanonicalBudget({ value: () => undefined }, "invalid", 100))
            .toThrow(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(() => assertCanonicalBudget(cycle, "invalid", 100))
            .toThrow(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
        expect(() => assertInternalDocumentBudget([]))
            .toThrow(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
    });

    it("applies the dedicated audit and role-menu budget names", () => {
        expect(assertAuditChangeBudget({ action: "create" })).toBeGreaterThan(0);
        expect(assertRoleMenuGrantBudget({ roleId: "reader", nodeIds: ["orders"] })).toBeGreaterThan(0);
    });
});
