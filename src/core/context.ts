import type { Checker } from "../check/checker";

/**
 * 绑定 `userId` 后的链式上下文。
 *
 * 适合在控制器、服务层或中间件中先固定当前用户，再复用同一组权限 API。
 */
export class PermissionCoreContext {
    /**
     * @param checker 底层鉴权执行器。
     * @param userId 当前上下文绑定的用户 ID。
     */
    constructor(
        private readonly checker: Checker,
        private readonly userId: string,
    ) { }

    /**
     * 判断当前用户是否拥有指定资源权限。
     */
    can(action: string, resource: string) {
        return this.checker.can(this.userId, action, resource);
    }

    /**
     * 判断当前用户是否不拥有指定资源权限。
     */
    cannot(action: string, resource: string) {
        return this.checker.cannot(this.userId, action, resource);
    }

    /**
     * 对指定资源执行断言式鉴权。
     */
    assert(action: string, resource: string) {
        return this.checker.assert(this.userId, action, resource);
    }

    /**
     * 获取当前用户在指定 `db:` 资源上的行级范围。
     */
    getRowScope(action: string, resource: string, context?: Record<string, unknown>) {
        return this.checker.getRowScope(this.userId, action, resource, context);
    }

    /**
     * 判断当前用户是否可以访问某一行数据。
     */
    canRow(
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        return this.checker.canRow(this.userId, action, resource, row, context);
    }

    /**
     * 判断当前用户是否不能访问某一行数据。
     */
    cannotRow(
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        return this.checker.cannotRow(this.userId, action, resource, row, context);
    }

    /**
     * 对某一行数据执行断言式鉴权。
     */
    assertRow(
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        return this.checker.assertRow(this.userId, action, resource, row, context);
    }

    /**
     * 过滤当前用户可见的数据行。
     */
    filterRows<T extends Record<string, unknown>>(
        action: string,
        resource: string,
        rows: T[],
        context?: Record<string, unknown>,
    ) {
        return this.checker.filterRows(this.userId, action, resource, rows, context);
    }

    /**
     * 过滤当前用户可见的数据字段。
     */
    filterFields<T extends Record<string, unknown>>(
        action: string,
        resource: string,
        data: T,
        context?: Record<string, unknown>,
    ) {
        return this.checker.filterFields(this.userId, action, resource, data, context);
    }

    /**
     * 获取当前用户合并后的全部权限规则。
     */
    getPermissions() {
        return this.checker.getPermissions(this.userId);
    }

    /**
     * 获取当前用户在某个动作维度下可见的资源列表。
     */
    getResources(action?: string) {
        return this.checker.getResources(this.userId, action);
    }
}