import type { PermissionRule, RowCondition } from "../types";

/**
 * 稳定化序列化行级条件，供规则去重使用。
 */
function stableCondition(condition: RowCondition | undefined) {
    return condition ? JSON.stringify(condition) : "";
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