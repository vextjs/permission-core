import type { Checker } from "../check/checker";

// 链式上下文用于把 userId 固定下来，减少业务层重复传参。
export class PermissionCoreContext {
    constructor(
        private readonly checker: Checker,
        private readonly userId: string,
    ) { }

    can(action: string, resource: string) {
        return this.checker.can(this.userId, action, resource);
    }

    cannot(action: string, resource: string) {
        return this.checker.cannot(this.userId, action, resource);
    }

    assert(action: string, resource: string) {
        return this.checker.assert(this.userId, action, resource);
    }

    getRowScope(action: string, resource: string, context?: Record<string, unknown>) {
        return this.checker.getRowScope(this.userId, action, resource, context);
    }

    canRow(
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        return this.checker.canRow(this.userId, action, resource, row, context);
    }

    cannotRow(
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        return this.checker.cannotRow(this.userId, action, resource, row, context);
    }

    assertRow(
        action: string,
        resource: string,
        row: Record<string, unknown>,
        context?: Record<string, unknown>,
    ) {
        return this.checker.assertRow(this.userId, action, resource, row, context);
    }

    filterRows<T extends Record<string, unknown>>(
        action: string,
        resource: string,
        rows: T[],
        context?: Record<string, unknown>,
    ) {
        return this.checker.filterRows(this.userId, action, resource, rows, context);
    }

    filterFields<T extends Record<string, unknown>>(
        action: string,
        resource: string,
        data: T,
        context?: Record<string, unknown>,
    ) {
        return this.checker.filterFields(this.userId, action, resource, data, context);
    }

    getPermissions() {
        return this.checker.getPermissions(this.userId);
    }

    getResources(action?: string) {
        return this.checker.getResources(this.userId, action);
    }
}