import { createVextPermissionAuthProvider } from "./auth-provider";
import type {
    VextPermissionAdapterOptions,
    VextPermissionMiddleware,
    VextPermissionRequirement,
    VextPermissionRequest,
    VextRouteAuthRequirement,
} from "./types";

export function createVextPermissionMiddleware(options: VextPermissionAdapterOptions): VextPermissionMiddleware {
    const provider = createVextPermissionAuthProvider(options);
    return async (req, _res, next) => {
        attachVextPermissionAuth(req, provider);
        if (options.guardRoutePermissions !== false) {
            await enforceRoutePermissions(req, provider);
        }
        await next();
    };
}

export function createVextPermissionMiddlewareFactory(options: VextPermissionAdapterOptions) {
    return () => createVextPermissionMiddleware(options);
}

function attachVextPermissionAuth(
    req: VextPermissionRequest,
    provider: ReturnType<typeof createVextPermissionAuthProvider>,
) {
    const currentAuth = req.auth ?? {};
    req.auth = {
        ...currentAuth,
        can: (action, resource, context) => provider.can(req, action, resource, context),
        assert: (action, resource, context) => provider.assert(req, action, resource, context),
    };
}

async function enforceRoutePermissions(
    req: VextPermissionRequest,
    provider: ReturnType<typeof createVextPermissionAuthProvider>,
) {
    const auth = getRouteAuth(req);
    if (!auth || auth === true || !auth.permissions?.length) {
        return;
    }
    if (req.auth?.isAuthenticated === false) {
        throwVextAuthError(req, 401, "Authentication required", "AUTH_REQUIRED");
    }

    const results = await Promise.all(auth.permissions.map((permission) => provider.can(
        req,
        getPermissionAction(permission),
        getPermissionResource(permission, req),
        getPermissionContext(permission, req),
    )));
    const allowed = (auth.mode ?? "any") === "all" ? results.every(Boolean) : results.some(Boolean);
    if (!allowed) {
        throwVextAuthError(req, 403, "Forbidden", "AUTH_FORBIDDEN");
    }
}

function getRouteAuth(req: VextPermissionRequest): false | true | VextRouteAuthRequirement | undefined {
    return (typeof req.route === "object" ? req.route.options?.auth : undefined) ?? req._routeOptions?.auth;
}

function getPermissionAction(permission: VextPermissionRequirement) {
    return typeof permission === "string" ? permission : permission.action;
}

function getPermissionResource(permission: VextPermissionRequirement, req: VextPermissionRequest) {
    if (typeof permission === "string") {
        return undefined;
    }
    return typeof permission.resource === "function" ? permission.resource(req) : permission.resource;
}

function getPermissionContext(permission: VextPermissionRequirement, req: VextPermissionRequest) {
    if (typeof permission === "string") {
        return undefined;
    }
    return typeof permission.context === "function" ? permission.context(req) : permission.context;
}

function throwVextAuthError(
    req: VextPermissionRequest,
    status: number,
    message: string,
    code: string,
): never {
    if (req.app?.throw) {
        return req.app.throw(status, message, code);
    }
    throw new Error(`${code}: ${message}`);
}
