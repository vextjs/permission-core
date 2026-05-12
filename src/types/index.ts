export type PermissionRuleType = "allow" | "deny";

// action 统一覆盖接口权限与数据权限，避免拆成两套互不兼容的模型。
export type PermissionAction =
    | "invoke"
    | "read"
    | "create"
    | "update"
    | "delete"
    | "write"
    | "*";

export type RowOperator =
    | "eq"
    | "ne"
    | "in"
    | "nin"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "exists";

export type RowCondition =
    | { all: RowCondition[] }
    | { any: RowCondition[] }
    | { not: RowCondition }
    | {
        field: string;
        op: RowOperator;
        value?: unknown;
        valueFrom?: string;
    };

// 单条权限规则由动作、资源和可选的 where 条件组成。
export interface PermissionRule {
    type: PermissionRuleType;
    action: PermissionAction | string;
    resource: string;
    where?: RowCondition;
}

export interface RoleData {
    id: string;
    label: string;
    parent: string | null;
    description: string;
    createdAt: number;
    updatedAt: number;
}

export interface RowRuleOptions {
    where?: RowCondition;
}

// RowScope 用于把多条 allow/deny 规则归并成运行时可执行的范围结构。
export interface RowScope {
    mode: "all" | "conditional" | "none";
    include?: RowCondition;
    exclude?: RowCondition;
}

export interface RoleCreateOptions {
    label: string;
    parent?: string | null;
    description?: string;
}

export interface RoleUpdateOptions {
    label?: string;
    parent?: string | null;
    description?: string;
}

// CacheOptions 只暴露最小缓存开关，底层能力交给 cache-hub 兼容实现提供。
export interface CacheOptions {
    enabled?: boolean;
    ttl?: number;
    maxEntries?: number;
}

// 错误码集中定义，方便业务层做稳定的日志、响应码和监控映射。
export enum PermissionCoreErrorCode {
    PERMISSION_DENIED = "PERMISSION_DENIED",
    ROLE_NOT_FOUND = "ROLE_NOT_FOUND",
    ROLE_ALREADY_EXISTS = "ROLE_ALREADY_EXISTS",
    CIRCULAR_INHERITANCE = "CIRCULAR_INHERITANCE",
    INVALID_RESOURCE_PATH = "INVALID_RESOURCE_PATH",
    INVALID_ACTION = "INVALID_ACTION",
    INVALID_ARGUMENT = "INVALID_ARGUMENT",
    STORAGE_ERROR = "STORAGE_ERROR",
    NOT_INITIALIZED = "NOT_INITIALIZED",
}