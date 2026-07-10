import { PermissionCoreError } from "../../core";
import { PermissionCoreErrorCode } from "../../types";

import { resolveVextPermissionSubject } from "./tenant";
import type {
    VextPermissionAdapterOptions,
    VextPermissionRequest,
    VextPermissionRequirement,
    VextRouteAuthRequirement,
} from "./types";

export function createVextPermissionAuthProvider(options: VextPermissionAdapterOptions) {
    return {
        async can(
            req: VextPermissionRequest,
            action: string,
            resource?: string,
            context?: Record<string, unknown>,
        ) {
            const subject = await resolveVextPermissionSubject(options, req, context);
            const resolvedResource = resource ?? await resolveVextRouteResource(options, req, action, context);
            if (!resolvedResource) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.INVALID_ARGUMENT,
                    "vext permission resource is required",
                );
            }

            return options.core.canSubject(subject, action, resolvedResource);
        },
        async assert(
            req: VextPermissionRequest,
            action: string,
            resource?: string,
            context?: Record<string, unknown>,
        ) {
            const subject = await resolveVextPermissionSubject(options, req, context);
            const resolvedResource = resource ?? await resolveVextRouteResource(options, req, action, context);
            if (!resolvedResource) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.INVALID_ARGUMENT,
                    "vext permission resource is required",
                );
            }

            await options.core.assertSubject(subject, action, resolvedResource);
        },
    };
}

export async function resolveVextRouteResource(
    options: VextPermissionAdapterOptions,
    req: VextPermissionRequest,
    action: string,
    context?: Record<string, unknown>,
) {
    const custom = await options.routeResource?.(req, action, context);
    if (custom) {
        return custom;
    }

    const routeOptions = getVextRouteOptions(req);
    const authResource = resolvePermissionResource(routeOptions?.auth, req, action);
    if (authResource) {
        return authResource;
    }

    const extensionResource = routeOptions?.docs?.extensions?.["x-permission-resource"];
    if (typeof extensionResource === "string" && extensionResource.trim()) {
        return extensionResource;
    }

    const routeRecord = typeof req.route === "object" ? req.route : undefined;
    const method = (routeRecord?.method ?? req.method)?.toUpperCase();
    const path = routeRecord?.path
        ?? (typeof req.route === "string" ? req.route : undefined)
        ?? req.path
        ?? normalizePathFromUrl(req.url);
    return method && path ? `api:${method}:${path}` : undefined;
}

function getVextRouteOptions(req: VextPermissionRequest) {
    return (typeof req.route === "object" ? req.route.options : undefined) ?? req._routeOptions;
}

function resolvePermissionResource(
    auth: false | true | VextRouteAuthRequirement | undefined,
    req: VextPermissionRequest,
    action: string,
) {
    if (!auth || auth === true) {
        return undefined;
    }

    const resources = (auth.permissions ?? [])
        .filter((permission) => getPermissionAction(permission) === action)
        .map((permission) => getPermissionResource(permission, req))
        .filter((resource): resource is string => typeof resource === "string" && resource.trim().length > 0);
    const uniqueResources = Array.from(new Set(resources));
    if (uniqueResources.length > 1) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            `vext route declares multiple resources for action '${action}'`,
            uniqueResources,
        );
    }
    return uniqueResources[0];
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

function normalizePathFromUrl(url: string | undefined) {
    if (!url) {
        return undefined;
    }

    return url.split("?")[0] || "/";
}
