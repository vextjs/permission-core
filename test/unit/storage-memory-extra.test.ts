import { describe, expect, it } from "vitest";

import { MemoryAdapter } from "../../src";

describe("MemoryAdapter additional branch", () => {
    it("returns an empty list when a role has no bound users", async () => {
        const adapter = new MemoryAdapter();
        await adapter.init();

        await expect(adapter.getUsersByRole("missing-role")).resolves.toEqual([]);
    });
});