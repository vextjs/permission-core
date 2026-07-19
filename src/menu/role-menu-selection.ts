import type {
    ManagementConflict,
    MenuGrantIntent,
    MenuPermissionChoiceRequirement,
    MenuPermissionSelection,
    MenuRuleContribution,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../persistence/documents";
import { createMenuSourceId, createSemanticKey } from "../rbac/materialize";
import { RESPONSE_DETAIL_LIMIT } from "../rbac/result";
import { boundedDetails } from "../rbac/views";
import { createRoleMenuGrantSnapshotFromContributions } from "./source-rewrite";
import { validateMenuGraph } from "./queries";

const MAX_MENU_MUTATIONS = 1_000;

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

interface SelectionPlanInput {
    readonly scopeHash: string;
    readonly roleId: string;
    readonly effect: "allow" | "deny";
    readonly selection: MenuPermissionSelection;
    readonly nodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly bindings: readonly Readonly<InternalApiBindingDocument>[];
}

function conflict(id: string, code: string, message: string): ManagementConflict {
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

function permissionSemanticKey(
    effect: "allow" | "deny",
    permission: { action: MenuRuleContribution["action"]; resource: string; where?: MenuRuleContribution["where"] },
) {
    return createSemanticKey(effect, permission.action, permission.resource, permission.where);
}

function selectedAssets(
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

function ownerType(node: Readonly<InternalMenuNodeDocument>) {
    return node.type === "menu" || node.type === "page" || node.type === "button"
        ? node.type
        : null;
}

function choiceId(value: unknown) {
    return `choice_${digestCanonical(value)}`;
}

function contribution(
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

function stableUniqueContributions(values: readonly MenuRuleContribution[]) {
    const bySourceId = new Map<string, MenuRuleContribution>();
    for (const value of values) bySourceId.set(value.sourceId, value);
    return [...bySourceId.values()].sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
}

export function planRoleMenuSelection(input: SelectionPlanInput): RoleMenuSelectionPlan {
    const graph = validateMenuGraph(input.nodes);
    const bindings = [...input.bindings].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
    const grants: PlannedRoleMenuGrant[] = [];
    const choiceRequirements: MenuPermissionChoiceRequirement[] = [];
    const conflicts: ManagementConflict[] = [];
    const globallyReachableBindingChoices = new Set<string>();
    const globallyInactiveBindingChoices = new Set<string>();
    const globallyReachablePermissionChoices = new Map<string, Set<string>>();

    for (const anchorId of input.selection.nodeIds) {
        const anchor = graph.nodes.get(anchorId);
        if (anchor === undefined) {
            throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${anchorId} was not found.`);
        }
        const intent: MenuGrantIntent = deepFreeze({
            anchorId,
            include: input.selection.include,
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        });
        const grantId = `grant_${digestCanonical({
            scopeHash: input.scopeHash,
            roleId: input.roleId,
            effect: input.effect,
            intent,
        })}`;
        const assets = selectedAssets(anchor, input.selection, graph.children);
        const contributions: MenuRuleContribution[] = [];
        const reachableBindingChoices = new Set<string>();
        const reachablePermissionChoices = new Map<string, Set<string>>();

        for (const asset of assets) {
            const selectedBindingIds = new Set<string>();
            if (asset.status !== "enabled") {
                conflicts.push(conflict(asset.nodeId, "MENU_ASSET_INACTIVE", "Disabled or deprecated menu assets cannot receive a new role grant."));
            }
            if (asset.permission !== undefined) {
                contributions.push(contribution(grantId, input.effect, asset.permission, {
                    contribution: "node",
                    assetId: asset.nodeId,
                }));
            }
            if (input.selection.include.dataPermissions) {
                for (const dataPermission of asset.dataPermissions ?? []) {
                    contributions.push(contribution(grantId, input.effect, dataPermission, {
                        contribution: "data",
                        assetId: asset.nodeId,
                        dataResource: dataPermission.resource,
                    }));
                }
            }

            if (input.selection.include.apis === "none") continue;
            const type = ownerType(asset);
            if (type === null) continue;
            const owned = bindings.flatMap((binding) => {
                const relation = binding.owners.find((owner) => owner.type === type && owner.id === asset.nodeId);
                return relation === undefined ? [] : [{ binding, relation }];
            });
            const anyGroups = new Map<string, typeof owned>();
            for (const item of owned) {
                const { binding, relation } = item;
                if (input.selection.include.apis === "required" && !relation.required) continue;
                if (
                    input.selection.include.apis === "required"
                    && relation.availabilityMode === "any"
                    && relation.availabilityGroup !== undefined
                ) {
                    const group = anyGroups.get(relation.availabilityGroup) ?? [];
                    group.push(item);
                    anyGroups.set(relation.availabilityGroup, group);
                    continue;
                }
                selectedBindingIds.add(binding.bindingId);
            }
            for (const [availabilityGroup, candidates] of [...anyGroups].sort(([left], [right]) => compareUtf8(left, right))) {
                for (const { binding } of candidates) {
                    if (binding.status !== "enabled") globallyInactiveBindingChoices.add(binding.bindingId);
                }
                const enabledCandidates = candidates.filter(({ binding }) => binding.status === "enabled");
                for (const { binding } of enabledCandidates) {
                    reachableBindingChoices.add(binding.bindingId);
                    globallyReachableBindingChoices.add(binding.bindingId);
                }
                if (input.effect === "deny") {
                    for (const { binding } of enabledCandidates) selectedBindingIds.add(binding.bindingId);
                    continue;
                }
                const selected = enabledCandidates
                    .map(({ binding }) => binding.bindingId)
                    .filter((bindingId) => input.selection.apiChoices.bindingIds.includes(bindingId))
                    .sort(compareUtf8);
                for (const bindingId of selected) selectedBindingIds.add(bindingId);
                choiceRequirements.push(deepFreeze({
                    choiceId: choiceId({ kind: "availability-any", anchorId, ownerAssetId: asset.nodeId, availabilityGroup }),
                    kind: "availability-any" as const,
                    anchorId,
                    ownerAssetId: asset.nodeId,
                    availabilityGroup,
                    candidates: boundedDetails(enabledCandidates.map(({ binding }) => ({
                        bindingId: binding.bindingId,
                        method: binding.method,
                        path: binding.path,
                        required: true as const,
                    }))),
                    selectedBindingIds: Object.freeze(selected),
                    minSelections: 1 as const,
                    resolved: selected.length > 0,
                }));
                if (selected.length === 0) {
                    conflicts.push(conflict(`${anchorId}:${asset.nodeId}:${availabilityGroup}`, "MENU_API_CHOICE_REQUIRED", "An availability-any group requires at least one API binding choice."));
                }
            }

            for (const bindingId of [...selectedBindingIds].sort(compareUtf8)) {
                const binding = bindings.find((candidate) => candidate.bindingId === bindingId)!;
                if (binding.status !== "enabled") {
                    conflicts.push(conflict(binding.bindingId, "API_BINDING_INACTIVE", "Disabled or deprecated API bindings cannot receive a new role grant."));
                    continue;
                }
                const permissionCandidates = binding.authorization.permissions.map((permission) => ({
                    semanticKey: permissionSemanticKey(input.effect, permission),
                    requirement: permission,
                })).sort((left, right) => compareUtf8(left.semanticKey, right.semanticKey));
                let selectedPermissions = permissionCandidates;
                if (binding.authorization.mode === "any" && input.effect === "allow") {
                    const reachable = new Set(permissionCandidates.map((candidate) => candidate.semanticKey));
                    reachablePermissionChoices.set(bindingId, reachable);
                    const globalReachable = globallyReachablePermissionChoices.get(bindingId) ?? new Set<string>();
                    for (const semanticKey of reachable) globalReachable.add(semanticKey);
                    globallyReachablePermissionChoices.set(bindingId, globalReachable);
                    const requested = input.selection.apiChoices.permissionsByBinding[bindingId] ?? [];
                    selectedPermissions = permissionCandidates.filter((candidate) => requested.includes(candidate.semanticKey));
                    choiceRequirements.push(deepFreeze({
                        choiceId: choiceId({ kind: "authorization-any", anchorId, ownerAssetId: asset.nodeId, bindingId }),
                        kind: "authorization-any" as const,
                        anchorId,
                        ownerAssetId: asset.nodeId,
                        bindingId,
                        candidates: boundedDetails(permissionCandidates),
                        selectedSemanticKeys: Object.freeze(selectedPermissions.map((candidate) => candidate.semanticKey)),
                        minSelections: 1 as const,
                        resolved: selectedPermissions.length > 0,
                    }));
                    if (selectedPermissions.length === 0) {
                        conflicts.push(conflict(`${anchorId}:${bindingId}`, "MENU_API_PERMISSION_CHOICE_REQUIRED", "An authorization-any binding requires at least one permission choice."));
                    }
                }
                for (const candidate of selectedPermissions) {
                    contributions.push(contribution(grantId, input.effect, candidate.requirement, {
                        contribution: "api",
                        assetId: asset.nodeId,
                        apiBindingId: bindingId,
                    }));
                }
            }
        }

        const anchorBindingChoices = input.selection.apiChoices.bindingIds
            .filter((bindingId) => reachableBindingChoices.has(bindingId))
            .sort(compareUtf8);
        const permissionsByBinding: Record<string, readonly string[]> = {};
        for (const [bindingId, reachable] of [...reachablePermissionChoices].sort(([left], [right]) => compareUtf8(left, right))) {
            const selected = (input.selection.apiChoices.permissionsByBinding[bindingId] ?? [])
                .filter((semanticKey) => reachable.has(semanticKey))
                .sort(compareUtf8);
            if (selected.length > 0) permissionsByBinding[bindingId] = Object.freeze(selected);
        }
        const canonicalIntent: MenuGrantIntent = deepFreeze({
            ...intent,
            apiChoices: deepFreeze({
                bindingIds: Object.freeze(anchorBindingChoices),
                permissionsByBinding: deepFreeze(permissionsByBinding),
            }),
        });
        const canonicalGrantId = `grant_${digestCanonical({
            scopeHash: input.scopeHash,
            roleId: input.roleId,
            effect: input.effect,
            intent: canonicalIntent,
        })}`;
        const canonicalContributions = stableUniqueContributions(contributions.map((item) => {
            if (item.grantId === canonicalGrantId) return item;
            const provenance = item.contribution === "api"
                ? { contribution: "api" as const, assetId: item.assetId, apiBindingId: item.apiBindingId! }
                : item.contribution === "data"
                    ? { contribution: "data" as const, assetId: item.assetId, dataResource: item.dataResource! }
                    : { contribution: "node" as const, assetId: item.assetId };
            return contribution(canonicalGrantId, input.effect, item, provenance);
        }));
        if (canonicalContributions.length === 0) {
            conflicts.push(conflict(anchorId, "MENU_SELECTION_EMPTY", "The menu selection does not produce any permission contribution."));
            continue;
        }
        grants.push(deepFreeze({
            grantId: canonicalGrantId,
            effect: input.effect,
            intent: canonicalIntent,
            snapshot: createRoleMenuGrantSnapshotFromContributions(canonicalIntent, canonicalContributions),
            contributions: Object.freeze(canonicalContributions),
        }));
    }

    for (const bindingId of input.selection.apiChoices.bindingIds) {
        if (globallyInactiveBindingChoices.has(bindingId)) {
            conflicts.push(conflict(bindingId, "API_BINDING_INACTIVE", "Disabled or deprecated API bindings cannot receive a new role grant."));
        } else if (!globallyReachableBindingChoices.has(bindingId)) {
            conflicts.push(conflict(bindingId, "MENU_API_CHOICE_UNREACHABLE", "The selected API binding is not a reachable availability-any choice."));
        }
    }
    for (const [bindingId, semanticKeys] of Object.entries(input.selection.apiChoices.permissionsByBinding)) {
        const reachable = globallyReachablePermissionChoices.get(bindingId);
        for (const semanticKey of semanticKeys) {
            if (!reachable?.has(semanticKey)) {
                conflicts.push(conflict(`${bindingId}:${semanticKey}`, "MENU_API_PERMISSION_CHOICE_UNREACHABLE", "The selected API permission is not reachable from this selection."));
            }
        }
    }
    const sourceCount = grants.reduce((total, grant) => total + grant.contributions.length, 0);
    if (sourceCount > MAX_MENU_MUTATIONS) {
        conflicts.push(conflict("menu-source-mutation-limit", "LIMIT_EXCEEDED", `The selection produces ${sourceCount} sources; the atomic limit is ${MAX_MENU_MUTATIONS}.`));
    }
    const decisionDetails = menuChoiceDecisionDetailCount(choiceRequirements);
    if (decisionDetails > RESPONSE_DETAIL_LIMIT) {
        conflicts.push(conflict("menu-choice-detail-limit", "LIMIT_EXCEEDED", `The complete API choice set exceeds the shared ${RESPONSE_DETAIL_LIMIT}-item decision budget.`));
    }
    grants.sort((left, right) => compareUtf8(left.grantId, right.grantId));
    choiceRequirements.sort((left, right) => compareUtf8(left.choiceId, right.choiceId));
    conflicts.sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.id, right.id));
    return deepFreeze({ grants, choiceRequirements, conflicts });
}
