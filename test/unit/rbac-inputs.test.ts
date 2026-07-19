import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import {
    normalizeManualRuleSelector,
    normalizePermissionRuleInput,
    normalizeRoleCreateInput,
    normalizeRoleIdList,
    normalizeRoleUpdateInput,
} from "../../src/rbac";

const schemes = new ResourceSchemeRegistry();

describe("RBAC input normalization", () => {
    it("normalizes role defaults and metadata patches", () => {
        expect(normalizeRoleCreateInput({ id: " operator ", label: " Operator " })).toEqual({
            id: "operator",
            label: "Operator",
            status: "enabled",
            parentId: null,
        });
        expect(normalizeRoleUpdateInput({ description: null })).toEqual({ description: null });
    });

    it("rejects extra, undefined, empty, and Proxy role input before I/O", () => {
        let traps = 0;
        const proxy = new Proxy({ id: "operator", label: "Operator" }, {
            ownKeys() {
                traps += 1;
                return [];
            },
        });
        const invalid = [
            { id: "operator", label: "Operator", revision: 1 },
            { id: "operator", label: undefined },
            { id: "operator", label: "" },
            {},
        ];
        for (const value of invalid) {
            expect(() => normalizeRoleCreateInput(value as never)).toThrowError(PermissionCoreError);
        }
        expect(() => normalizeRoleCreateInput(proxy)).toThrowError(PermissionCoreError);
        expect(traps).toBe(0);
    });

    it("normalizes and validates manual rule identity", () => {
        const rule = normalizePermissionRuleInput({
            action: "read",
            resource: "db:orders",
            where: { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" },
        }, schemes);
        const selector = normalizeManualRuleSelector({ effect: "allow", ...rule }, schemes);
        expect(selector.semanticKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(() => normalizeManualRuleSelector({
            effect: "allow",
            ...rule,
            semanticKey: "x".repeat(43),
        }, schemes)).toThrowError(PermissionCoreError);
    });

    it("sorts unique role IDs and rejects normalized duplicates or sparse arrays", () => {
        expect(normalizeRoleIdList(["reader", " operator "])).toEqual(["operator", "reader"]);
        expect(normalizeRoleIdList(Array.from({ length: 128 }, (_, index) => `r-${index}`))).toHaveLength(128);
        expect(() => normalizeRoleIdList(["operator", " operator "])).toThrowError(PermissionCoreError);
        expect(() => normalizeRoleIdList(new Array(1))).toThrowError(PermissionCoreError);
        expect(() => normalizeRoleIdList(Array.from({ length: 129 }, (_, index) => `r-${index}`))).toThrowError(PermissionCoreError);
    });
});
