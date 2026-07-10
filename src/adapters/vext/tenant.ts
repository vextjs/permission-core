import { PermissionCoreError } from "../../core";
import { PermissionCoreErrorCode, type PermissionScope, type PermissionSubject } from "../../types";
import { DEFAULT_PERMISSION_SCOPE, normalizePermissionScope } from "../../scope";

import type { VextPermissionAdapterOptions, VextPermissionAuthContext, VextPermissionRequest } from "./types";

export function getHeader(req: VextPermissionRequest, name: string): string | undefined {
    const headers = req.headers ?? {};
    const values = Object.entries(headers)
        .filter(([key]) => key.toLowerCase() === name.toLowerCase())
        .flatMap(([, value]) => Array.isArray(value) ? value : [value])
        .map(normalizeString)
        .filter((value): value is string => value !== undefined);
    const distinctValues = new Set(values);
    if (distinctValues.size > 1) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            `Conflicting vext permission header '${name}' values`,
        );
    }

    return values[0];
}

export async function resolveVextPermissionSubject(
    options: VextPermissionAdapterOptions,
    req: VextPermissionRequest,
    context?: Record<string, unknown>,
): Promise<PermissionSubject> {
    const auth = req.auth;
    if (options.resolveSubject) {
        const subject = await options.resolveSubject(req, auth, context);
        if (options.tenantRequired && !normalizeString(subject.tenantId)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                "vext permission subject requires an explicit tenantId",
            );
        }
        return subject;
    }

    const claims = auth?.claims ?? {};
    const defaultScope = normalizePermissionScope(options.defaultScope ?? DEFAULT_PERMISSION_SCOPE);
    const userId = resolveConsistentValue("userId", [
        ["auth.userId", normalizeString(auth?.userId)],
        ["auth.subject", normalizeString(auth?.subject)],
        ["claims.userId", getStringClaim(claims, "userId")],
        ["claims.sub", getStringClaim(claims, "sub")],
    ]);
    if (!userId) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            "vext permission subject requires userId",
        );
    }

    const explicitTenantId = resolveConsistentValue("tenantId", [
        ["claims.tenantId", getStringClaim(claims, "tenantId")],
        ["header.x-tenant-id", getHeader(req, "x-tenant-id")],
    ]);
    if (options.tenantRequired && !explicitTenantId) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            "vext permission subject requires an explicit tenantId",
        );
    }

    const tenantId = explicitTenantId ?? defaultScope.tenantId;
    return {
        ...defaultScope,
        tenantId,
        appId: resolveConsistentValue("appId", [
            ["claims.appId", getStringClaim(claims, "appId")],
            ["header.x-app-id", getHeader(req, "x-app-id")],
        ]) ?? defaultScope.appId,
        moduleId: resolveConsistentValue("moduleId", [
            ["claims.moduleId", getStringClaim(claims, "moduleId")],
            ["header.x-module-id", getHeader(req, "x-module-id")],
        ]) ?? defaultScope.moduleId,
        namespace: resolveConsistentValue("namespace", [
            ["claims.namespace", getStringClaim(claims, "namespace")],
            ["header.x-permission-namespace", getHeader(req, "x-permission-namespace")],
        ]) ?? defaultScope.namespace,
        userId,
        roles: auth?.roles,
        claims,
    };
}

function getStringClaim(claims: Record<string, unknown>, key: string): string | undefined {
    const value = claims[key];
    return normalizeString(value);
}

function normalizeString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveConsistentValue(
    field: string,
    sources: Array<readonly [source: string, value: string | undefined]>,
): string | undefined {
    const present = sources.filter((source): source is readonly [string, string] => source[1] !== undefined);
    const distinctValues = new Set(present.map(([, value]) => value));
    if (distinctValues.size > 1) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            `Conflicting vext permission ${field} sources: ${present.map(([source]) => source).join(", ")}`,
        );
    }

    return present[0]?.[1];
}
