import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode, type PermissionScope, type PermissionSubject } from "../types";
import { assertNonEmptyString } from "../utils/validation";

/**
 * 旧 userId API 使用的默认单租户范围。
 */
export const DEFAULT_PERMISSION_SCOPE: PermissionScope = Object.freeze({
    tenantId: "default",
});

/**
 * 断言 scope 字段适合作为稳定 key 片段。
 */
function assertScopeSegment(value: unknown, name: string): asserts value is string {
    assertNonEmptyString(value, name);
    if (value.includes("|")) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            `${name} cannot contain '|'`,
        );
    }
}

/**
 * 归一化权限范围。
 */
export function normalizePermissionScope(
    scope: Partial<PermissionScope> | undefined,
    fallback: PermissionScope = DEFAULT_PERMISSION_SCOPE,
): PermissionScope {
    // An explicitly supplied scope must identify its tenant; only an omitted scope uses the legacy fallback.
    const tenantId = scope === undefined ? fallback.tenantId : scope.tenantId;
    assertScopeSegment(tenantId, "tenantId");

    const normalized: PermissionScope = {
        tenantId,
    };

    const appId = scope?.appId ?? fallback.appId;
    if (appId !== undefined) {
        assertScopeSegment(appId, "appId");
        normalized.appId = appId;
    }

    const moduleId = scope?.moduleId ?? fallback.moduleId;
    if (moduleId !== undefined) {
        assertScopeSegment(moduleId, "moduleId");
        normalized.moduleId = moduleId;
    }

    const namespace = scope?.namespace ?? fallback.namespace;
    if (namespace !== undefined) {
        assertScopeSegment(namespace, "namespace");
        normalized.namespace = namespace;
    }

    return normalized;
}

/**
 * 从 subject 中提取归一化 scope。
 */
export function getSubjectScope(subject: PermissionSubject): PermissionScope {
    assertPermissionSubject(subject);
    return normalizePermissionScope(subject);
}

/**
 * 断言 subject 满足新多租户 API 的最低要求。
 */
export function assertPermissionSubject(subject: PermissionSubject): asserts subject is PermissionSubject {
    if (typeof subject !== "object" || subject === null) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            "subject must be an object",
        );
    }

    assertNonEmptyString(subject.userId, "subject.userId");
    normalizePermissionScope(subject);
}

/**
 * 生成稳定的租户隔离 key。
 */
export function getPermissionScopeKey(scope: PermissionScope = DEFAULT_PERMISSION_SCOPE): string {
    const normalized = normalizePermissionScope(scope);
    return [
        `tenant:${normalized.tenantId}`,
        `app:${normalized.appId ?? "-"}`,
        `module:${normalized.moduleId ?? "-"}`,
        `ns:${normalized.namespace ?? "-"}`,
    ].join("|");
}

/**
 * 判断两个 scope 是否指向同一隔离范围。
 */
export function isSamePermissionScope(left: PermissionScope, right: PermissionScope): boolean {
    return getPermissionScopeKey(left) === getPermissionScopeKey(right);
}
