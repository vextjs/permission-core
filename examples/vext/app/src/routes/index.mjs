import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
    app.get("/public", {}, async (_req, res) => {
        res.json({ public: true });
    });

    app.get("/orders/:id", { permission: true }, async (req, res) => {
        res.json({ orderId: req.params.id, userId: req.auth.permission.subject.userId });
    });
});
