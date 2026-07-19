import { matchBuiltInResource } from "./built-in-resources";

interface ActionResourceRule {
    action: string;
    resource: string;
}

/**
 * 匹配规则动作与请求动作。
 */
export function matchAction(pattern: string, requestAction: string) {
    if (pattern === "*") {
        return true;
    }

    // 规则侧 write 代表同时覆盖 create/update 两种请求动作。
    if (pattern === "write") {
        return requestAction === "create" || requestAction === "update";
    }

    return pattern === requestAction;
}

/**
 * 匹配规则资源与请求资源。
 */
export function matchResource(pattern: string, resource: string) {
    return matchBuiltInResource(pattern, resource);
}

/**
 * 同时匹配规则动作与规则资源。
 */
export function matchRule(
    rule: ActionResourceRule,
    action: string,
    resource: string,
) {
    return matchAction(rule.action, action) && matchResource(rule.resource, resource);
}
