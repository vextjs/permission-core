import { definePlugin } from "vextjs";

const DATABASE = Symbol.for("permission-core.vext.api-fixture.database");
const CLOSE_TRACE = Symbol.for("permission-core.vext.api-fixture.close-trace");

export default definePlugin({
    name: "database",
    setup(app) {
        const monsqlize = globalThis[DATABASE];
        if (!monsqlize) {
            throw new Error("Vext API fixture database is not initialized");
        }
        app.extend("monsqlize", monsqlize);
        app.onClose(async () => {
            const permissionLifecycle = "permission" in app
                ? (await app.permission.health()).lifecycle
                : "not-installed";
            if (permissionLifecycle !== "closed" && permissionLifecycle !== "not-installed") {
                throw new Error(`Database owner closed before permission core: ${permissionLifecycle}`);
            }
            await monsqlize.close();
            globalThis[CLOSE_TRACE] = {
                permissionLifecycle,
                databaseClosed: true,
            };
        });
    },
});
