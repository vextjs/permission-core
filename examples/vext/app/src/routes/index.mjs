import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
    app.get("/public", {}, async (_req, res) => {
        res.json({ public: true });
    });

    app.get("/orders/:id", { permission: true }, async (req, res) => {
        res.json({ orderId: req.params.id, userId: req.auth.permission.subject.userId });
    });

    app.get("/orders-data", { permission: true }, async (req, res) => {
        const items = await req.monsqlize.collection("vext_orders").find({}, {
            projection: ["orderNo", "status", "amount"],
            sort: { orderNo: 1 },
        });
        res.json({ items, total: items.length });
    });
});
