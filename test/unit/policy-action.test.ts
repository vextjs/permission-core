import { describe, expect, it } from "vitest";
import {
    expandPermissionAction,
    matchPermissionRuleAction,
    normalizePermissionAction,
    normalizePermissionRuleAction,
} from "../../src/policy";
import { PermissionCoreError } from "../../src";

describe("permission action policy", () => {
    it("normalizes built-in and custom actions", () => {
        expect(normalizePermissionAction("invoke")).toBe("invoke");
        expect(normalizePermissionAction("orders.refund:approve")).toBe("orders.refund:approve");
        expect(normalizePermissionRuleAction("*")).toBe("*");
    });

    it("rejects request wildcards and invalid grammar", () => {
        for (const action of ["*", "Read", " read", "read/one", "read..one", "a".repeat(65)]) {
            expect(() => normalizePermissionAction(action)).toThrowError(PermissionCoreError);
        }
        try {
            normalizePermissionAction("*");
        } catch (error) {
            expect(error).toMatchObject({ code: "INVALID_ACTION" });
        }
    });

    it("expands request write and matches rule-to-request semantics", () => {
        expect(expandPermissionAction("write")).toEqual(["create", "update"]);
        expect(matchPermissionRuleAction("write", "create")).toBe(true);
        expect(matchPermissionRuleAction("write", "update")).toBe(true);
        expect(matchPermissionRuleAction("write", "delete")).toBe(false);
        expect(matchPermissionRuleAction("write", "write")).toBe(true);
        expect(matchPermissionRuleAction("create", "write")).toBe(false);
        expect(matchPermissionRuleAction("*", "orders.refund")).toBe(true);
    });
});
