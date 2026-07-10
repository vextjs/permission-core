import * as fs from "node:fs/promises";

import { createApiResource, normalizeApiManifest } from "../../menu";
import type { ApiManifest } from "../../menu";

import type { VextRouteManifestPayload } from "./types";

export async function loadVextRouteManifest(filePath: string): Promise<VextRouteManifestPayload> {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as VextRouteManifestPayload;
}

export function normalizeVextRoutes(payload: VextRouteManifestPayload): ApiManifest {
    return normalizeApiManifest({
        bindings: payload.routes
            .filter((route) => !route.hidden)
            .flatMap((route) => {
                const auth = route.auth ?? route.options?.auth;
                const permissions = typeof auth === "object" && auth.permissions?.length
                    ? auth.permissions
                    : ["invoke"];
                const baseId = route.operationId ?? `${route.method.toUpperCase()} ${route.path}`;

                return permissions.map((permission, index) => {
                    const action = typeof permission === "string" ? permission : permission.action;
                    const declaredResource = typeof permission === "object" && typeof permission.resource === "string"
                        ? permission.resource
                        : undefined;
                    return {
                        id: permissions.length === 1 ? baseId : `${baseId}#${index + 1}:${action}`,
                        method: route.method,
                        path: route.path,
                        resource: declaredResource ?? createApiResource(route.method, route.path),
                        action,
                        ownerType: "apiGroup" as const,
                        ownerId: route.tags?.[0] ?? "vext",
                        purpose: "operation" as const,
                        required: auth === false ? false : typeof auth === "object" ? auth.required !== false : true,
                        permissionGroup: permissions.length > 1 ? baseId : undefined,
                        permissionMode: permissions.length > 1 && typeof auth === "object"
                            ? auth.mode ?? "any"
                            : undefined,
                        description: route.docsSummary ?? undefined,
                    };
                });
            }),
    });
}
