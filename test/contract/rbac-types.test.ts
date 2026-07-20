import { describe, expect, it } from "vitest";
import type {
    MenuConfigManager,
    MenuConfigRootManager,
    RoleManager,
    RowCondition,
    ScopedPermissionContext,
    SubjectPermissionContext,
    SubjectMenuRuntime,
    UserRoleManager,
} from "../../src";
import type { InternalRoleRuleSource } from "../../src/persistence/documents";

describe("public RBAC and menu type contract", () => {
    it("exposes the complete scoped manager and subject method sets", () => {
        const roleMethods: readonly (keyof RoleManager)[] = [
            "create", "get", "list", "update", "previewAccessUpdate", "executeAccessUpdate",
            "getRemovalImpact", "remove", "allow", "deny", "revoke", "previewRuleChange",
            "executeRuleChange", "previewReplaceRules", "replaceRules", "getOwnRules",
            "listOwnRules", "getEffectiveRules", "getChain",
        ];
        const userRoleMethods: readonly (keyof UserRoleManager)[] = [
            "assign", "revoke", "set", "clear", "getDirect", "getEffective", "listUsersByRole",
        ];
        const menuRootMethods: readonly (keyof MenuConfigRootManager)[] = [
            "config",
        ];
        const menuConfigMethods: readonly (keyof MenuConfigManager)[] = [
            "preview", "save", "get", "list", "previewRemove", "remove", "previewChanges", "applyChanges",
        ];
        const scopedKeys: readonly (keyof ScopedPermissionContext)[] = [
            "roles", "userRoles", "menus",
        ];
        const subjectMethods: readonly (keyof SubjectPermissionContext)[] = [
            "can", "cannot", "assert", "getPermissions", "getResources", "explain", "menus", "data",
        ];
        const subjectComplete: Exclude<keyof SubjectPermissionContext, typeof subjectMethods[number]> extends never ? true : false = true;
        const subjectMenuMethods: readonly (keyof SubjectMenuRuntime)[] = [
            "getViewTree", "getActionMap", "getViewState", "filterResponse",
        ];
        expect(roleMethods).toHaveLength(19);
        expect(userRoleMethods).toHaveLength(7);
        expect(menuRootMethods).toHaveLength(1);
        expect(menuConfigMethods).toHaveLength(8);
        expect(scopedKeys).toEqual(["roles", "userRoles", "menus"]);
        expect(subjectMethods).toHaveLength(8);
        expect(subjectComplete).toBe(true);
        expect(subjectMenuMethods).toHaveLength(4);
    });
});

if (false) {
    const literal: RowCondition = { field: "merchantId", op: "eq", value: "m-1" };
    const dynamic: RowCondition = { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" };
    const nested: RowCondition = { all: [literal, { not: dynamic }] };
    void nested;

    // @ts-expect-error Empty all groups are not policy conditions.
    const empty: RowCondition = { all: [] };
    // @ts-expect-error A condition cannot provide literal and dynamic operands together.
    const ambiguous: RowCondition = { field: "merchantId", op: "eq", value: "m-1", valueFrom: "claims.merchantId" };
    const menuConfig = (null as unknown as ScopedPermissionContext).menus.config;
    // @ts-expect-error scoped.apiBindings is not a public 3.0 manager.
    const legacyApiBindings = (null as unknown as ScopedPermissionContext).apiBindings;
    const manualSource: InternalRoleRuleSource = { kind: "manual", sourceId: "manual:key" };
    // @ts-expect-error API is a menu contribution, never a top-level persisted source kind.
    const legacyApiSource: InternalRoleRuleSource = { kind: "api", sourceId: "legacy" };
    void [empty, ambiguous, menuConfig, legacyApiBindings, manualSource, legacyApiSource];
}
