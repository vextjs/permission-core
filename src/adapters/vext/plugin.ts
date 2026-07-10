import { PermissionCore } from "../../core";

import { createVextPermissionMiddleware } from "./middleware";
import type { VextPermissionPlugin, VextPermissionPluginOptions } from "./types";

export function createVextPermissionPlugin(options: VextPermissionPluginOptions = {}): VextPermissionPlugin {
    return {
        name: "permission-core",
        async setup(app) {
            const core = options.core ?? await options.createCore?.() ?? new PermissionCore(options.coreOptions);
            const ownsCore = options.ownsCore ?? options.core === undefined;
            const ownsMenu = options.ownsMenu ?? false;
            let closed = false;
            if (options.closeOnAppClose !== false && (ownsCore || (ownsMenu && options.menu?.close))) {
                app.onClose(async () => {
                    if (closed) {
                        return;
                    }
                    closed = true;
                    if (ownsMenu) {
                        await options.menu?.close?.();
                    }
                    if (ownsCore) {
                        await core.close();
                    }
                });
            }

            if (options.init !== false) {
                await core.init();
            }
            if (ownsMenu) {
                await options.menu?.init?.();
            }

            app.extend("permissionCore", core);
            if (options.menu) {
                app.extend("permissionMenu", options.menu);
            }

            app.use(createVextPermissionMiddleware({ ...options, core }));
        },
    };
}
