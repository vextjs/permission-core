import { printExample, startExampleCore } from "./_support/host.mjs";

// docs:data-guard:start
const runtime = await startExampleCore("data-guard");
const scope = { tenantId: "tenant-a" };
const collectionName = "example_orders";
const scoped = runtime.core.scope(scope);

try {
    await scoped.roles.create({ id: "merchant-reader", label: "Merchant reader" });
    await scoped.roles.allow("merchant-reader", {
        action: "read",
        resource: "db:orders",
        where: { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" },
    });
    await scoped.roles.allow("merchant-reader", {
        action: "read",
        resource: "db:orders:field:merchantId",
    });
    await scoped.roles.allow("merchant-reader", {
        action: "read",
        resource: "db:orders:field:publicValue",
    });
    await scoped.roles.allow("merchant-reader", {
        action: "read",
        resource: "db:orders:field:status",
    });
    await scoped.roles.allow("merchant-reader", {
        action: "read",
        resource: "db:orders:field:ownerId",
    });
    await scoped.roles.deny("merchant-reader", {
        action: "read",
        resource: "db:orders:field:secret",
    });
    await scoped.roles.allow("merchant-reader", {
        action: "create",
        resource: "db:orders",
        where: { field: "ownerId", op: "eq", valueFrom: "subject.userId" },
    });
    await scoped.roles.allow("merchant-reader", {
        action: "update",
        resource: "db:orders",
        where: { field: "ownerId", op: "eq", valueFrom: "subject.userId" },
    });
    await scoped.roles.allow("merchant-reader", {
        action: "update",
        resource: "db:orders:field:ownerId",
    });
    await scoped.roles.allow("merchant-reader", {
        action: "update",
        resource: "db:orders:field:status",
    });
    await scoped.userRoles.assign("u-data", "merchant-reader");

    const raw = runtime.database.monsqlize.collection(collectionName).raw();
    await raw.insertMany([
        { tenantId: "tenant-a", merchantId: "m-1", status: "paid", publicValue: "visible", secret: "hidden-a" },
        { tenantId: "tenant-a", merchantId: "m-2", status: "paid", publicValue: "wrong merchant", secret: "hidden-b" },
        { tenantId: "tenant-b", merchantId: "m-1", status: "paid", publicValue: "wrong tenant", secret: "hidden-c" },
        { tenantId: "tenant-a", merchantId: "m-1", status: "draft", publicValue: "wrong status", secret: "hidden-d" },
    ]);

    const orders = runtime.core.forSubject({
        userId: "u-data",
        scope,
        claims: { merchantId: "m-1" },
    }).data.collection(collectionName, {
        resource: "db:orders",
        scopeFields: { tenantId: "tenantId" },
    });

    // The caller filter is AND-ed with tenant isolation and the role rule's where.
    const rows = await orders.find(
        { status: "paid" },
        { projection: ["merchantId", "publicValue"] },
    );
    let deniedFieldCode = null;
    try {
        await orders.find({}, { projection: ["secret"] });
    } catch (error) {
        deniedFieldCode = error.code;
    }
    const inserted = await orders.insertOne({
        merchantId: "m-1",
        ownerId: "u-data",
        status: "draft",
        publicValue: "new order",
    });
    const updated = await orders.updateOne(
        { ownerId: "u-data" },
        { $set: { status: "paid" } },
    );
    let deniedWriteCode = null;
    try {
        await orders.insertOne({
            merchantId: "m-1",
            ownerId: "another-user",
            status: "draft",
            publicValue: "must not persist",
        });
    } catch (error) {
        deniedWriteCode = error.code;
    }

    printExample("data-guard", {
        composition: ["caller filter", "tenant scope", "role where", "field projection"],
        matchedRows: rows,
        matchedCount: rows.length,
        deniedFieldCode,
        writeGuard: {
            inserted: inserted.acknowledged,
            updated: updated.modifiedCount === 1,
            deniedWriteCode,
        },
        persistedRows: await raw.countDocuments({}),
    });
} finally {
    await runtime.close();
}
// docs:data-guard:end
