import type {
    ManagementConflict,
    MenuGrantIntent,
    MenuPermissionChoiceRequirement,
    MenuPermissionSelection,
    MenuRuleContribution,
} from "../types";
import { compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../persistence/documents";
import { createMenuSourceId, createSemanticKey } from "../rbac/materialize";
import type { createRoleMenuGrantSnapshotFromContributions } from "./source-rewrite";

export const MAX_MENU_MUTATIONS = 1_000;

export interface PlannedRoleMenuGrant {
    readonly grantId: string;
    readonly effect: "allow" | "deny";
    readonly intent: MenuGrantIntent;
    readonly snapshot: ReturnType<typeof createRoleMenuGrantSnapshotFromContributions>;
    readonly contributions: readonly MenuRuleContribution[];
}

export interface RoleMenuSelectionPlan {
    readonly grants: readonly PlannedRoleMenuGrant[];
    readonly choiceRequirements: readonly MenuPermissionChoiceRequirement[];
    readonly conflicts: readonly ManagementConflict[];
}

export interface SelectionPlanInput {
    readonly scopeHash: string;
    readonly roleId: string;
    readonly effect: "allow" | "deny";
    readonly selection: MenuPermissionSelection;
    readonly nodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly bindings: readonly Readonly<InternalApiBindingDocument>[];
}

export function conflict(id: string, code: string, message: string): ManagementConflict {
    return deepFreeze({ id, code, message });
}

export function menuChoiceDecisionDetailCount(
    requirements: readonly MenuPermissionChoiceRequirement[],
) {
    return requirements.reduce(
        (total, requirement) => total + 1 + requirement.candidates.total,
        0,
    );
}

export function permissionSemanticKey(
    effect: "allow" | "deny",
    permission: { action: MenuRuleContribution["action"]; resource: string; where?: MenuRuleContribution["where"] },
) {
    return createSemanticKey(effect, permission.action, permission.resource, permission.where);
}

export function selectedAssets(
    anchor: Readonly<InternalMenuNodeDocument>,
    selection: MenuPermissionSelection,
    children: ReadonlyMap<string | null, readonly Readonly<InternalMenuNodeDocument>[]>,
) {
    const result = [anchor];
    const queue = [...(children.get(anchor.nodeId) ?? [])];
    for (let index = 0; index < queue.length; index += 1) {
        const node = queue[index]!;
        queue.push(...(children.get(node.nodeId) ?? []));
        if (node.type === "button" ? selection.include.buttons : selection.include.descendants) {
            result.push(node);
        }
    }
    return result.sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
}

export function ownerType(node: Readonly<InternalMenuNodeDocument>) {
    return node.type === "menu" || node.type === "page" || node.type === "button"
        ? node.type
        : null;
}

export function choiceId(value: unknown) {
    return `choice_${digestCanonical(value)}`;
}

export function contribution(
    grantId: string,
    effect: "allow" | "deny",
    rule: { action: MenuRuleContribution["action"]; resource: string; where?: MenuRuleContribution["where"] },
    provenance:
        | { contribution: "node"; assetId: string }
        | { contribution: "api"; assetId: string; apiBindingId: string }
        | { contribution: "data"; assetId: string; dataResource: string },
): MenuRuleContribution {
    const semanticKey = permissionSemanticKey(effect, rule);
    const sourceId = createMenuSourceId({ grantId, semanticKey, ...provenance });
    return deepFreeze({
        sourceId,
        grantId,
        semanticKey,
        effect,
        action: rule.action,
        resource: rule.resource,
        ...(rule.where === undefined ? {} : { where: rule.where }),
        ...provenance,
    });
}

export function stableUniqueContributions(values: readonly MenuRuleContribution[]) {
    const bySourceId = new Map<string, MenuRuleContribution>();
    for (const value of values) bySourceId.set(value.sourceId, value);
    return [...bySourceId.values()].sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
}
