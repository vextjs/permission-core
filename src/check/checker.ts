import { PermissionCoreError } from "../core/errors";
import {
    PermissionCoreErrorCode,
    type PermissionRule,
    type RowCondition,
    type RowScope,
} from "../types";
import { combineAnyConditions, evaluateRowCondition } from "../utils";
import { assertDbResource, assertNonEmptyString, assertValidAction, assertValidResource, isPlainObject } from "../utils/validation";
import type { PermissionCache } from "../cache";
import type { StorageAdapter } from "../storage";

import { Resolver } from "./resolver";
import { matchAction, matchResource, matchRule } from "./wildcard";

/**
 * 归一化行级权限求值上下文。
 *
 * 外部 `context` 只用于补充附加变量，不能覆盖当前鉴权主体的 `userId`。
 */
function buildEvaluationContext(
    userId: string,
    context?: Record<string, unknown>,
) {
    // userId 是 row DSL 最常用的 valueFrom 来源，统一注入避免每个调用点手写。
    return {
        ...(context ?? {}),
        userId,
    };
}

/**
 * 核心鉴权执行器。
 *
 * 它负责规则匹配、strict 优先级处理、行级范围收口、字段过滤与资源列表推导。
 */
export class Checker {
    private readonly resolver = new Resolver();

    /**
     * @param storage 规则与角色存储。
     * @param cache 用户规则集合缓存。
     * @param strict 是否启用 strict 模式。
     */
    constructor(
        private readonly storage: StorageAdapter,
        private readonly cache: PermissionCache,
        private readonly strict: boolean,
    ) { }

    /**
     * 判断用户是否拥有指定资源权限。
     */
    async can(userId: string, action: string, resource: string): Promise<boolean> {
        assertNonEmptyString(userId, "userId");
        assertValidAction(action);
        assertValidResource(resource);

        // 请求侧 write 必须同时满足 create 和 update，两者缺一不可。
        if (action === "write") {
            const canCreate = await this.can(userId, "create", resource);
            const canUpdate = await this.can(userId, "update", resource);
            return canCreate && canUpdate;
        }

        return this.canSingle(userId, action, resource);
    }

    /**
     * 判断用户是否不拥有指定资源权限。
     */
    async cannot(userId: string, action: string, resource: string): Promise<boolean> {
        return !(await this.can(userId, action, resource));
    }

    /**
     * 对指定资源执行断言式鉴权。
     */
    async assert(userId: string, action: string, resource: string): Promise<void> {
        const allowed = await this.can(userId, action, resource);
        if (!allowed) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.PERMISSION_DENIED,
                `Permission denied for ${action} ${resource}`,
            );
        }
    }

    /**
     * 获取用户合并后的全部权限规则。
     */
    async getPermissions(userId: string): Promise<PermissionRule[]> {
        assertNonEmptyString(userId, "userId");
        return this.getRules(userId);
    }

    /**
        * 获取用户在某个动作维度下可见的资源集合。
        *
        * strict 模式下，被 deny 规则覆盖的 allow 资源会从结果中剔除，因此它适合菜单/按钮预显隐，
        * 不应替代最终的 `can()` 判断。
     */
    async getResources(userId: string, action = "invoke"): Promise<string[]> {
        assertNonEmptyString(userId, "userId");
        assertValidAction(action);

        const rules = await this.getRules(userId);
        const allowRules = rules.filter(
            (rule) => rule.type === "allow" && matchAction(rule.action, action),
        );
        const denyRules = rules.filter(
            (rule) => rule.type === "deny" && matchAction(rule.action, action),
        );

        const resources = new Set<string>();
        for (const allowRule of allowRules) {
            // strict 模式下如果 deny 已经覆盖该资源，就不要再把它暴露给菜单/按钮层。
            const coveredByDeny =
                this.strict
                && denyRules.some((denyRule) => matchResource(denyRule.resource, allowRule.resource));
            if (!coveredByDeny) {
                resources.add(allowRule.resource);
            }
        }

        return Array.from(resources);
    }

    /**
     * 计算用户在指定 `db:` 资源上的行级访问范围。
     */
    async getRowScope(
        userId: string,
        action: string,
        resource: string,
        context?: Record<string, unknown>,
    ): Promise<RowScope> {
        assertNonEmptyString(userId, "userId");
        assertValidAction(action);
        assertDbResource(resource);

        // 先做资源级放行，未放行时无需继续计算行级条件。
        const allowed = await this.can(userId, action, resource);
        if (!allowed) {
            return { mode: "none" };
        }

        const rules = (await this.getRules(userId)).filter((rule) => matchRule(rule, action, resource));
        if (rules.some((rule) => rule.type === "deny" && !rule.where)) {
            return { mode: "none" };
        }

        const allowConditions = rules
            .filter((rule) => rule.type === "allow" && rule.where)
            .map((rule) => rule.where as RowCondition);
        const denyConditions = rules
            .filter((rule) => rule.type === "deny" && rule.where)
            .map((rule) => rule.where as RowCondition);
        const exclude = combineAnyConditions(denyConditions);
        const hasUnconditionalAllow = rules.some((rule) => rule.type === "allow" && !rule.where);

        // 无条件 allow 代表整表可见，带 where 的 deny 仅作为排除条件继续生效。
        if (hasUnconditionalAllow) {
            return exclude ? { mode: "all", exclude } : { mode: "all" };
        }

        const include = combineAnyConditions(allowConditions);
        if (!include) {
            return { mode: "none" };
        }

        return exclude ? { mode: "conditional", include, exclude } : { mode: "conditional", include };
    }

    /**
     * 判断用户是否可以访问某一行数据。
     */
    async canRow(
        userId: string,
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ): Promise<boolean> {
        assertDbResource(resource);
        if (!isPlainObject(row)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                "row must be a plain object",
            );
        }

        const scope = await this.getRowScope(userId, action, resource, context);
        const evaluationContext = buildEvaluationContext(userId, context);

        if (scope.mode === "none") {
            return false;
        }

        if (scope.mode === "all") {
            return scope.exclude ? !evaluateRowCondition(scope.exclude, row, evaluationContext) : true;
        }

        if (!scope.include) {
            return false;
        }

        const included = evaluateRowCondition(scope.include, row, evaluationContext);
        const excluded = scope.exclude ? evaluateRowCondition(scope.exclude, row, evaluationContext) : false;
        return included && !excluded;
    }

    /**
     * 判断用户是否不能访问某一行数据。
     */
    async cannotRow(
        userId: string,
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ): Promise<boolean> {
        return !(await this.canRow(userId, action, resource, row, context));
    }

    /**
     * 对某一行数据执行断言式鉴权。
     */
    async assertRow(
        userId: string,
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ): Promise<void> {
        if (!(await this.canRow(userId, action, resource, row, context))) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.PERMISSION_DENIED,
                `Permission denied for row ${action} ${resource}`,
            );
        }
    }

    /**
     * 过滤出用户可见的数据行。
     */
    async filterRows<T extends Record<string, unknown>>(
        userId: string,
        action: string,
        resource: string,
        rows: T[],
        context?: Record<string, unknown>,
    ): Promise<T[]> {
        assertDbResource(resource);
        if (!Array.isArray(rows)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                "rows must be an array",
            );
        }

        const visibleRows: T[] = [];
        for (const row of rows) {
            if (await this.canRow(userId, action, resource, row, context)) {
                visibleRows.push(row);
            }
        }

        return visibleRows;
    }

    /**
     * 过滤出用户可见的数据字段。
     *
     * 字段级 `where` 求值时会继续传入整条对象作为 row，这样字段规则可以复用同一行中的兄弟字段做判断。
     */
    async filterFields<T extends Record<string, unknown>>(
        userId: string,
        action: string,
        resource: string,
        data: T,
        context?: Record<string, unknown>,
    ): Promise<Partial<T>> {
        assertDbResource(resource);
        if (!isPlainObject(data)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                "data must be a plain object",
            );
        }

        const filteredData: Partial<T> = {};

        for (const [key, value] of Object.entries(data)) {
            const fieldResource = `${resource}:${key}`;
            if (await this.canRow(userId, action, fieldResource, data, context)) {
                filteredData[key as keyof T] = value as T[keyof T];
            }
        }

        return filteredData;
    }

    /**
     * 计算单个动作的资源级权限结果。
     */
    private async canSingle(userId: string, action: string, resource: string) {
        const rules = await this.getRules(userId);
        const matchedRules = rules.filter((rule) => matchRule(rule, action, resource));
        const unconditionalRules = matchedRules.filter((rule) => !rule.where);

        if (this.strict) {
            // 资源级 can() 只看无条件规则，带 where 的 deny 交给行级收口处理。
            if (unconditionalRules.some((rule) => rule.type === "deny")) {
                return false;
            }

            if (unconditionalRules.some((rule) => rule.type === "allow")) {
                return true;
            }

            return matchedRules.some((rule) => rule.type === "allow");
        }

        let result = false;
        for (const rule of unconditionalRules) {
            if (matchRule(rule, action, resource)) {
                result = rule.type === "allow";
            }
        }

        return result || matchedRules.some((rule) => rule.type === "allow");
    }

    /**
     * 获取用户合并后的规则，并在缓存 miss 时展开角色链后写回缓存。
     */
    private async getRules(userId: string): Promise<PermissionRule[]> {
        const cachedRules = await this.cache.get(userId);
        if (cachedRules !== null) {
            return cachedRules;
        }

        // 缓存 miss 时才展开角色链，避免每次鉴权都重复合并规则。
        const roleIds = await this.storage.getUserRoles(userId);
        const rules = await this.resolver.mergeRules(roleIds, this.storage, this.strict);
        await this.cache.set(userId, rules);
        return rules;
    }
}