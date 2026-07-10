import { describe, expect, it } from "vitest";

import {
    MemoryAdapter,
    PermissionCore,
    getPermissionScopeKey,
    normalizePermissionScope,
} from "../../src";
import { PermissionCache } from "../../src/cache";
import type { PermissionRule } from "../../src/types";

const RULES: PermissionRule[] = [
    {
        type: "allow",
        action: "read",
        resource: "ui:menu:system.user",
    },
];

describe("scoped permission core", () => {
    it("normalizes scope and creates stable keys", () => {
        expect(normalizePermissionScope({ tenantId: "tenant-a", appId: "admin" })).toEqual({
            tenantId: "tenant-a",
            appId: "admin",
        });

        expect(getPermissionScopeKey({ tenantId: "tenant-a", appId: "admin", moduleId: "sys", namespace: "ops" }))
            .toBe("tenant:tenant-a|app:admin|module:sys|ns:ops");

        expect(() => normalizePermissionScope({ appId: "admin" }))
            .toThrow("tenantId must be a non-empty string");
    });

    it("isolates the same user and role across tenants", async () => {
        const pc = new PermissionCore();
        await pc.init();

        const tenantA = pc.scope({ tenantId: "tenant-a", appId: "admin" });
        const tenantB = pc.scope({ tenantId: "tenant-b", appId: "admin" });

        await tenantA.roles.create("manager", { label: "Manager A" });
        await tenantA.roles.allow("manager", "read", "ui:menu:system.user");
        await tenantA.users.assign("user-1", "manager");

        await tenantB.roles.create("manager", { label: "Manager B" });
        await tenantB.roles.allow("manager", "read", "ui:menu:system.audit");
        await tenantB.users.assign("user-1", "manager");

        await expect(tenantA.can("user-1", "read", "ui:menu:system.user")).resolves.toBe(true);
        await expect(tenantA.can("user-1", "read", "ui:menu:system.audit")).resolves.toBe(false);
        await expect(tenantB.can("user-1", "read", "ui:menu:system.user")).resolves.toBe(false);
        await expect(tenantB.can("user-1", "read", "ui:menu:system.audit")).resolves.toBe(true);

        await expect(pc.canSubject({ tenantId: "tenant-a", appId: "admin", userId: "user-1" }, "read", "ui:menu:system.user"))
            .resolves.toBe(true);
        await expect(pc.getResourcesForSubject({ tenantId: "tenant-b", appId: "admin", userId: "user-1" }, "read"))
            .resolves.toEqual(["ui:menu:system.audit"]);
    });

    it("keeps legacy userId API on the default scope", async () => {
        const pc = new PermissionCore();
        await pc.init();

        await pc.roles.create("viewer", { label: "Viewer" });
        await pc.roles.allow("viewer", "read", "ui:menu:default");
        await pc.users.assign("user-legacy", "viewer");

        await pc.scope({ tenantId: "tenant-a" }).roles.create("viewer", { label: "Tenant Viewer" });

        await expect(pc.can("user-legacy", "read", "ui:menu:default")).resolves.toBe(true);
        await expect(pc.canSubject({ tenantId: "tenant-a", userId: "user-legacy" }, "read", "ui:menu:default"))
            .resolves.toBe(false);
    });

    it("rejects a subject from another scope in a bound scope context", async () => {
        const pc = new PermissionCore();
        await pc.init();
        const tenantA = pc.scope({ tenantId: "tenant-a", appId: "admin" });

        expect(() => tenantA.forSubject({ tenantId: "tenant-b", appId: "admin", userId: "user-1" }))
            .toThrow("subject scope does not match the bound permission scope");

        await expect(pc.canSubject({ userId: "user-1" } as never, "read", "ui:menu:users"))
            .rejects.toThrow("tenantId must be a non-empty string");
    });

    it("separates permission cache by scope and supports scope invalidation", async () => {
        const cache = new PermissionCache({ ttl: 60_000 });
        const tenantA = { tenantId: "tenant-a" };
        const tenantB = { tenantId: "tenant-b" };

        await cache.set("user-1", RULES, tenantA);
        await cache.set("user-1", [{ ...RULES[0], resource: "ui:menu:system.audit" }], tenantB);

        await expect(cache.get("user-1", tenantA)).resolves.toEqual(RULES);
        await expect(cache.get("user-1", tenantB)).resolves.toEqual([
            { ...RULES[0], resource: "ui:menu:system.audit" },
        ]);

        await cache.invalidateScope(tenantA);

        await expect(cache.get("user-1", tenantA)).resolves.toBeNull();
        await expect(cache.get("user-1", tenantB)).resolves.toEqual([
            { ...RULES[0], resource: "ui:menu:system.audit" },
        ]);
    });

    it("invalidates the configured default scope through the legacy root API", async () => {
        const storage = new MemoryAdapter();
        const defaultScope = { tenantId: "tenant-default", appId: "admin" };
        const pc = new PermissionCore({ storage, defaultScope });
        await pc.init();

        await pc.roles.create("viewer", { label: "Viewer" });
        await pc.roles.allow("viewer", "read", "ui:menu:default");
        await pc.users.assign("user-1", "viewer");
        await expect(pc.can("user-1", "read", "ui:menu:default")).resolves.toBe(true);

        await storage.setScopedRules(defaultScope, "viewer", []);
        await pc.invalidate("user-1");

        await expect(pc.can("user-1", "read", "ui:menu:default")).resolves.toBe(false);
        await pc.close();
    });
});
