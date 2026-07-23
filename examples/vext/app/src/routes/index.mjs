import { defineRoutes } from "vextjs";
import { Model } from "monsqlize";

if (!Model.has("Order")) {
    Model.define("Order", {
        collection: "vext_orders",
        schema: (s) => s({
            tenantId: "string!",
            orderNo: "string!",
            status: "string!",
            amount: "number",
        }),
    });
}

export default defineRoutes((app) => {
    app.get("/public", {}, async (_req, res) => {
        res.json({ public: true });
    });

    app.get("/orders/:id", {}, async (req, res) => {
        res.json({ orderId: req.params.id, userId: req.auth.permission.subject.userId });
    });

    app.get("/orders-data", {}, async (_req, res) => {
        const items = await app.db.collection("vext_orders").find({}, {
            projection: ["orderNo", "status", "amount"],
            sort: { orderNo: 1 },
        });
        res.json({ items, total: items.length });
    });

    app.get("/orders-model", {}, async (_req, res) => {
        const Order = app.db.model("Order");
        const items = await Order.find({}, {
            projection: ["orderNo", "status", "amount"],
            sort: { orderNo: 1 },
        });
        res.json({ items, total: items.length, collectionName: Order.collectionName });
    });
});
