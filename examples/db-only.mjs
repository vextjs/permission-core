import assert from "node:assert/strict";

import { MemoryAdapter, PermissionCore } from "permission-core";

async function main() {
    const pc = new PermissionCore({
        storage: new MemoryAdapter(),
    });

    await pc.init();

    try {
        await pc.roles.create("analyst", { label: "数据分析员" });
        await pc.roles.allow("analyst", "read", "db:reports", {
            where: { field: "ownerId", op: "eq", valueFrom: "userId" },
        });
        await pc.roles.allow("analyst", "read", "db:reports:title");
        await pc.roles.allow("analyst", "read", "db:reports:summary");
        await pc.users.assign("u-2", "analyst");

        const scope = await pc.getRowScope("u-2", "read", "db:reports");
        const rows = [
            { id: "r-1", ownerId: "u-2", title: "Q2", summary: "good", rawCost: 100 },
            { id: "r-2", ownerId: "other", title: "Q3", summary: "pending", rawCost: 200 },
        ];
        const visibleRows = await pc.filterRows("u-2", "read", "db:reports", rows);
        const safeFields = await pc.filterFields("u-2", "read", "db:reports", rows[0]);

        assert.deepEqual(scope, {
            mode: "conditional",
            include: { field: "ownerId", op: "eq", valueFrom: "userId" },
        });
        assert.equal(await pc.can("u-2", "read", "db:reports"), true);
        assert.equal(await pc.canRow("u-2", "read", "db:reports", rows[0]), true);
        assert.equal(await pc.canRow("u-2", "read", "db:reports", rows[1]), false);
        assert.deepEqual(visibleRows, [rows[0]]);
        assert.deepEqual(safeFields, {
            title: "Q2",
            summary: "good",
        });

        console.log("[db-only] ok");
        console.log(JSON.stringify({ scope, visibleRows, safeFields }, null, 2));
    } finally {
        await pc.close();
    }
}

main().catch((error) => {
    console.error("[db-only] failed");
    console.error(error);
    process.exitCode = 1;
});