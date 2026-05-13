import assert from "node:assert/strict";

import { MemoryAdapter, PermissionCore } from "permission-core";

async function main() {
    const pc = new PermissionCore({
        storage: new MemoryAdapter(),
    });

    await pc.init();

    try {
        await pc.roles.create("operator", { label: "接口操作员" });
        await pc.roles.allow("operator", "invoke", "GET:/api/orders");
        await pc.roles.allow("operator", "invoke", "POST:/api/orders");
        await pc.users.setUserRoles("u-1", ["operator"]);

        assert.equal(await pc.can("u-1", "invoke", "GET:/api/orders"), true);
        assert.equal(await pc.cannot("u-1", "invoke", "DELETE:/api/orders"), true);
        assert.deepEqual((await pc.getResources("u-1", "invoke")).sort(), [
            "GET:/api/orders",
            "POST:/api/orders",
        ]);

        console.log("[http-only] ok");
        console.log(JSON.stringify({
            userId: "u-1",
            resources: await pc.getResources("u-1", "invoke"),
        }, null, 2));
    } finally {
        await pc.close();
    }
}

main().catch((error) => {
    console.error("[http-only] failed");
    console.error(error);
    process.exitCode = 1;
});