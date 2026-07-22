import type {
    ManagementConflict,
    MenuGrantIntent,
    MenuPermissionChoiceRequirement,
    MenuRuleContribution,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../persistence/documents";
import { RESPONSE_DETAIL_LIMIT } from "../rbac/result";
import { boundedDetails } from "../rbac/views";
import { createRoleMenuGrantSnapshotFromContributions } from "./source-rewrite";
import { validateMenuGraph } from "./queries";
import {
    MAX_MENU_MUTATIONS,
    choiceId,
    conflict,
    contribution,
    menuChoiceDecisionDetailCount,
    ownerType,
    permissionSemanticKey,
    selectedAssets,
    stableUniqueContributions,
    type PlannedRoleMenuGrant,
    type RoleMenuSelectionPlan,
    type SelectionPlanInput,
} from "./role-menu-selection-support";

export {
    menuChoiceDecisionDetailCount,
    type PlannedRoleMenuGrant,
    type RoleMenuSelectionPlan,
} from "./role-menu-selection-support";

type MenuGraph = ReturnType<typeof validateMenuGraph>;
type ApiOwnerRelation = InternalApiBindingDocument["owners"][number];

interface OwnedApiBinding {
    readonly binding: Readonly<InternalApiBindingDocument>;
    readonly relation: Readonly<ApiOwnerRelation>;
}

interface SelectionPlanningState {
    readonly grants: PlannedRoleMenuGrant[];
    readonly choiceRequirements: MenuPermissionChoiceRequirement[];
    readonly conflicts: ManagementConflict[];
    readonly globallyReachableBindingChoices: Set<string>;
    readonly globallyInactiveBindingChoices: Set<string>;
    readonly globallyReachablePermissionChoices: Map<string, Set<string>>;
}

interface AnchorPlanningState {
    readonly input: SelectionPlanInput;
    readonly anchorId: string;
    readonly grantId: string;
    readonly bindings: readonly Readonly<InternalApiBindingDocument>[];
    readonly contributions: MenuRuleContribution[];
    readonly reachableBindingChoices: Set<string>;
    readonly reachablePermissionChoices: Map<string, Set<string>>;
    readonly global: SelectionPlanningState;
}

interface PermissionCandidate {
    readonly semanticKey: string;
    readonly requirement: InternalApiBindingDocument["authorization"]["permissions"][number];
}

function createPlanningState(): SelectionPlanningState {
    return {
        grants: [],
        choiceRequirements: [],
        conflicts: [],
        globallyReachableBindingChoices: new Set<string>(),
        globallyInactiveBindingChoices: new Set<string>(),
        globallyReachablePermissionChoices: new Map<string, Set<string>>(),
    };
}

function grantIdForIntent(input: SelectionPlanInput, intent: MenuGrantIntent) {
    return `grant_${digestCanonical({
        scopeHash: input.scopeHash,
        roleId: input.roleId,
        effect: input.effect,
        intent,
    })}`;
}

function initialIntent(anchorId: string, selection: SelectionPlanInput["selection"]): MenuGrantIntent {
    return deepFreeze({
        anchorId,
        include: selection.include,
        apiChoices: { bindingIds: [], permissionsByBinding: {} },
    });
}

function addDirectAssetContributions(state: AnchorPlanningState, asset: Readonly<InternalMenuNodeDocument>) {
    if (asset.status !== "enabled") {
        state.global.conflicts.push(conflict(asset.nodeId, "MENU_ASSET_INACTIVE", "Disabled or deprecated menu assets cannot receive a new role grant."));
    }
    if (asset.permission !== undefined) {
        state.contributions.push(contribution(state.grantId, state.input.effect, asset.permission, {
            contribution: "node",
            assetId: asset.nodeId,
        }));
    }
    if (!state.input.selection.include.dataPermissions) return;
    for (const dataPermission of asset.dataPermissions ?? []) {
        state.contributions.push(contribution(state.grantId, state.input.effect, dataPermission, {
            contribution: "data",
            assetId: asset.nodeId,
            dataResource: dataPermission.resource,
        }));
    }
}

function ownedBindingsForAsset(
    asset: Readonly<InternalMenuNodeDocument>,
    bindings: readonly Readonly<InternalApiBindingDocument>[],
) {
    const type = ownerType(asset);
    if (type === null) return [];
    return bindings.flatMap((binding): OwnedApiBinding[] => {
        const relation = binding.owners.find((owner) => owner.type === type && owner.id === asset.nodeId);
        return relation === undefined ? [] : [{ binding, relation }];
    });
}

function collectDirectAndChoiceBindings(
    state: AnchorPlanningState,
    owned: readonly OwnedApiBinding[],
    selectedBindingIds: Set<string>,
) {
    const anyGroups = new Map<string, OwnedApiBinding[]>();
    for (const item of owned) {
        const { binding, relation } = item;
        if (state.input.selection.include.apis === "required" && !relation.required) continue;
        if (
            state.input.selection.include.apis === "required"
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
    return anyGroups;
}

function applyAvailabilityAnyGroup(
    state: AnchorPlanningState,
    asset: Readonly<InternalMenuNodeDocument>,
    availabilityGroup: string,
    candidates: readonly OwnedApiBinding[],
    selectedBindingIds: Set<string>,
) {
    for (const { binding } of candidates) {
        if (binding.status !== "enabled") state.global.globallyInactiveBindingChoices.add(binding.bindingId);
    }
    const enabledCandidates = candidates.filter(({ binding }) => binding.status === "enabled");
    for (const { binding } of enabledCandidates) {
        state.reachableBindingChoices.add(binding.bindingId);
        state.global.globallyReachableBindingChoices.add(binding.bindingId);
    }
    if (state.input.effect === "deny") {
        for (const { binding } of enabledCandidates) selectedBindingIds.add(binding.bindingId);
        return;
    }
    const selected = enabledCandidates
        .map(({ binding }) => binding.bindingId)
        .filter((bindingId) => state.input.selection.apiChoices.bindingIds.includes(bindingId))
        .sort(compareUtf8);
    for (const bindingId of selected) selectedBindingIds.add(bindingId);
    state.global.choiceRequirements.push(availabilityChoiceRequirement(state, asset, availabilityGroup, enabledCandidates, selected));
    if (selected.length === 0) {
        state.global.conflicts.push(conflict(`${state.anchorId}:${asset.nodeId}:${availabilityGroup}`, "MENU_API_CHOICE_REQUIRED", "An availability-any group requires at least one API binding choice."));
    }
}

function availabilityChoiceRequirement(
    state: AnchorPlanningState,
    asset: Readonly<InternalMenuNodeDocument>,
    availabilityGroup: string,
    candidates: readonly OwnedApiBinding[],
    selectedBindingIds: readonly string[],
): MenuPermissionChoiceRequirement {
    return deepFreeze({
        choiceId: choiceId({ kind: "availability-any", anchorId: state.anchorId, ownerAssetId: asset.nodeId, availabilityGroup }),
        kind: "availability-any" as const,
        anchorId: state.anchorId,
        ownerAssetId: asset.nodeId,
        availabilityGroup,
        candidates: boundedDetails(candidates.map(({ binding }) => ({
            bindingId: binding.bindingId,
            method: binding.method,
            path: binding.path,
            required: true as const,
        }))),
        selectedBindingIds: Object.freeze([...selectedBindingIds]),
        minSelections: 1 as const,
        resolved: selectedBindingIds.length > 0,
    });
}

function selectedBindingsForAsset(state: AnchorPlanningState, asset: Readonly<InternalMenuNodeDocument>) {
    const selectedBindingIds = new Set<string>();
    if (state.input.selection.include.apis === "none") return [];
    const owned = ownedBindingsForAsset(asset, state.bindings);
    const anyGroups = collectDirectAndChoiceBindings(state, owned, selectedBindingIds);
    for (const [availabilityGroup, candidates] of [...anyGroups].sort(([left], [right]) => compareUtf8(left, right))) {
        applyAvailabilityAnyGroup(state, asset, availabilityGroup, candidates, selectedBindingIds);
    }
    return [...selectedBindingIds].sort(compareUtf8);
}

function permissionCandidatesForBinding(input: SelectionPlanInput, binding: Readonly<InternalApiBindingDocument>) {
    return binding.authorization.permissions.map((permission) => ({
        semanticKey: permissionSemanticKey(input.effect, permission),
        requirement: permission,
    })).sort((left, right) => compareUtf8(left.semanticKey, right.semanticKey));
}

function selectedPermissionsForBinding(
    state: AnchorPlanningState,
    asset: Readonly<InternalMenuNodeDocument>,
    binding: Readonly<InternalApiBindingDocument>,
    candidates: readonly PermissionCandidate[],
) {
    if (binding.authorization.mode !== "any" || state.input.effect !== "allow") return candidates;
    const reachable = new Set(candidates.map((candidate) => candidate.semanticKey));
    state.reachablePermissionChoices.set(binding.bindingId, reachable);
    const globalReachable = state.global.globallyReachablePermissionChoices.get(binding.bindingId) ?? new Set<string>();
    for (const semanticKey of reachable) globalReachable.add(semanticKey);
    state.global.globallyReachablePermissionChoices.set(binding.bindingId, globalReachable);
    const requested = state.input.selection.apiChoices.permissionsByBinding[binding.bindingId] ?? [];
    const selected = candidates.filter((candidate) => requested.includes(candidate.semanticKey));
    state.global.choiceRequirements.push(authorizationChoiceRequirement(state, asset, binding, candidates, selected));
    if (selected.length === 0) {
        state.global.conflicts.push(conflict(`${state.anchorId}:${binding.bindingId}`, "MENU_API_PERMISSION_CHOICE_REQUIRED", "An authorization-any binding requires at least one permission choice."));
    }
    return selected;
}

function authorizationChoiceRequirement(
    state: AnchorPlanningState,
    asset: Readonly<InternalMenuNodeDocument>,
    binding: Readonly<InternalApiBindingDocument>,
    candidates: readonly PermissionCandidate[],
    selected: readonly PermissionCandidate[],
): MenuPermissionChoiceRequirement {
    return deepFreeze({
        choiceId: choiceId({ kind: "authorization-any", anchorId: state.anchorId, ownerAssetId: asset.nodeId, bindingId: binding.bindingId }),
        kind: "authorization-any" as const,
        anchorId: state.anchorId,
        ownerAssetId: asset.nodeId,
        bindingId: binding.bindingId,
        candidates: boundedDetails(candidates),
        selectedSemanticKeys: Object.freeze(selected.map((candidate) => candidate.semanticKey)),
        minSelections: 1 as const,
        resolved: selected.length > 0,
    });
}

function addApiBindingContributions(
    state: AnchorPlanningState,
    asset: Readonly<InternalMenuNodeDocument>,
    bindingId: string,
) {
    const binding = state.bindings.find((candidate) => candidate.bindingId === bindingId)!;
    if (binding.status !== "enabled") {
        state.global.conflicts.push(conflict(binding.bindingId, "API_BINDING_INACTIVE", "Disabled or deprecated API bindings cannot receive a new role grant."));
        return;
    }
    const permissionCandidates = permissionCandidatesForBinding(state.input, binding);
    const selectedPermissions = selectedPermissionsForBinding(state, asset, binding, permissionCandidates);
    for (const candidate of selectedPermissions) {
        state.contributions.push(contribution(state.grantId, state.input.effect, candidate.requirement, {
            contribution: "api",
            assetId: asset.nodeId,
            apiBindingId: bindingId,
        }));
    }
}

function canonicalIntentForAnchor(state: AnchorPlanningState, intent: MenuGrantIntent): MenuGrantIntent {
    const anchorBindingChoices = state.input.selection.apiChoices.bindingIds
        .filter((bindingId) => state.reachableBindingChoices.has(bindingId))
        .sort(compareUtf8);
    const permissionsByBinding: Record<string, readonly string[]> = {};
    for (const [bindingId, reachable] of [...state.reachablePermissionChoices].sort(([left], [right]) => compareUtf8(left, right))) {
        const selected = (state.input.selection.apiChoices.permissionsByBinding[bindingId] ?? [])
            .filter((semanticKey) => reachable.has(semanticKey))
            .sort(compareUtf8);
        if (selected.length > 0) permissionsByBinding[bindingId] = Object.freeze(selected);
    }
    return deepFreeze({
        ...intent,
        apiChoices: deepFreeze({
            bindingIds: Object.freeze(anchorBindingChoices),
            permissionsByBinding: deepFreeze(permissionsByBinding),
        }),
    });
}

function contributionProvenance(item: MenuRuleContribution) {
    if (item.contribution === "api") {
        return { contribution: "api" as const, assetId: item.assetId, apiBindingId: item.apiBindingId! };
    }
    if (item.contribution === "data") {
        return { contribution: "data" as const, assetId: item.assetId, dataResource: item.dataResource! };
    }
    return { contribution: "node" as const, assetId: item.assetId };
}

function canonicalContributionsForAnchor(
    state: AnchorPlanningState,
    canonicalGrantId: string,
) {
    return stableUniqueContributions(state.contributions.map((item) => {
        if (item.grantId === canonicalGrantId) return item;
        return contribution(canonicalGrantId, state.input.effect, item, contributionProvenance(item));
    }));
}

function planGrantForAnchor(
    input: SelectionPlanInput,
    graph: MenuGraph,
    bindings: readonly Readonly<InternalApiBindingDocument>[],
    global: SelectionPlanningState,
    anchorId: string,
) {
    const anchor = graph.nodes.get(anchorId);
    if (anchor === undefined) {
        throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${anchorId} was not found.`);
    }
    const intent = initialIntent(anchorId, input.selection);
    const state: AnchorPlanningState = {
        input,
        anchorId,
        grantId: grantIdForIntent(input, intent),
        bindings,
        contributions: [],
        reachableBindingChoices: new Set<string>(),
        reachablePermissionChoices: new Map<string, Set<string>>(),
        global,
    };
    for (const asset of selectedAssets(anchor, input.selection, graph.children)) {
        addDirectAssetContributions(state, asset);
        for (const bindingId of selectedBindingsForAsset(state, asset)) {
            addApiBindingContributions(state, asset, bindingId);
        }
    }
    pushCanonicalGrant(state, canonicalIntentForAnchor(state, intent));
}

function pushCanonicalGrant(state: AnchorPlanningState, canonicalIntent: MenuGrantIntent) {
    const canonicalGrantId = grantIdForIntent(state.input, canonicalIntent);
    const canonicalContributions = canonicalContributionsForAnchor(state, canonicalGrantId);
    if (canonicalContributions.length === 0) {
        state.global.conflicts.push(conflict(state.anchorId, "MENU_SELECTION_EMPTY", "The menu selection does not produce any permission contribution."));
        return;
    }
    state.global.grants.push(deepFreeze({
        grantId: canonicalGrantId,
        effect: state.input.effect,
        intent: canonicalIntent,
        snapshot: createRoleMenuGrantSnapshotFromContributions(canonicalIntent, canonicalContributions),
        contributions: Object.freeze(canonicalContributions),
    }));
}

function addUnreachableChoiceConflicts(input: SelectionPlanInput, state: SelectionPlanningState) {
    for (const bindingId of input.selection.apiChoices.bindingIds) {
        if (state.globallyInactiveBindingChoices.has(bindingId)) {
            state.conflicts.push(conflict(bindingId, "API_BINDING_INACTIVE", "Disabled or deprecated API bindings cannot receive a new role grant."));
        } else if (!state.globallyReachableBindingChoices.has(bindingId)) {
            state.conflicts.push(conflict(bindingId, "MENU_API_CHOICE_UNREACHABLE", "The selected API binding is not a reachable availability-any choice."));
        }
    }
    for (const [bindingId, semanticKeys] of Object.entries(input.selection.apiChoices.permissionsByBinding)) {
        const reachable = state.globallyReachablePermissionChoices.get(bindingId);
        for (const semanticKey of semanticKeys) {
            if (!reachable?.has(semanticKey)) {
                state.conflicts.push(conflict(`${bindingId}:${semanticKey}`, "MENU_API_PERMISSION_CHOICE_UNREACHABLE", "The selected API permission is not reachable from this selection."));
            }
        }
    }
}

function addSelectionLimitConflicts(state: SelectionPlanningState) {
    const sourceCount = state.grants.reduce((total, grant) => total + grant.contributions.length, 0);
    if (sourceCount > MAX_MENU_MUTATIONS) {
        state.conflicts.push(conflict("menu-source-mutation-limit", "LIMIT_EXCEEDED", `The selection produces ${sourceCount} sources; the atomic limit is ${MAX_MENU_MUTATIONS}.`));
    }
    const decisionDetails = menuChoiceDecisionDetailCount(state.choiceRequirements);
    if (decisionDetails > RESPONSE_DETAIL_LIMIT) {
        state.conflicts.push(conflict("menu-choice-detail-limit", "LIMIT_EXCEEDED", `The complete API choice set exceeds the shared ${RESPONSE_DETAIL_LIMIT}-item decision budget.`));
    }
}

function finalSelectionPlan(input: SelectionPlanInput, state: SelectionPlanningState): RoleMenuSelectionPlan {
    addUnreachableChoiceConflicts(input, state);
    addSelectionLimitConflicts(state);
    state.grants.sort((left, right) => compareUtf8(left.grantId, right.grantId));
    state.choiceRequirements.sort((left, right) => compareUtf8(left.choiceId, right.choiceId));
    state.conflicts.sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.id, right.id));
    return deepFreeze({
        grants: state.grants,
        choiceRequirements: state.choiceRequirements,
        conflicts: state.conflicts,
    });
}

export function planRoleMenuSelection(input: SelectionPlanInput): RoleMenuSelectionPlan {
    const graph = validateMenuGraph(input.nodes);
    const bindings = [...input.bindings].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
    const state = createPlanningState();
    for (const anchorId of input.selection.nodeIds) {
        planGrantForAnchor(input, graph, bindings, state, anchorId);
    }
    return finalSelectionPlan(input, state);
}
