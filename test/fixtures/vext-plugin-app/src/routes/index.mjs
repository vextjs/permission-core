import { defineRoutes } from "vextjs";

const METRICS = Symbol.for("permission-core.vext.integration.metrics");

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

    app.get("/permissions/any", {
        permission: {
            mode: "any",
            requirements: [
                { action: "invoke", resource: "GET:/capabilities/one" },
                { action: "invoke", resource: "GET:/capabilities/two" },
            ],
        },
    }, async (_req, res) => {
        res.json({ mode: "any" });
    });

    app.get("/permissions/all", {
        permission: {
            mode: "all",
            requirements: [
                { action: "invoke", resource: "GET:/capabilities/one" },
                { action: "invoke", resource: "GET:/capabilities/two" },
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
