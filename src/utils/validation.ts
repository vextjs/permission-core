import {
    PermissionCoreErrorCode,
    type RowCondition,
} from "../types";
import { PermissionCoreError } from "../core/errors";

// 统一动作白名单，避免运行时出现拼写漂移。
const VALID_ACTIONS = new Set([
    "invoke",
    "read",
    "create",
    "update",
    "delete",
    "write",
    "manage",
    "*",
]);

const VALID_UI_RESOURCE_TYPES = new Set(["menu", "page", "button"]);

// RowCondition DSL 当前支持的全部操作符。
const VALID_OPERATORS = new Set([
    "eq",
    "ne",
    "in",
    "nin",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "exists",
]);

/**
 * 判断一个值是否为普通对象。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 断言某个值是非空字符串。
 */
export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            `${name} must be a non-empty string`,
        );
    }
}

/**
 * 断言 action 属于公开支持范围。
 */
export function assertValidAction(action: string) {
    if (!VALID_ACTIONS.has(action)) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ACTION,
            `Unsupported action '${action}'`,
        );
    }
}

/**
 * 断言资源字符串格式合法。
 */
export function assertValidResource(resource: string) {
    assertNonEmptyString(resource, "resource");

    if (resource === "*") {
        return;
    }

    if (resource.startsWith("db:")) {
        // db 资源只允许 collection 或 collection:field 两级结构。
        const parts = resource.split(":");
        const isValidDbResource =
            parts.length >= 2 &&
            parts.length <= 3 &&
            parts.slice(1).every((part) => part.length > 0);

        if (!isValidDbResource) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_RESOURCE_PATH,
                `Invalid db resource '${resource}'`,
            );
        }

        return;
    }

    if (resource.startsWith("ui:")) {
        const parts = resource.split(":");
        const resourceType = parts[1];
        const id = parts.slice(2).join(":");
        const isValidUiResource =
            parts.length >= 3 &&
            VALID_UI_RESOURCE_TYPES.has(resourceType) &&
            id.length > 0 &&
            !id.includes("?") &&
            !id.includes("|");

        if (!isValidUiResource) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_RESOURCE_PATH,
                `Invalid ui resource '${resource}'`,
            );
        }

        return;
    }

    if (resource.startsWith("api:")) {
        const rest = resource.slice("api:".length);
        const separatorIndex = rest.indexOf(":");
        const method = separatorIndex > 0 ? rest.slice(0, separatorIndex) : "";
        const path = separatorIndex > 0 ? rest.slice(separatorIndex + 1) : "";

        if (!/^[A-Z*]+$/.test(method) || (path !== "*" && !path.startsWith("/")) || path.includes("?")) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_RESOURCE_PATH,
                `Invalid api resource '${resource}'`,
            );
        }

        return;
    }

    const separatorIndex = resource.indexOf(":");
    const method = separatorIndex > 0 ? resource.slice(0, separatorIndex) : "";
    const path = separatorIndex > 0 ? resource.slice(separatorIndex + 1) : "";

    // HTTP 资源必须是 METHOD:/path 形式，v1 显式拒绝 query string。
    if (!/^[A-Z*]+$/.test(method) || (path !== "*" && !path.startsWith("/")) || path.includes("?")) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_RESOURCE_PATH,
            `Invalid resource '${resource}'`,
        );
    }
}

/**
 * 断言资源必须是 `db:` 资源。
 */
export function assertDbResource(resource: string) {
    assertValidResource(resource);
    if (!resource.startsWith("db:")) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_RESOURCE_PATH,
            `Expected db resource, received '${resource}'`,
        );
    }
}

/**
 * 断言行级权限 DSL 合法。
 */
export function assertValidWhereCondition(condition: RowCondition): void {
    if ("all" in condition) {
        // all/any/not 递归组成逻辑树，空数组会导致语义不明确。
        if (!Array.isArray(condition.all) || condition.all.length === 0) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                "where.all must contain at least one child condition",
            );
        }

        condition.all.forEach(assertValidWhereCondition);
        return;
    }

    if ("any" in condition) {
        if (!Array.isArray(condition.any) || condition.any.length === 0) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                "where.any must contain at least one child condition",
            );
        }

        condition.any.forEach(assertValidWhereCondition);
        return;
    }

    if ("not" in condition) {
        assertValidWhereCondition(condition.not);
        return;
    }

    assertNonEmptyString(condition.field, "where.field");
    if (condition.field.includes(".")) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            "Nested row-condition fields are not supported in v1",
        );
    }

    if (!VALID_OPERATORS.has(condition.op)) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            `Unsupported row-condition operator '${condition.op}'`,
        );
    }

    if (condition.value !== undefined && condition.valueFrom !== undefined) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            "where.value and where.valueFrom cannot be set at the same time",
        );
    }

    // 除 exists 外，其他操作符必须能拿到一个明确的比较目标。
    if (condition.op !== "exists" && condition.value === undefined && condition.valueFrom === undefined) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            `Operator '${condition.op}' requires value or valueFrom`,
        );
    }
}

/**
 * 判断一个对象是否满足最小缓存鸭子类型。
 */
export function isCacheLike(value: unknown): value is {
    get(key: string): unknown;
    set(key: string, data: unknown, ttl?: number): unknown;
    del(key: string): unknown;
    clear(): unknown;
} {
    // 这里只做最小鸭子类型判断，真正的缓存行为交给 cache-hub 兼容实现负责。
    return isPlainObject(value)
        && typeof value.get === "function"
        && typeof value.set === "function"
        && typeof value.del === "function"
        && typeof value.clear === "function";
}
