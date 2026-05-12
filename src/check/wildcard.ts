import type { PermissionRule } from "../types";

function splitHttpResource(value: string) {
    const separatorIndex = value.indexOf(":");

    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        return null;
    }

    return {
        method: value.slice(0, separatorIndex),
        path: value.slice(separatorIndex + 1)
    };
}

function normalizePathSegments(path: string) {
    if (path === "*") {
        return ["*"];
    }

    return path.split("/").filter(Boolean);
}

function matchPathPattern(patternPath: string, resourcePath: string) {
    if (patternPath === "*") {
        return true;
    }

    const patternSegments = normalizePathSegments(patternPath);
    const resourceSegments = normalizePathSegments(resourcePath);

    let patternIndex = 0;
    let resourceIndex = 0;

    // 支持尾部 * 和 :id 这类单段通配，不支持中间位置的贪婪匹配。
    while (patternIndex < patternSegments.length) {
        const patternSegment = patternSegments[patternIndex];
        const resourceSegment = resourceSegments[resourceIndex];
        const isLastPatternSegment = patternIndex === patternSegments.length - 1;

        if (patternSegment === "*") {
            return isLastPatternSegment ? resourceIndex < resourceSegments.length : false;
        }

        if (!resourceSegment) {
            return false;
        }

        if (patternSegment.startsWith(":")) {
            patternIndex += 1;
            resourceIndex += 1;
            continue;
        }

        if (patternSegment !== resourceSegment) {
            return false;
        }

        patternIndex += 1;
        resourceIndex += 1;
    }

    return resourceIndex === resourceSegments.length;
}

function matchHttpResource(pattern: string, resource: string) {
    const patternResource = splitHttpResource(pattern);
    const concreteResource = splitHttpResource(resource);

    if (!patternResource || !concreteResource) {
        return false;
    }

    if (
        patternResource.method !== "*" &&
        patternResource.method !== concreteResource.method
    ) {
        return false;
    }

    return matchPathPattern(patternResource.path, concreteResource.path);
}

function matchDbResource(pattern: string, resource: string) {
    // db 资源的匹配层级固定为 db:collection[:field]。
    const patternParts = pattern.split(":");
    const resourceParts = resource.split(":");

    if (patternParts[0] !== "db" || resourceParts[0] !== "db") {
        return false;
    }

    if (patternParts.length < 2 || resourceParts.length < 2) {
        return false;
    }

    if (patternParts[1] !== "*" && patternParts[1] !== resourceParts[1]) {
        return false;
    }

    if (patternParts.length === 2) {
        return patternParts[1] === "*" ? true : resourceParts.length === 2;
    }

    if (resourceParts.length !== 3) {
        return false;
    }

    return patternParts[2] === "*" || patternParts[2] === resourceParts[2];
}

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

export function matchResource(pattern: string, resource: string) {
    if (pattern === "*") {
        return true;
    }

    // HTTP 与 db 资源不能跨模型匹配，避免错误放大授权范围。
    if (pattern.startsWith("db:") || resource.startsWith("db:")) {
        if (!(pattern.startsWith("db:") && resource.startsWith("db:"))) {
            return false;
        }

        return matchDbResource(pattern, resource);
    }

    return matchHttpResource(pattern, resource);
}

export function matchRule(
    rule: Pick<PermissionRule, "action" | "resource">,
    action: string,
    resource: string,
) {
    return matchAction(rule.action, action) && matchResource(rule.resource, resource);
}