import assert from "node:assert/strict";

import { MemoryCache } from "cache-hub";
import { MemoryAdapter, PermissionCore } from "permission-core";

async function main() {
    const pc = new PermissionCore({
        storage: new MemoryAdapter(),
        cache: new MemoryCache({
            defaultTtl: 300_000,
            maxEntries: 100,
        }),
    });

    await pc.init();

    try {
        await pc.roles.create("support", { label: "客服" });
        await pc.roles.allow("support", "invoke", "GET:/api/tickets");
        await pc.roles.allow("support", "read", "db:tickets", {
            where: { field: "ownerId", op: "eq", valueFrom: "userId" },
        });
        await pc.roles.allow("support", "read", "db:tickets:id");
        await pc.roles.allow("support", "read", "db:tickets:subject");
        await pc.roles.allow("support", "read", "db:tickets:status");

        await pc.roles.create("support-manager", {
            label: "客服主管",
            parent: "support",
        });
        await pc.roles.allow("support-manager", "invoke", "POST:/api/tickets");
        await pc.users.assign("u-100", "support-manager");

        const tickets = [
            { id: "t-1", ownerId: "u-100", subject: "refund", status: "open", internalNote: "vip" },
            { id: "t-2", ownerId: "other", subject: "invoice", status: "closed", internalNote: "finance" },
        ];

        const resources = (await pc.getResources("u-100", "invoke")).sort();
        const permissions = await pc.getPermissions("u-100");
        const visibleTickets = await pc.filterRows("u-100", "read", "db:tickets", tickets);
        const safeTicket = await pc.filterFields("u-100", "read", "db:tickets", tickets[0]);

        assert.deepEqual(resources, [
            "GET:/api/tickets",
            "POST:/api/tickets",
        ]);
        assert.equal(await pc.can("u-100", "invoke", "GET:/api/tickets"), true);
        assert.equal(await pc.can("u-100", "invoke", "POST:/api/tickets"), true);
        assert.equal(await pc.cannot("u-100", "invoke", "DELETE:/api/tickets"), true);
        assert.equal(permissions.length, 6);
        assert.deepEqual(visibleTickets, [tickets[0]]);
        assert.deepEqual(safeTicket, {
            id: "t-1",
            subject: "refund",
            status: "open",
        });

        await pc.invalidate("u-100");
        await pc.invalidateAll();

        console.log("[complete-flow] ok");
        console.log(JSON.stringify({ resources, permissions, visibleTickets, safeTicket }, null, 2));
    } finally {
        await pc.close();
    }
}

main().catch((error) => {
    console.error("[complete-flow] failed");
    console.error(error);
    process.exitCode = 1;
});