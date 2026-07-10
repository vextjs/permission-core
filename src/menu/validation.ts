import type { ApiBinding, MenuNode, MenuValidationDiagnostic, RoleRuleSource } from "./types";
import { createApiResource } from "./manifest";
import { getNodeBinding } from "./binding";
import type { PermissionRule } from "../types";
import { matchAction, matchResource } from "../check/wildcard";
import { assertValidAction, assertValidResource } from "../utils/validation";
import type { ResourceSchemeRegistry } from "../check/resource-schemes";

export interface MenuValidationOptions {
    resourceSchemes?: Pick<ResourceSchemeRegistry, "assertValid" | "match">;
}

interface ResourceValidationRuntime {
    assertValid(resource: string): void;
    match(pattern: string, resource: string): boolean;
}

export function validateMenuConfiguration(
    nodes: MenuNode[],
    apiBindings: ApiBinding[],
    roleRules: PermissionRule[] | RoleRuleSource[] = [],
    options: MenuValidationOptions = {},
): MenuValidationDiagnostic[] {
    const diagnostics: MenuValidationDiagnostic[] = [];
    const resources: ResourceValidationRuntime = options.resourceSchemes
        ? {
            assertValid: (resource) => options.resourceSchemes!.assertValid(resource),
            match: (pattern, resource) => options.resourceSchemes!.match(pattern, resource),
        }
        : { assertValid: assertValidResource, match: matchResource };
    const nodeIds = new Set<string>();
    const duplicateNodeIds = new Set<string>();

    for (const node of nodes) {
        if (nodeIds.has(node.id)) {
            duplicateNodeIds.add(node.id);
        }
        nodeIds.add(node.id);

        if (node.resource) {
            try {
                assertValidAction(node.resource.action);
                resources.assertValid(node.resource.resource);
            } catch {
                diagnostics.push({
                    code: "V-RESOURCE",
                    severity: "error",
                    message: `Invalid resource '${node.resource.resource}'`,
                    assetId: node.id,
                    resource: node.resource.resource,
                });
            }
        }

        for (const dataPermission of node.dataPermissions ?? []) {
            try {
                assertValidAction(dataPermission.action ?? "read");
                resources.assertValid(dataPermission.resource);
            } catch {
                diagnostics.push({
                    code: "V-RESOURCE",
                    severity: "error",
                    message: `Invalid data permission resource '${dataPermission.resource}'`,
                    assetId: node.id,
                    resource: dataPermission.resource,
                });
            }
        }
    }

    for (const id of duplicateNodeIds) {
        diagnostics.push({
            code: "V-01",
            severity: "error",
            message: `Duplicate menu id '${id}'`,
            assetId: id,
        });
    }

    for (const node of nodes) {
        if (node.parentId && !nodeIds.has(node.parentId)) {
            diagnostics.push({
                code: "V-03",
                severity: "error",
                message: `Parent '${node.parentId}' does not exist`,
                assetId: node.id,
            });
        }
        if (node.type === "button") {
            const pageId = node.pageId ?? node.parentId;
            const page = pageId ? nodes.find((candidate) => candidate.id === pageId) : undefined;
            if (!page || page.type !== "page") {
                diagnostics.push({
                    code: "V-03",
                    severity: "error",
                    message: `Button '${node.id}' must reference an existing page`,
                    assetId: node.id,
                });
            }
        }
    }

    diagnostics.push(...detectCycles(nodes));
    diagnostics.push(...detectPathConflicts(nodes));
    diagnostics.push(...detectButtonCodeConflicts(nodes));
    diagnostics.push(...validateApiBindings(nodes, apiBindings, resources));
    diagnostics.push(...validateRoleApiConsistency(nodes, apiBindings, roleRules, resources));
    diagnostics.push(...detectStaleRules(nodes, apiBindings, flattenRoleRules(roleRules), resources));

    return diagnostics;
}

function detectCycles(nodes: MenuNode[]): MenuValidationDiagnostic[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const diagnostics: MenuValidationDiagnostic[] = [];

    for (const node of nodes) {
        const visited = new Set<string>();
        let current: MenuNode | undefined = node;
        while (current?.parentId) {
            if (visited.has(current.parentId)) {
                diagnostics.push({
                    code: "V-02",
                    severity: "error",
                    message: `Cycle detected at '${node.id}'`,
                    assetId: node.id,
                });
                break;
            }

            visited.add(current.id);
            current = byId.get(current.parentId);
        }
    }

    return diagnostics;
}

function detectPathConflicts(nodes: MenuNode[]): MenuValidationDiagnostic[] {
    const pathOwners = new Map<string, MenuNode[]>();
    const diagnostics: MenuValidationDiagnostic[] = [];

    for (const node of nodes) {
        if (!node.path || node.type === "button") {
            continue;
        }

        const owners = pathOwners.get(node.path) ?? [];
        owners.push(node);
        pathOwners.set(node.path, owners);
    }

    for (const [path, owners] of pathOwners) {
        const ownersByType = new Map<string, MenuNode[]>();
        for (const owner of owners) {
            const sameTypeOwners = ownersByType.get(owner.type) ?? [];
            sameTypeOwners.push(owner);
            ownersByType.set(owner.type, sameTypeOwners);
        }

        for (const sameTypeOwners of ownersByType.values()) {
            if (sameTypeOwners.length < 2) {
                continue;
            }

            const ownerIds = sameTypeOwners.map((owner) => owner.id);
            diagnostics.push({
                code: "V-04",
                severity: "error",
                message: `Path '${path}' has ambiguous ${sameTypeOwners[0].type} owners: ${ownerIds.join(", ")}`,
                assetId: ownerIds[1],
            });
        }
    }

    return diagnostics;
}

function detectButtonCodeConflicts(nodes: MenuNode[]): MenuValidationDiagnostic[] {
    const seen = new Set<string>();
    const diagnostics: MenuValidationDiagnostic[] = [];

    for (const node of nodes.filter((candidate) => candidate.type === "button")) {
        const pageId = node.pageId ?? node.parentId ?? "";
        const code = node.code ?? node.id;
        const key = `${pageId}:${code}`;
        if (seen.has(key)) {
            diagnostics.push({
                code: "V-05",
                severity: "error",
                message: `Button code '${code}' is duplicated in page '${pageId}'`,
                assetId: node.id,
            });
        }

        seen.add(key);
    }

    return diagnostics;
}

function validateApiBindings(
    nodes: MenuNode[],
    apiBindings: ApiBinding[],
    resources: ResourceValidationRuntime,
): MenuValidationDiagnostic[] {
    const diagnostics: MenuValidationDiagnostic[] = [];
    const seenIds = new Set<string>();

    for (const binding of apiBindings) {
        if (seenIds.has(binding.id)) {
            diagnostics.push({
                code: "V-13",
                severity: "error",
                message: `Duplicate API binding id '${binding.id}'`,
                assetId: binding.id,
            });
        }
        seenIds.add(binding.id);

        const validPath = binding.path.startsWith("/") && !binding.path.includes("?");
        if (!/^[A-Z*]+$/.test(binding.method) || !validPath) {
            diagnostics.push({
                code: "V-06",
                severity: "error",
                message: `Invalid API binding '${binding.method} ${binding.path}'`,
                assetId: binding.id,
                resource: binding.resource,
            });
        }

        const expectedResource = createApiResource(binding.method, binding.path);
        if (binding.resource.startsWith("api:") && binding.resource !== expectedResource) {
            diagnostics.push({
                code: "V-07",
                severity: "error",
                message: `API resource '${binding.resource}' does not match '${expectedResource}'`,
                assetId: binding.id,
                resource: binding.resource,
            });
        }

        if (!binding.resource) {
            diagnostics.push({
                code: "V-08",
                severity: "error",
                message: `Protected API '${binding.id}' has no resource`,
                assetId: binding.id,
            });
        } else {
            try {
                assertValidAction(binding.action ?? "invoke");
                resources.assertValid(binding.resource);
            } catch {
                diagnostics.push({
                    code: "V-08",
                    severity: "error",
                    message: `Protected API '${binding.id}' has invalid permission metadata`,
                    assetId: binding.id,
                    resource: binding.resource,
                });
            }
        }

        if (binding.ownerType !== "apiGroup") {
            const owner = nodes.find((node) => node.id === binding.ownerId);
            if (!owner || owner.type !== binding.ownerType) {
                diagnostics.push({
                    code: "V-14",
                    severity: "error",
                    message: `API binding '${binding.id}' references missing ${binding.ownerType} owner '${binding.ownerId}'`,
                    assetId: binding.id,
                });
            }
        } else if (!binding.description?.trim()) {
            diagnostics.push({
                code: "V-14",
                severity: "warning",
                message: `Orphan API group binding '${binding.id}' should explain its purpose`,
                assetId: binding.id,
            });
        }
    }

    const bindingsByResource = new Map<string, ApiBinding[]>();
    for (const binding of apiBindings) {
        const owners = bindingsByResource.get(binding.resource) ?? [];
        owners.push(binding);
        bindingsByResource.set(binding.resource, owners);
    }
    for (const [resource, bindings] of bindingsByResource) {
        if (bindings.length < 2) {
            continue;
        }
        const canonicalOwners = bindings.filter((binding) => binding.canonicalOwner);
        if (canonicalOwners.length !== 1) {
            diagnostics.push({
                code: "V-15",
                severity: canonicalOwners.length > 1 ? "error" : "warning",
                message: `Shared API resource '${resource}' must have exactly one canonical owner`,
                resource,
            });
        }
    }

    const permissionGroups = new Map<string, ApiBinding[]>();
    for (const binding of apiBindings.filter((candidate) => candidate.permissionGroup)) {
        const group = permissionGroups.get(binding.permissionGroup!) ?? [];
        group.push(binding);
        permissionGroups.set(binding.permissionGroup!, group);
    }
    for (const [groupId, bindings] of permissionGroups) {
        const signatures = new Set(bindings.map((binding) => [
            binding.ownerType,
            binding.ownerId,
            binding.method,
            binding.path,
            binding.permissionMode ?? "all",
        ].join("|")));
        if (signatures.size > 1) {
            diagnostics.push({
                code: "V-16",
                severity: "error",
                message: `API permission group '${groupId}' has inconsistent owner, route or mode metadata`,
                assetId: groupId,
            });
        }
    }

    return diagnostics;
}

function validateRoleApiConsistency(
    nodes: MenuNode[],
    apiBindings: ApiBinding[],
    roleRules: PermissionRule[] | RoleRuleSource[],
    resources: ResourceValidationRuntime,
): MenuValidationDiagnostic[] {
    if (!isRoleRuleSources(roleRules)) {
        return [];
    }

    const diagnostics: MenuValidationDiagnostic[] = [];
    const buttons = nodes.filter((node) => node.type === "button");
    for (const source of roleRules) {
        for (const button of buttons) {
            const buttonBinding = getNodeBinding(button);
            if (!isAllowed(source.rules, buttonBinding.action, buttonBinding.resource, resources)) {
                continue;
            }
            const missingApi = findMissingRequiredApiForRules(
                apiBindings.filter((binding) => binding.ownerType === "button" && binding.ownerId === button.id),
                source.rules,
                resources,
            );
            if (missingApi) {
                diagnostics.push({
                    code: "V-09",
                    severity: "warning",
                    message: `Role '${source.roleId}' allows button '${button.id}' but not required API '${missingApi.id}'`,
                    assetId: button.id,
                    resource: missingApi.resource,
                });
            }
        }
    }
    return diagnostics;
}

function findMissingRequiredApiForRules(
    bindings: ApiBinding[],
    rules: PermissionRule[],
    resources: ResourceValidationRuntime,
) {
    const groups = new Map<string, ApiBinding[]>();
    for (const binding of bindings.filter((candidate) => candidate.required)) {
        const key = binding.permissionGroup ?? `binding:${binding.id}`;
        const group = groups.get(key) ?? [];
        group.push(binding);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        const mode = group[0].permissionMode ?? "all";
        const results = group.map((binding) => ({
            binding,
            allowed: isAllowed(rules, binding.action ?? "invoke", binding.resource, resources),
        }));
        const satisfied = mode === "any"
            ? results.some((result) => result.allowed)
            : results.every((result) => result.allowed);
        if (!satisfied) {
            return results.find((result) => !result.allowed)?.binding ?? group[0];
        }
    }
    return undefined;
}

function detectStaleRules(
    nodes: MenuNode[],
    apiBindings: ApiBinding[],
    roleRules: PermissionRule[],
    resources: ResourceValidationRuntime,
): MenuValidationDiagnostic[] {
    const knownResources = new Set<string>();
    for (const node of nodes) {
        knownResources.add(getNodeBinding(node).resource);
        for (const dataPermission of node.dataPermissions ?? []) {
            knownResources.add(dataPermission.resource);
        }
    }
    for (const binding of apiBindings) {
        knownResources.add(binding.resource);
    }

    return roleRules
        .filter((rule) => (rule.resource.startsWith("ui:") || rule.resource.startsWith("api:"))
            && !Array.from(knownResources).some((resource) => resources.match(rule.resource, resource)))
        .map((rule) => ({
            code: "V-10",
            severity: "warning" as const,
            message: `Rule references missing asset resource '${rule.resource}'`,
            resource: rule.resource,
        }));
}

function flattenRoleRules(roleRules: PermissionRule[] | RoleRuleSource[]) {
    return isRoleRuleSources(roleRules) ? roleRules.flatMap((source) => source.rules) : roleRules;
}

function isRoleRuleSources(value: PermissionRule[] | RoleRuleSource[]): value is RoleRuleSource[] {
    return value.length > 0 && "roleId" in value[0];
}

function isAllowed(
    rules: PermissionRule[],
    action: string,
    resource: string,
    resources: ResourceValidationRuntime,
) {
    const matches = rules.filter((rule) => matchAction(rule.action, action) && resources.match(rule.resource, resource));
    return matches.some((rule) => rule.type === "allow") && !matches.some((rule) => rule.type === "deny");
}
