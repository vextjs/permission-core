import { describe, expect, it } from "vitest";

import { MemoryAdapter, StorageAdapter, type PermissionRule, type RoleData } from "../../src";
import {
    LegacyScopedStorageAdapter,
    ScopedStorageProxy,
    isScopedStorageAdapter,
    toScopedStorageAdapter,
} from "../../src/scope";

const ROLE: RoleData = {
    id: "viewer",
    label: "Viewer",
    parent: null,
    description: "",
    createdAt: 1,
    updatedAt: 1,
};
const RULES: PermissionRule[] = [{ type: "allow", action: "read", resource: "ui:menu:users" }];

class LegacyStorage extends StorageAdapter {
    private readonly roles = new Map<string, RoleData>();
    private readonly userRoles = new Map<string, string[]>();
    private readonly rules = new Map<string, PermissionRule[]>();

    async init() {}
    async close() {}
    async getRoles() { return new Map(this.roles); }
    async getRole(id: string) { return this.roles.get(id) ?? null; }
    async setRole(id: string, role: RoleData) { this.roles.set(id, structuredClone(role)); }
    async deleteRole(id: string) { this.roles.delete(id); }
    async getUserRoles(userId: string) { return [...(this.userRoles.get(userId) ?? [])]; }
    async setUserRoles(userId: string, roleIds: string[]) { this.userRoles.set(userId, [...roleIds]); }
    async getUsersByRole(roleId: string) {
        return Array.from(this.userRoles).filter(([, roles]) => roles.includes(roleId)).map(([userId]) => userId);
    }
    async getRules(roleId: string) { return structuredClone(this.rules.get(roleId) ?? []); }
    async setRules(roleId: string, rules: PermissionRule[]) { this.rules.set(roleId, structuredClone(rules)); }
    async deleteRules(roleId: string) { this.rules.delete(roleId); }
}

describe("scoped storage compatibility", () => {
    it("recognizes native scoped storage only when every scoped method exists", () => {
        const scopedMethods = [
            "getScopedRoles",
            "getScopedRole",
            "setScopedRole",
            "deleteScopedRole",
            "getScopedUserRoles",
            "setScopedUserRoles",
            "getScopedUsersByRole",
            "getScopedRules",
            "setScopedRules",
            "deleteScopedRules",
        ] as const;

        for (const missingMethod of scopedMethods) {
            const incomplete = Object.create(new MemoryAdapter()) as Record<string, unknown>;
            incomplete[missingMethod] = undefined;
            expect(isScopedStorageAdapter(incomplete as never), missingMethod).toBe(false);
        }

        expect(isScopedStorageAdapter(new MemoryAdapter())).toBe(true);
    });

    it("adapts every legacy storage method to the configured default scope", async () => {
        const legacy = new LegacyStorage();
        expect(isScopedStorageAdapter(legacy)).toBe(false);
        const scoped = toScopedStorageAdapter(legacy, { tenantId: "legacy" });
        expect(scoped).toBeInstanceOf(LegacyScopedStorageAdapter);
        await scoped.init();

        const scope = { tenantId: "legacy" };
        await scoped.setScopedRole(scope, ROLE.id, ROLE);
        await scoped.setScopedUserRoles(scope, "user-1", [ROLE.id]);
        await scoped.setScopedRules(scope, ROLE.id, RULES);
        await expect(scoped.getScopedRoles(scope)).resolves.toEqual(new Map([[ROLE.id, ROLE]]));
        await expect(scoped.getScopedRole(scope, ROLE.id)).resolves.toEqual(ROLE);
        await expect(scoped.getScopedUserRoles(scope, "user-1")).resolves.toEqual([ROLE.id]);
        await expect(scoped.getScopedUsersByRole(scope, ROLE.id)).resolves.toEqual(["user-1"]);
        await expect(scoped.getScopedRules(scope, ROLE.id)).resolves.toEqual(RULES);
        expect(() => scoped.getScopedRole({ tenantId: "other" }, ROLE.id)).toThrow("does not support scope");

        await scoped.deleteScopedRules(scope, ROLE.id);
        await scoped.deleteScopedRole(scope, ROLE.id);
        await expect(scoped.getScopedRules(scope, ROLE.id)).resolves.toEqual([]);
        await expect(scoped.getScopedRole(scope, ROLE.id)).resolves.toBeNull();
        await scoped.close();
    });

    it("proxies the legacy StorageAdapter surface into one native scope", async () => {
        const native = new MemoryAdapter();
        expect(isScopedStorageAdapter(native)).toBe(true);
        expect(toScopedStorageAdapter(native)).toBe(native);
        const proxy = new ScopedStorageProxy(native, { tenantId: "tenant-a" });
        await proxy.init();

        await proxy.setRole(ROLE.id, ROLE);
        await proxy.setUserRoles("user-1", [ROLE.id]);
        await proxy.setRules(ROLE.id, RULES);
        await expect(proxy.getRoles()).resolves.toEqual(new Map([[ROLE.id, ROLE]]));
        await expect(proxy.getRole(ROLE.id)).resolves.toEqual(ROLE);
        await expect(proxy.getUserRoles("user-1")).resolves.toEqual([ROLE.id]);
        await expect(proxy.getUsersByRole(ROLE.id)).resolves.toEqual(["user-1"]);
        await expect(proxy.getRules(ROLE.id)).resolves.toEqual(RULES);

        await proxy.deleteRules(ROLE.id);
        await proxy.deleteRole(ROLE.id);
        await expect(proxy.getRules(ROLE.id)).resolves.toEqual([]);
        await expect(proxy.getRole(ROLE.id)).resolves.toBeNull();
        await proxy.close();
    });
});
