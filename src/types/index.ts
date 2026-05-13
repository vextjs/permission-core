/**
 * 权限规则的效果类型。
 */
export type PermissionRuleType = "allow" | "deny";

/**
 * 统一的权限动作模型。
 *
 * 接口权限与数据权限共用同一套 action，避免在运行时拆成两套互不兼容的判定模型。
 */
export type PermissionAction =
    | "invoke"
    | "read"
    | "create"
    | "update"
    | "delete"
    | "write"
    | "*";

/**
 * 行级权限 DSL 支持的比较操作符。
 */
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

/**
 * 行级权限条件树。
 *
 * 逻辑节点通过 `all` / `any` / `not` 组合，叶子节点通过 `field + op + value/valueFrom` 描述比较规则。
 */
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

/**
 * 单条权限规则。
 */
export interface PermissionRule {
    /** 规则效果。 */
    type: PermissionRuleType;
    /** 规则动作。允许未来扩展字符串，但公开约定仍以 {@link PermissionAction} 为主。 */
    action: PermissionAction | string;
    /** 规则资源。 */
    resource: string;
    /** 仅对 `db:` 资源生效的行级条件。 */
    where?: RowCondition;
}

/**
 * 角色元数据。
 */
export interface RoleData {
    /** 角色唯一标识。 */
    id: string;
    /** 角色展示名称。 */
    label: string;
    /** 父角色 ID；`null` 代表无继承。 */
    parent: string | null;
    /** 角色说明。 */
    description: string;
    /** 创建时间戳（毫秒）。 */
    createdAt: number;
    /** 最后更新时间戳（毫秒）。 */
    updatedAt: number;
}

/**
 * 写入带行级条件规则时的附加参数。
 */
export interface RowRuleOptions {
    /** 可选的行级条件。 */
    where?: RowCondition;
}

/**
 * 运行时可执行的行级范围结构。
 */
export interface RowScope {
    /** 当前资源的可见模式。 */
    mode: "all" | "conditional" | "none";
    /** 允许命中的条件。 */
    include?: RowCondition;
    /** 需要排除的条件。 */
    exclude?: RowCondition;
}

/**
 * 创建角色时允许写入的字段。
 */
export interface RoleCreateOptions {
    /** 角色展示名称。 */
    label: string;
    /** 可选父角色。 */
    parent?: string | null;
    /** 可选描述。 */
    description?: string;
}

/**
 * 更新角色时允许变更的字段。
 */
export interface RoleUpdateOptions {
    /** 新的展示名称。 */
    label?: string;
    /** 新的父角色；显式传 `null` 表示移除继承。 */
    parent?: string | null;
    /** 新的描述。 */
    description?: string;
}

/**
 * 轻量缓存配置。
 *
 * 更完整的缓存能力交给 `cache-hub` 兼容实例提供，这里只暴露常用开关。
 */
export interface CacheOptions {
    /** 是否启用缓存。 */
    enabled?: boolean;
    /** 默认 TTL，单位毫秒。 */
    ttl?: number;
    /** 最大缓存条目数。 */
    maxEntries?: number;
}

/**
 * permission-core 公开错误码。
 */
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