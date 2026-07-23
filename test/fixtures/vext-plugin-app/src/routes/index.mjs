import { defineRoutes } from "vextjs";
import { Model } from "monsqlize";

const METRICS = Symbol.for("permission-core.vext.integration.metrics");

if (!Model.has("Order")) {
    Model.define("Order", {
        collection: "vext_orders",
        schema: (s) => s({
            tenantId: "string!",
            orderNo: "string!",
            status: "string!",
            amount: "number",
            internalCost: "number",
        }),
    });
}

function bumpHandler() {
    globalThis[METRICS] ??= { middleware: 0, handler: 0 };
    globalThis[METRICS].handler += 1;
}

export default defineRoutes((app) => {
    app.get("/public", {}, async (_req, res) => {
        res.json({ public: true });
    });

    app.get("/orders/:id", { permission: true }, async (req, res) => {
        res.json({ orderId: req.params.id, subject: req.auth.permission.subject });
    });

    app.get("/orders-with-fields", { permission: true }, async (_req, res) => {
        res.json({
            items: [
                { orderNo: "O-1", status: "paid", amount: 12, internalCost: 7 },
            ],
            total: 1,
            debug: true,
        });
    });

    app.get("/orders-data", { permission: true }, async (req, res) => {
        const items = await req.monsqlize.collection("vext_orders").find({}, {
            projection: ["orderNo", "status", "amount", "internalCost"],
            sort: { orderNo: 1 },
        });
        res.json({
            items,
            total: items.length,
            debug: true,
        });
    });

    app.get("/orders-transparent", {}, async (_req, res) => {
        const items = await app.db.collection("vext_orders").find({}, {
            projection: ["orderNo", "status", "amount", "internalCost"],
            sort: { orderNo: 1 },
        });
        res.json({ items, total: items.length });
    });

    app.get("/orders-model", {}, async (_req, res) => {
        const Order = app.db.model("Order");
        const items = await Order.find({}, {
            projection: ["orderNo", "status", "amount", "internalCost"],
            sort: { orderNo: 1 },
        });
        res.json({ items, total: items.length, collectionName: Order.collectionName });
    });

    app.get("/permissions/any", {
        permission: {
            mode: "any",
            requirements: [
                { action: "invoke", resource: "api:GET:/capabilities/one" },
                { action: "invoke", resource: "api:GET:/capabilities/two" },
            ],
        },
    }, async (_req, res) => {
        res.json({ mode: "any" });
    });

    app.get("/permissions/all", {
        permission: {
            mode: "all",
            requirements: [
                { action: "invoke", resource: "api:GET:/capabilities/one" },
                { action: "invoke", resource: "api:GET:/capabilities/two" },
            ],
        },
    }, async (_req, res) => {
        res.json({ mode: "all" });
    });

    app.get("/guard/:id", {
        permission: true,
        middlewares: ["marker"],
        validate: { param: { id: "uuid!" } },
    }, async (_req, res) => {
        bumpHandler();
        res.json({ guarded: true });
    });

    app.get("/errors/conflict", {}, async (_req, res) => {
        await app.permission.scope({ tenantId: "vext-host" }).roles.create({
            id: "duplicate-role",
            label: "Duplicate role",
        });
        res.json({ unreachable: true });
    });

    app.get("/errors/unexpected", {}, async () => {
        throw new Error("private-vext-handler-detail");
    });

    app.post("/fixture/reload", {}, async (_req, res) => {
        await app.hooks.emit("routes:ready", { count: 0, routes: [] });
        res.json({ reloadRequired: true });
    });
});
