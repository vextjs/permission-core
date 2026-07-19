import assert from "node:assert/strict";

import { MemoryAdapter, PermissionCore } from "permission-core";

const pc = new PermissionCore({
    storage: new MemoryAdapter(),
});

await pc.init();

try {
    await pc.roles.create("order-reader", { label: "Order reader" });
    await pc.roles.allow("order-reader", "invoke", "GET:/api/orders");
    await pc.users.assign("u-1", "order-reader");

    const allowed = await pc.can("u-1", "invoke", "GET:/api/orders");
    const blocked = await pc.cannot("u-1", "invoke", "DELETE:/api/orders");

    assert.equal(allowed, true);
    assert.equal(blocked, true);
    console.log(`[first-success] allowed=${allowed} blocked=${blocked}`);
} finally {
    await pc.close();
}
