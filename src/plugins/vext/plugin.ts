import type { PermissionAction } from "../../types";
import { ResourceSchemeRegistry } from "../../check/resource-schemes";
import { PermissionCore } from "../../core/permission-core";
import { PermissionCoreError } from "../../core/errors";
import {
    definePlugin,
    type VextHookHandler,
    type VextPlugin,
    type VextPluginContext,
} from "vextjs";
import { mapVextPermissionError, throwVextPermissionError } from "./errors";
import {
    buildVextRouteSnapshot,
    matchVextRouteContract,
    type VextRouteSnapshot,
} from "./manifest";
import {
    resolvePermissionVextPluginOptions,
    resolvePluginMonSQLize,
    type ResolvedPermissionVextPluginOptions,
} from "./options";
import {
    bindPermissionResponseProjection,
    createPermissionRequestMiddleware,
    requirePermissionContext,
} from "./request";
import type { PermissionVextPluginOptions } from "./types";

function appExtensionConflict(reason: string, cause?: unknown) {
    return new PermissionCoreError("VEXT_APP_EXTENSION_CONFLICT", "The Vext app permission extension cannot be installed.", {
        details: { kind: "validation", field: "app.permission", reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function invalidRouteState(reason: string, cause?: unknown) {
    return new PermissionCoreError("VEXT_ROUTE_PERMISSION_INVALID", "The initial Vext route permission manifest is invalid.", {
        details: { kind: "validation", field: "routes", reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function restartRequired(reason: string, cause?: unknown) {
    return new PermissionCoreError("VEXT_ROUTE_RESTART_REQUIRED", "Vext routes changed after the permission manifest was committed; cold restart is required.", {
        details: { kind: "validation", field: "routes", reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function permissionDenied() {
    return new PermissionCoreError("PERMISSION_DENIED", "The subject is not allowed to invoke this route.");
}

async function closeRuntime(
    core: PermissionCore,
    unsubscribers: Array<() => void>,
) {
    while (unsubscribers.length > 0) {
        try {
            unsubscribers.pop()?.();
        } catch {
            // Hook unsubscription is best effort during app disposal.
        }
    }
    await core.close();
}

async function setupPermissionPlugin(
    app: VextPluginContext,
    options: ResolvedPermissionVextPluginOptions,
) {
    if ("permission" in app) {
        throw appExtensionConflict("app.permission is already occupied");
    }
    const monsqlize = await resolvePluginMonSQLize(app, options);
    const core = new PermissionCore({ ...options.core, monsqlize });
    const unsubscribers: Array<() => void> = [];
    let closePromise: Promise<void> | undefined;
    let candidate: VextRouteSnapshot | undefined;
    let candidateError: unknown;
    let committed: VextRouteSnapshot | undefined;
    let commitPromise: Promise<void> | undefined;
    let reloadRequired = false;
    let disposed = false;
    let schemes: ResourceSchemeRegistry;
    const close = () => {
        closePromise ??= closeRuntime(core, unsubscribers).finally(() => {
            disposed = true;
        });
        return closePromise;
    };
    const cleanupAfterFailure = async () => {
        try {
            await close();
        } catch (closeError) {
            try {
                app.logger.error({ err: closeError as Error }, "[permission-core] failed to close permission runtime after startup failure");
            } catch {
                // Cleanup logging must not replace the original startup error.
            }
        }
    };

    try {
        await core.init();
        schemes = new ResourceSchemeRegistry(options.core.resourceSchemes);
        const requestMiddleware = createPermissionRequestMiddleware(core, options.resolveSubject, options.data);
        const onRoutesReady: VextHookHandler<"routes:ready"> = ({ count, routes }) => {
            if (disposed) return;
            if (committed || commitPromise) {
                reloadRequired = true;
                return;
            }
            try {
                candidate = buildVextRouteSnapshot(count, routes, schemes);
                candidateError = undefined;
            } catch (error) {
                candidate = undefined;
                candidateError = error;
            }
        };
        const onBeforeListen: VextHookHandler<"server:beforeListen"> = async () => {
            if (disposed) throw restartRequired("permission runtime is disposed");
            if (committed) {
                if (reloadRequired) throw restartRequired("route manifest requires a cold restart");
                return;
            }
            commitPromise ??= (async () => {
                try {
                    if (candidateError !== undefined) throw candidateError;
                    const candidateToCommit = candidate;
                    if (!candidateToCommit) {
                        throw invalidRouteState("routes:ready did not provide a complete initial candidate");
                    }
                    if (disposed) throw restartRequired("permission runtime was disposed during route validation");
                    if (reloadRequired || candidate !== candidateToCommit) {
                        throw restartRequired("routes changed during initial route validation");
                    }
                    committed = candidateToCommit;
                    candidate = undefined;
                } catch (error) {
                    await cleanupAfterFailure();
                    throw error;
                }
            })();
            return commitPromise;
        };
        const onRouteMatched: VextHookHandler<"route:matched"> = async ({ req, route }) => {
            if (disposed || reloadRequired || !committed) {
                return throwVextPermissionError(req.app, restartRequired(
                    disposed ? "permission runtime is disposed" : "route manifest is not in its committed initial state",
                ));
            }
            let observed;
            try {
                observed = matchVextRouteContract(route, schemes);
            } catch (cause) {
                reloadRequired = true;
                return throwVextPermissionError(req.app, restartRequired("matched route metadata is invalid", cause));
            }
            const expected = committed.contracts.get(observed.routeKey);
            if (!expected || expected.contractDigest !== observed.contractDigest) {
                reloadRequired = true;
                return throwVextPermissionError(req.app, restartRequired("matched route contract differs from the committed manifest"));
            }
            if (!expected.evaluation) return;
            const permission = await requirePermissionContext(req);
            const supportsDefaultApiProjection = expected.evaluation.requirements.some((requirement) =>
                requirement.action === "invoke" && requirement.resource === expected.apiResource);
            const bindProjection = () => {
                if (!supportsDefaultApiProjection) return;
                bindPermissionResponseProjection(req, {
                    routeKey: expected.routeKey,
                    contractDigest: expected.contractDigest,
                    apiResource: expected.apiResource,
                });
            };
            const check = async (requirement: {
                action: PermissionAction;
                resource: string;
            }) => permission.can(
                requirement.action,
                requirement.resource,
            );
            if (expected.evaluation.mode === "any") {
                for (const requirement of expected.evaluation.requirements) {
                    if (await check(requirement)) {
                        bindProjection();
                        return;
                    }
                }
                return throwVextPermissionError(req.app, permissionDenied());
            }
            for (const requirement of expected.evaluation.requirements) {
                if (!(await check(requirement))) {
                    return throwVextPermissionError(req.app, permissionDenied());
                }
            }
            bindProjection();
        };

        for (const [name, handler] of [
            ["routes:ready", onRoutesReady],
            ["server:beforeListen", onBeforeListen],
            ["route:matched", onRouteMatched],
            ["error:beforeResponse", mapVextPermissionError],
        ] as const) {
            unsubscribers.push(app.hooks.on(name, handler as never));
        }

        try {
            app.use(requestMiddleware);
            app.extend("permission", core);
            app.onClose(close);
        } catch (cause) {
            throw appExtensionConflict("irreversible Vext startup commit failed; this app instance must be discarded", cause);
        }
    } catch (error) {
        await cleanupAfterFailure();
        throw error;
    }
}

export function permissionPlugin(
    optionsInput?: PermissionVextPluginOptions,
): VextPlugin {
    const options = resolvePermissionVextPluginOptions(optionsInput);
    return Object.freeze(definePlugin({
        name: "permission-core",
        dependencies: Object.freeze([...options.dependencies]) as string[],
        setup: (app) => setupPermissionPlugin(app, options),
    }));
}
