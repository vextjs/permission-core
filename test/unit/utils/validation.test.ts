import { describe, expect, it } from "vitest";

import {
    assertDbResource,
    assertNonEmptyString,
    assertValidAction,
    assertValidResource,
    assertValidWhereCondition,
    isCacheLike,
    isPlainObject,
} from "../../../src/utils/validation";
import { PermissionCoreErrorCode, type RowCondition } from "../../../src/types";

async function expectPermissionError(fn: () => void, code: PermissionCoreErrorCode) {
    try {
        fn();
    } catch (error) {
        expect(error).toMatchObject({ code });
        return;
    }

    throw new Error(`Expected permission-core error '${code}'`);
}

describe("validation utils", () => {
    it("recognizes plain objects and rejects null or arrays", () => {
        expect(isPlainObject({ ok: true })).toBe(true);
        expect(isPlainObject(null)).toBe(false);
        expect(isPlainObject([1, 2, 3])).toBe(false);
        expect(isPlainObject("text")).toBe(false);
    });

    it("validates non-empty strings", () => {
        expect(() => assertNonEmptyString("user-001", "userId")).not.toThrow();
        expectPermissionError(() => assertNonEmptyString("", "userId"), PermissionCoreErrorCode.INVALID_ARGUMENT);
        expectPermissionError(() => assertNonEmptyString("   ", "userId"), PermissionCoreErrorCode.INVALID_ARGUMENT);
        expectPermissionError(() => assertNonEmptyString(1, "userId"), PermissionCoreErrorCode.INVALID_ARGUMENT);
    });

    it("accepts supported actions and rejects unsupported ones", () => {
        expect(() => assertValidAction("invoke")).not.toThrow();
        expect(() => assertValidAction("write")).not.toThrow();
        expect(() => assertValidAction("manage")).not.toThrow();
        expect(() => assertValidAction("*")).not.toThrow();
        expectPermissionError(() => assertValidAction("publish"), PermissionCoreErrorCode.INVALID_ACTION);
    });

    it("validates wildcard, http and db resource formats", () => {
        expect(() => assertValidResource("*")).not.toThrow();
        expect(() => assertValidResource("GET:/api/orders")).not.toThrow();
        expect(() => assertValidResource("*:/api/orders/*")).not.toThrow();
        expect(() => assertValidResource("db:orders")).not.toThrow();
        expect(() => assertValidResource("db:orders:status")).not.toThrow();
        expect(() => assertValidResource("ui:menu:system.user")).not.toThrow();
        expect(() => assertValidResource("ui:page:system.user.list")).not.toThrow();
        expect(() => assertValidResource("ui:button:system.user.delete")).not.toThrow();
        expect(() => assertValidResource("api:GET:/api/users/:id")).not.toThrow();
        expect(() => assertValidResource("api:*:/api/users")).not.toThrow();

        expectPermissionError(() => assertValidResource("db:"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("db:orders::status"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("db:orders:status:extra"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("ui:tab:system.user"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("ui:menu:"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("api:get:/api/users"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("api:GET:/api/users?debug=true"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("orders"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("get:/api/orders"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("GET:api/orders"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
        expectPermissionError(() => assertValidResource("GET:/api/orders?status=paid"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
    });

    it("requires db resources when explicitly requested", () => {
        expect(() => assertDbResource("db:orders")).not.toThrow();
        expectPermissionError(() => assertDbResource("GET:/api/orders"), PermissionCoreErrorCode.INVALID_RESOURCE_PATH);
    });

    it("validates nested row conditions and operator constraints", () => {
        const validAny: RowCondition = {
            any: [
                { field: "ownerId", op: "eq", valueFrom: "userId" },
                { not: { field: "archived", op: "exists", value: true } },
            ],
        };
        const validStandaloneAny: RowCondition = {
            any: [{ field: "ownerId", op: "eq", value: "u-1" }],
        };
        const validStandaloneAll: RowCondition = {
            all: [{ field: "ownerId", op: "eq", value: "u-1" }],
        };
        const validNot: RowCondition = {
            not: { field: "deletedAt", op: "exists", value: true },
        };

        expect(() => assertValidWhereCondition(validAny)).not.toThrow();
        expect(() => assertValidWhereCondition(validStandaloneAny)).not.toThrow();
        expect(() => assertValidWhereCondition(validStandaloneAll)).not.toThrow();
        expect(() => assertValidWhereCondition(validNot)).not.toThrow();
        expectPermissionError(() => assertValidWhereCondition({ all: [] }), PermissionCoreErrorCode.INVALID_ARGUMENT);
        expectPermissionError(() => assertValidWhereCondition({ any: [] }), PermissionCoreErrorCode.INVALID_ARGUMENT);
        expectPermissionError(() => assertValidWhereCondition({ field: "profile.ownerId", op: "eq", value: "u-1" }), PermissionCoreErrorCode.INVALID_ARGUMENT);
        expectPermissionError(() => assertValidWhereCondition({ field: "ownerId", op: "regex" as never, value: "u-1" }), PermissionCoreErrorCode.INVALID_ARGUMENT);
        expectPermissionError(() => assertValidWhereCondition({ field: "ownerId", op: "eq", value: "u-1", valueFrom: "userId" }), PermissionCoreErrorCode.INVALID_ARGUMENT);
        expectPermissionError(() => assertValidWhereCondition({ field: "ownerId", op: "eq" }), PermissionCoreErrorCode.INVALID_ARGUMENT);
        expect(() => assertValidWhereCondition({ field: "deletedAt", op: "exists" })).not.toThrow();
    });

    it("recognizes cache-like objects by duck typing", () => {
        const cacheLike = {
            get() { return null; },
            set() { return undefined; },
            del() { return undefined; },
            clear() { return undefined; },
        };

        expect(isCacheLike(cacheLike)).toBe(true);
        expect(isCacheLike({ ...cacheLike, clear: undefined })).toBe(false);
        expect(isCacheLike(null)).toBe(false);
    });
});
