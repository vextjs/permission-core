import type { ApiBinding, ApiManifest, FrontendMenuManifest, MenuNode } from "./types";

export interface RawApiManifestRoute {
    id?: string;
    operationId?: string;
    method: string;
    path: string;
    resource?: string;
    ownerId?: string;
    ownerType?: ApiBinding["ownerType"];
    purpose?: ApiBinding["purpose"];
    required?: boolean;
    description?: string;
}

export function createApiResource(method: string, path: string) {
    return `api:${method.toUpperCase()}:${path}`;
}

export function normalizeApiManifest(input: ApiManifest | ApiBinding[] | { routes: RawApiManifestRoute[] }): ApiManifest {
    if (Array.isArray(input)) {
        return { bindings: input.map(normalizeApiBinding) };
    }

    if ("bindings" in input) {
        return { bindings: input.bindings.map(normalizeApiBinding) };
    }

    return {
        bindings: input.routes.map((route) => normalizeApiBinding({
            id: route.id ?? route.operationId ?? `${route.method.toUpperCase()} ${route.path}`,
            ownerType: route.ownerType ?? "apiGroup",
            ownerId: route.ownerId ?? "unassigned",
            method: route.method,
            path: route.path,
            resource: route.resource ?? createApiResource(route.method, route.path),
            action: "invoke",
            purpose: route.purpose ?? "operation",
            required: route.required,
            description: route.description,
        })),
    };
}

export function normalizeFrontendManifest(input: FrontendMenuManifest | MenuNode[]): FrontendMenuManifest {
    if (Array.isArray(input)) {
        return { nodes: input.map((node) => ({ ...node })) };
    }

    return {
        nodes: input.nodes.map((node) => ({ ...node })),
        apiBindings: input.apiBindings?.map(normalizeApiBinding),
    };
}

function normalizeApiBinding(binding: ApiBinding): ApiBinding {
    const method = binding.method.toUpperCase();
    return {
        ...binding,
        method,
        action: binding.action ?? "invoke",
        resource: binding.resource || createApiResource(method, binding.path),
    };
}
