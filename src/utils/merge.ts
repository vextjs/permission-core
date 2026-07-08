import type { PermissionRule, RowCondition } from "../types";

function normalizeJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeJsonValue(item));
    }

    if (value && typeof value === "object") {
        const toJSON = (value as { toJSON?: () => unknown }).toJSON;
        if (typeof toJSON === "function") {
            return normalizeJsonValue(toJSON.call(value));
        }

        return Object.keys(value)
            .sort()
            .reduce<Record<string, unknown>>((normalized, key) => {
                normalized[key] = normalizeJsonValue((value as Record<string, unknown>)[key]);
                return normalized;
            }, {});
    }

    return value;
}

function stableJson(value: unknown) {
    return JSON.stringify(value) ?? "undefined";
}

function normalizeConditionValue(condition: Extract<RowCondition, { field: string }>) {
    const normalizedValue = normalizeJsonValue(condition.value);

    if ((condition.op === "in" || condition.op === "nin") && Array.isArray(normalizedValue)) {
        return [...normalizedValue].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    }

    return normalizedValue;
}

function normalizeConditionList(conditions: RowCondition[]) {
    return conditions
        .map((condition) => normalizeRowCondition(condition))
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function normalizeRowCondition(condition: RowCondition): unknown {
    if ("all" in condition) {
        return { all: normalizeConditionList(condition.all) };
    }

    if ("any" in condition) {
        return { any: normalizeConditionList(condition.any) };
    }

    if ("not" in condition) {
        return { not: normalizeRowCondition(condition.not) };
    }

    const normalized: Record<string, unknown> = {
        field: condition.field,
        op: condition.op,
    };

    if ("value" in condition) {
        normalized.value = normalizeConditionValue(condition);
    }

    if ("valueFrom" in condition) {
        normalized.valueFrom = condition.valueFrom;
    }

    return normalized;
}

/**
 * 稳定化序列化行级条件，供规则去重与撤销匹配共用。
 */
export function stableCondition(condition: RowCondition | undefined) {
    return condition ? JSON.stringify(normalizeRowCondition(condition)) : "";
}

/**
 * 按 `type + action + resource + where` 对规则去重。
 */
export function deduplicateRules(rules: PermissionRule[]) {
    const deduplicated = new Map<string, PermissionRule>();

    // 去重键同时包含 type/action/resource/where，避免不同语义的规则互相覆盖。
    for (const rule of rules) {
        const key = [
            rule.type,
            rule.action,
            rule.resource,
            stableCondition(rule.where),
        ].join("::");

        if (!deduplicated.has(key)) {
            deduplicated.set(key, rule);
        }
    }

    return Array.from(deduplicated.values());
}
