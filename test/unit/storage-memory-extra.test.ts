import { describe, expect, it } from "vitest";

import { MemoryAdapter } from "../../src";

describe("MemoryAdapter additional branch", () => {
    it("preserves scoped role IDs containing the internal separator", async () => {
        const adapter = new MemoryAdapter();
        const scope = { tenantId: "default" };
        const role = {
            id: "team::admin",
            label: "Team Admin",
            parent: null,
            description: "",
            createdAt: 1,
            updatedAt: 1,
        };
        await adapter.init();
        await adapter.setScopedRole(scope, role.id, role);

        await expect(adapter.getScopedRoles(scope)).resolves.toEqual(new Map([[role.id, role]]));
        await adapter.close();
    });

    it("returns an empty list when a role has no bound users", async () => {
        const adapter = new MemoryAdapter();
        await adapter.init();

        await expect(adapter.getUsersByRole("missing-role")).resolves.toEqual([]);
    });
});
