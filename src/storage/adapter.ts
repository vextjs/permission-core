import type { PermissionRule, RoleData } from "../types";

/**
 * permission-core 唯一依赖的持久化契约。
 *
 * 任何存储实现只要满足这组方法，就可以被 `PermissionCore`、`RoleManager` 和 `Checker` 复用。
 */
export abstract class StorageAdapter {
    /** 初始化底层存储。 */
    abstract init(): Promise<void>;
    /** 关闭底层存储。 */
    abstract close(): Promise<void>;

    /** 获取全部角色。 */
    abstract getRoles(): Promise<Map<string, RoleData>>;
    /** 获取单个角色。 */
    abstract getRole(id: string): Promise<RoleData | null>;
    /** 写入角色。 */
    abstract setRole(id: string, roleData: RoleData): Promise<void>;
    /** 删除角色。 */
    abstract deleteRole(id: string): Promise<void>;

    /** 获取某个用户绑定的角色列表。 */
    abstract getUserRoles(userId: string): Promise<string[]>;
    /** 覆盖写入某个用户的角色列表。 */
    abstract setUserRoles(userId: string, roleIds: string[]): Promise<void>;
    /** 反向获取某个角色直接绑定的用户列表。 */
    abstract getUsersByRole(roleId: string): Promise<string[]>;

    /** 获取某个角色的规则集合。 */
    abstract getRules(roleId: string): Promise<PermissionRule[]>;
    /** 覆盖写入某个角色的规则集合。 */
    abstract setRules(roleId: string, rules: PermissionRule[]): Promise<void>;
    /** 删除某个角色的规则集合。 */
    abstract deleteRules(roleId: string): Promise<void>;
}