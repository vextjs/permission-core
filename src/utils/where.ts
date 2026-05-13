import type { RowCondition } from "../types";

/**
 * 读取当前条件的比较目标值。
 */
function readExpectedValue(
    condition: Extract<RowCondition, { field: string }>,
    context: Record<string, unknown>,
) {
    // valueFrom 让规则可以复用 userId、tenantId 这类运行时上下文。
    if (condition.valueFrom !== undefined) {
        return context[condition.valueFrom];
    }

    return condition.value;
}

/**
 * 将多个条件折叠成最小可执行的 `any` 结构。
 */
export function combineAnyConditions(conditions: RowCondition[]) {
    // 零个条件代表没有收口，单个条件则保留原结构，避免无意义嵌套。
    if (conditions.length === 0) {
        return undefined;
    }

    if (conditions.length === 1) {
        return conditions[0];
    }

    return { any: conditions } satisfies RowCondition;
}

/**
 * 执行单条行级条件或条件树求值。
 */
export function evaluateRowCondition(
    condition: RowCondition,
    row: Record<string, unknown>,
    context: Record<string, unknown>,
): boolean {
    // 先处理逻辑节点，再落到最末端的字段比较节点。
    if ("all" in condition) {
        return condition.all.every((child) => evaluateRowCondition(child, row, context));
    }

    if ("any" in condition) {
        return condition.any.some((child) => evaluateRowCondition(child, row, context));
    }

    if ("not" in condition) {
        return !evaluateRowCondition(condition.not, row, context);
    }

    const actual = row[condition.field];
    const expected = readExpectedValue(condition, context);

    switch (condition.op) {
        case "eq":
            return actual === expected;
        case "ne":
            return actual !== expected;
        case "in":
            return Array.isArray(expected) && expected.includes(actual);
        case "nin":
            return Array.isArray(expected) && !expected.includes(actual);
        case "gt":
            return actual != null && expected != null && actual > expected;
        case "gte":
            return actual != null && expected != null && actual >= expected;
        case "lt":
            return actual != null && expected != null && actual < expected;
        case "lte":
            return actual != null && expected != null && actual <= expected;
        case "contains":
            if (typeof actual === "string" && typeof expected === "string") {
                return actual.includes(expected);
            }

            return Array.isArray(actual) && actual.includes(expected);
        case "exists":
            // exists=false 语义是字段必须不存在，而不是值为 null。
            return condition.value === false ? actual === undefined : actual !== undefined;
    }
}