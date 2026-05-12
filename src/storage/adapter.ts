import type { PermissionRule, RoleData } from "../types";

// StorageAdapter 定义权限核心唯一依赖的持久化契约，具体实现可自由替换。
export abstract class StorageAdapter {
    abstract init(): Promise<void>;
    abstract close(): Promise<void>;

    abstract getRoles(): Promise<Map<string, RoleData>>;
    abstract getRole(id: string): Promise<RoleData | null>;
    abstract setRole(id: string, roleData: RoleData): Promise<void>;
    abstract deleteRole(id: string): Promise<void>;

    abstract getUserRoles(userId: string): Promise<string[]>;
    abstract setUserRoles(userId: string, roleIds: string[]): Promise<void>;
    abstract getUsersByRole(roleId: string): Promise<string[]>;

    abstract getRules(roleId: string): Promise<PermissionRule[]>;
    abstract setRules(roleId: string, rules: PermissionRule[]): Promise<void>;
    abstract deleteRules(roleId: string): Promise<void>;
}