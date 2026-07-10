import { defineRoutes } from "vextjs";

export default defineRoutes((app) => {
    app.get("/allowed", {
        auth: { permissions: [{ action: "invoke", resource: "api:GET:/allowed" }] },
    }, async (_req, res) => {
        res.json({ guarded: true });
    });

    app.get("/denied", {
        auth: { permissions: [{ action: "invoke", resource: "api:GET:/denied" }] },
    }, async (_req, res) => {
        res.json({ guarded: false });
    });

    app.get("/any", {
        auth: {
            mode: "any",
            permissions: [
                { action: "invoke", resource: "api:GET:/allowed" },
                { action: "invoke", resource: "api:GET:/missing" },
            ],
        },
    }, async (_req, res) => {
        res.json({ mode: "any" });
    });

    app.get("/all", {
        auth: {
            mode: "all",
            permissions: [
                { action: "invoke", resource: "api:GET:/allowed" },
                { action: "invoke", resource: "api:GET:/missing" },
            ],
        },
    }, async (_req, res) => {
        res.json({ mode: "all" });
    });

    app.get("/public", { auth: false }, async (_req, res) => {
        res.json({ public: true });
    });
});
