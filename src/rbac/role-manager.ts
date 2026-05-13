import { PermissionCoreError } from "../core/errors";
import { Resolver } from "../check/resolver";
import { PermissionCoreErrorCode, type PermissionRule, type RoleChainEntry, type RoleCreateOptions, type RoleData, type RoleInspection, type RoleUpdateOptions, type RowRuleOptions } from "../types";
import { deduplicateRules } from "../utils";
import { assertNonEmptyString, assertValidAction, assertValidResource, assertValidWhereCondition } from "../utils/validation";
import type { PermissionCache } from "../cache";
import type { StorageAdapter } from "../storage";

/**
 * 归一化规则动作列表。
 */
function normalizeActions(actions: string | string[]) {
    const values = Array.isArray(actions) ? actions : [actions];
    values.forEach((action) => {
        assertNonEmptyString(action, "action");
        assertValidAction(action);
    });
    return Array.from(new Set(values));
}

/**
 * 返回当前时间戳。
 */
function now() {
    return Date.now();
}

/**
 * 判断两条规则的 `where` 条件是否等价。
 */
function sameWhere(left: PermissionRule["where"], right: PermissionRule["where"]) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * 角色元数据与规则集合管理器。
 */
export class RoleManager {
    private readonly resolver = new Resolver();

    /**
     * @param storage 存储适配器。
     * @param cache 规则缓存。
     * @param ensureInitialized 初始化检查钩子。
     */
    constructor(
        private readonly storage: StorageAdapter,
        private readonly cache: PermissionCache,
        private readonly ensureInitialized: () => void,
    ) { }

    /**
     * 创建角色。
     */
    async create(id: string, options: RoleCreateOptions): Promise<void> {
        this.ensureInitialized();
        assertNonEmptyString(id, "roleId");
        assertNonEmptyString(options.label, "label");

        if (await this.storage.getRole(id)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.ROLE_ALREADY_EXISTS,
                `Role '${id}' already exists`,
            );
        }

        const parent = options.parent ?? null;
        if (parent) {
            await this.ensureRoleExists(parent);
            await this.assertNoCircularParent(id, parent);
        }

        const timestamp = now();
        const roleData: RoleData = {
            id,
            label: options.label,
            parent,
            description: options.description ?? "",
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        await this.storage.setRole(id, roleData);
        await this.cache.invalidateAll();
    }

    /**
     * 更新角色元数据。
     */
    async update(id: string, options: RoleUpdateOptions): Promise<void> {
        this.ensureInitialized();
        const currentRole = await this.get(id);
        const nextParent = options.parent === undefined ? currentRole.parent : options.parent;

        if (nextParent) {
            await this.ensureRoleExists(nextParent);
            await this.assertNoCircularParent(id, nextParent);
        }

        const updatedRole: RoleData = {
            ...currentRole,
            label: options.label ?? currentRole.label,
            parent: nextParent ?? null,
            description: options.description ?? currentRole.description,
            updatedAt: now(),
        };

        await this.storage.setRole(id, updatedRole);
        await this.cache.invalidateAll();
    }

    /**
     * 删除角色及其直接绑定关系。
     */
    async delete(id: string): Promise<void> {
        this.ensureInitialized();
        await this.get(id);
        const roles = await this.storage.getRoles();
        // 有子角色时禁止删除，避免把继承链留在半断裂状态。
        const childRoleIds = Array.from(roles.values())
            .filter((role) => role.parent === id)
            .map((role) => role.id);
        if (childRoleIds.length > 0) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `Cannot delete role '${id}' while child roles still exist: ${childRoleIds.join(", ")}`,
            );
        }

        const boundUsers = await this.storage.getUsersByRole(id);
        for (const userId of boundUsers) {
            // 删除角色时一并清理直接绑定，避免用户继续持有无效角色 ID。
            const nextRoleIds = (await this.storage.getUserRoles(userId)).filter((roleId) => roleId !== id);
            await this.storage.setUserRoles(userId, nextRoleIds);
        }

        await this.storage.deleteRules(id);
        await this.storage.deleteRole(id);
        await this.cache.invalidateAll();
    }

    /**
     * 获取单个角色。
     */
    async get(id: string): Promise<RoleData> {
        this.ensureInitialized();
        assertNonEmptyString(id, "roleId");
        const role = await this.storage.getRole(id);
        if (!role) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.ROLE_NOT_FOUND,
                `Role '${id}' was not found`,
            );
        }

        return role;
    }

    /**
     * 列出全部角色。
     */
    async list(): Promise<RoleData[]> {
        this.ensureInitialized();
        const roles = await this.storage.getRoles();
        return Array.from(roles.values());
    }

    /**
     * 为角色添加 allow 规则。
     */
    async allow(
        roleId: string,
        actions: string | string[],
        resource: string,
        options: RowRuleOptions = {},
    ): Promise<void> {
        this.ensureInitialized();
        await this.addRules("allow", roleId, actions, resource, options);
    }

    /**
     * 为角色添加 deny 规则。
     */
    async deny(
        roleId: string,
        actions: string | string[],
        resource: string,
        options: RowRuleOptions = {},
    ): Promise<void> {
        this.ensureInitialized();
        await this.addRules("deny", roleId, actions, resource, options);
    }

    /**
     * 撤销角色上的某条规则。
     */
    async revokeRule(
        roleId: string,
        actions: string | string[],
        resource: string,
        options: RowRuleOptions = {},
    ): Promise<void> {
        this.ensureInitialized();
        await this.get(roleId);
        assertValidResource(resource);
        const normalizedActions = normalizeActions(actions);
        const nextRules = (await this.storage.getRules(roleId)).filter((rule) => {
            const actionMatches = normalizedActions.includes(rule.action);
            const resourceMatches = rule.resource === resource;
            return !(actionMatches && resourceMatches && sameWhere(rule.where, options.where));
        });

        await this.storage.setRules(roleId, nextRules);
        await this.cache.invalidateAll();
    }

    /**
     * 清空角色上的全部规则。
     */
    async clearRules(roleId: string): Promise<void> {
        this.ensureInitialized();
        await this.get(roleId);
        await this.storage.deleteRules(roleId);
        await this.cache.invalidateAll();
    }

    /**
     * 获取角色规则集合。
     */
    async getRules(roleId: string): Promise<PermissionRule[]> {
        this.ensureInitialized();
        await this.get(roleId);
        return this.storage.getRules(roleId);
    }

    /**
     * 获取角色的继承链。
     */
    async getRoleChain(roleId: string): Promise<RoleChainEntry[]> {
        this.ensureInitialized();
        await this.get(roleId);

        const roleIds = await this.resolver.resolveRoleChain(roleId, this.storage);
        return Promise.all(roleIds.map(async (currentRoleId) => {
            const role = await this.get(currentRoleId);
            const ruleCount = (await this.storage.getRules(currentRoleId)).length;

            return {
                ...role,
                ruleCount,
            };
        }));
    }

    /**
     * 获取角色连同父链展开后的有效规则集合。
     */
    async getEffectiveRules(roleId: string): Promise<PermissionRule[]> {
        this.ensureInitialized();
        await this.get(roleId);
        return this.resolver.mergeRules([roleId], this.storage, false);
    }

    /**
     * 读取角色详情页常用的聚合检查结果。
     */
    async inspect(roleId: string): Promise<RoleInspection> {
        this.ensureInitialized();
        const role = await this.get(roleId);

        const [ownRules, effectiveRules, roleChain] = await Promise.all([
            this.storage.getRules(roleId),
            this.getEffectiveRules(roleId),
            this.getRoleChain(roleId),
        ]);

        return {
            role,
            ownRules,
            effectiveRules,
            roleChain,
        };
    }

    /**
     * 统一写入 allow/deny 规则。
     */
    private async addRules(
        type: PermissionRule["type"],
        roleId: string,
        actions: string | string[],
        resource: string,
        options: RowRuleOptions,
    ) {
        await this.get(roleId);
        assertValidResource(resource);
        if (options.where) {
            if (!resource.startsWith("db:")) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.INVALID_ARGUMENT,
                    "where can only be used with db resources",
                );
            }
            assertValidWhereCondition(options.where);
        }

        // 规则写入前先做动作归一化，再通过 deduplicateRules 收口重复配置。
        const normalizedActions = normalizeActions(actions);
        const existingRules = await this.storage.getRules(roleId);
        const nextRules = deduplicateRules([
            ...existingRules,
            ...normalizedActions.map((action) => ({
                type,
                action,
                resource,
                where: options.where ? structuredClone(options.where) : undefined,
            })),
        ]);

        await this.storage.setRules(roleId, nextRules);
        await this.cache.invalidateAll();
    }

    /**
     * 断言角色存在。
     */
    private async ensureRoleExists(roleId: string) {
        if (!(await this.storage.getRole(roleId))) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.ROLE_NOT_FOUND,
                `Role '${roleId}' was not found`,
            );
        }
    }

    /**
     * 断言新的父角色不会引入循环继承。
     */
    private async assertNoCircularParent(roleId: string, parentRoleId: string) {
        if (roleId === parentRoleId) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.CIRCULAR_INHERITANCE,
                `Role '${roleId}' cannot inherit from itself`,
            );
        }

        const visited = new Set<string>([roleId]);
        let currentRoleId: string | null = parentRoleId;

        // 顺着父链向上检查，只要再次撞回已访问节点就说明出现环。
        while (currentRoleId) {
            if (visited.has(currentRoleId)) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.CIRCULAR_INHERITANCE,
                    `Circular inheritance detected for role '${roleId}'`,
                );
            }

            visited.add(currentRoleId);
            const currentRole = await this.storage.getRole(currentRoleId);
            currentRoleId = currentRole?.parent ?? null;
        }
    }
}