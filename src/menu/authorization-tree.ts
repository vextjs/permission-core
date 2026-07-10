import { getNodeBinding } from "./binding";
import type { ApiBinding, AuthorizationTreeNode, AuthorizationTreeState, MenuNode, RoleRuleSource } from "./types";
import type { PermissionRule } from "../types";
import { matchAction, matchResource } from "../check/wildcard";

export function buildAuthorizationTree(
    nodes: MenuNode[],
    apiBindings: ApiBinding[],
    ownRules: PermissionRule[],
    effectiveRules: PermissionRule[],
    roleRuleSources: RoleRuleSource[] = [],
    resourceMatcher: (pattern: string, resource: string) => boolean = matchResource,
): AuthorizationTreeNode[] {
    const nodeMap = new Map<string, AuthorizationTreeNode>();
    const children = new Map<string, AuthorizationTreeNode[]>();

    for (const node of nodes) {
        const binding = getNodeBinding(node);
        const resolved = resolveState(
            binding.action,
            binding.resource,
            ownRules,
            effectiveRules,
            roleRuleSources,
            resourceMatcher,
        );
        nodeMap.set(node.id, {
            id: node.id,
            type: node.type,
            title: node.title,
            action: binding.action,
            resource: binding.resource,
            state: resolved.state,
            sourceRoleIds: resolved.sourceRoleIds,
            dataPermissions: node.dataPermissions,
        });
    }

    for (const binding of apiBindings) {
        const resolved = resolveState(
            binding.action ?? "invoke",
            binding.resource,
            ownRules,
            effectiveRules,
            roleRuleSources,
            resourceMatcher,
        );
        const apiNode: AuthorizationTreeNode = {
            id: `api:${binding.id}`,
            type: "api",
            title: binding.description ?? `${binding.method} ${binding.path}`,
            action: binding.action ?? "invoke",
            resource: binding.resource,
            state: resolved.state,
            sourceRoleIds: resolved.sourceRoleIds,
            apiBindings: [binding],
        };
        const apiChildren = children.get(binding.ownerId) ?? [];
        apiChildren.push(apiNode);
        children.set(binding.ownerId, apiChildren);
    }

    for (const node of nodes) {
        const treeNode = nodeMap.get(node.id);
        if (!treeNode) {
            continue;
        }

        const parentId = node.type === "button" ? (node.pageId ?? node.parentId) : node.parentId;
        if (!parentId) {
            continue;
        }

        const parentChildren = children.get(parentId) ?? [];
        parentChildren.push(treeNode);
        children.set(parentId, parentChildren);
    }

    for (const [id, treeNode] of nodeMap.entries()) {
        const nodeChildren = children.get(id);
        if (nodeChildren?.length) {
            treeNode.children = nodeChildren.sort(compareAuthorizationNodes);
        }
    }

    return nodes
        .filter((node) => !node.parentId && node.type !== "button")
        .map((node) => nodeMap.get(node.id))
        .filter((node): node is AuthorizationTreeNode => node !== undefined)
        .sort(compareAuthorizationNodes);
}

function resolveState(
    action: string,
    resource: string,
    ownRules: PermissionRule[],
    effectiveRules: PermissionRule[],
    roleRuleSources: RoleRuleSource[],
    resourceMatcher: (pattern: string, resource: string) => boolean,
): { state: AuthorizationTreeState; sourceRoleIds?: string[] } {
    const matches = (rule: PermissionRule) => matchAction(rule.action, action) && resourceMatcher(rule.resource, resource);
    const ownMatches = ownRules.filter(matches);
    const effectiveMatches = effectiveRules.filter(matches);
    const ownAllow = ownMatches.some((rule) => rule.type === "allow");
    const ownDeny = ownMatches.some((rule) => rule.type === "deny");
    const inheritedAllow = effectiveMatches.some((rule) => rule.type === "allow");
    const inheritedDeny = effectiveMatches.some((rule) => rule.type === "deny");
    const ownRoleId = roleRuleSources[0]?.roleId;
    const sourceRoleIds = (types: PermissionRule["type"][]) => roleRuleSources
        .filter((source) => (!ownRoleId || source.roleId !== ownRoleId || ownMatches.length > 0)
            && source.rules.some((rule) => types.includes(rule.type) && matches(rule)))
        .map((source) => source.roleId);
    const ownSource = ownRoleId ? [ownRoleId] : undefined;

    if (ownAllow && ownDeny) {
        return { state: "conflict", sourceRoleIds: ownSource };
    }

    if (ownDeny) {
        return { state: "deny", sourceRoleIds: ownSource };
    }

    if (ownAllow) {
        return { state: "allow", sourceRoleIds: ownSource };
    }

    if (inheritedDeny && inheritedAllow) {
        return { state: "conflict", sourceRoleIds: sourceRoleIds(["allow", "deny"]) };
    }

    if (inheritedDeny) {
        return { state: "inherit-deny", sourceRoleIds: sourceRoleIds(["deny"]) };
    }

    if (inheritedAllow) {
        return { state: "inherit-allow", sourceRoleIds: sourceRoleIds(["allow"]) };
    }

    return { state: "none" };
}

function compareAuthorizationNodes(left: AuthorizationTreeNode, right: AuthorizationTreeNode) {
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}
