import { definePlugin } from "vextjs";

export default definePlugin({
    name: "authentication",
    setup(app) {
        app.use(async (req, _res, next) => {
            const mode = req.headers["x-test-auth"];
            if (mode !== undefined) {
                const auth = mode === "valid"
                    ? {
                        isAuthenticated: true,
                        userId: req.headers["x-user-id"] ?? "u-vext",
                        scope: { tenantId: "vext-host" },
                    }
                    : mode === "invalid"
                        ? { isAuthenticated: true, userId: "u-vext" }
                        : { isAuthenticated: false };
                Object.defineProperty(req, "auth", {
                    value: auth,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            await next();
        });
    },
});
