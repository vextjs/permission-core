import type {
    DirectMenuGrantSnapshot,
    MenuRuleContribution,
    MenuRuleSourceState,
    RuleSourceView,
    StaleMenuPermissionSource,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalString, compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
    InternalRoleDocument,
    InternalRoleMenuGrantDocument,
    InternalRoleRuleDocument,
    InternalRoleRuleSource,
} from "../persistence/documents";
import type { PermissionRepository } from "../persistence/repository";
import { DetailBudgetAllocator } from "../rbac/result";
import { completeDetails } from "../rbac/views";
import type {
    RbacAuthorizationResolver,
    RbacScopeReader,
    ResolvedAuthorizationRules,
} from "../rbac/store";
import { planRoleMenuSelection, type PlannedRoleMenuGrant } from "./role-menu-selection";
import { validateRoleMenuIntegrity } from "./source-rewrite";
import { MenuScopeReader } from "./store";

type MenuSource = Extract<InternalRoleRuleSource, { kind: "menu" }>;
type MenuSourceView = Extract<RuleSourceView, { kind: "menu" }>;
type MenuSourceReason = NonNullable<MenuSourceView["stateReason"]>;

export interface RoleMenuInventoryView {
    readonly nodesById: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
    readonly bindingsById: ReadonlyMap<string, Readonly<InternalApiBindingDocument>>;
    readonly completeNodes?: readonly Readonly<InternalMenuNodeDocument>[];
    readonly completeBindings?: readonly Readonly<InternalApiBindingDocument>[];
}

export interface ResolvedRoleMenuGrant {
    readonly document: Readonly<InternalRoleMenuGrantDocument>;
    readonly contributions: readonly MenuRuleContribution[];
    readonly sourceStates: readonly {
        readonly sourceId: string;
        readonly state: MenuRuleSourceState;
        readonly reason?: MenuSourceReason;
    }[];
    readonly sourceStatus: DirectMenuGrantSnapshot["sourceStatus"];
    readonly stateReasons: readonly string[];
    readonly planned: PlannedRoleMenuGrant | null;
}

export interface RoleMenuRoleResolution {
    readonly roleId: string;
    readonly grants: readonly ResolvedRoleMenuGrant[];
    readonly activeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly sourceViews: ReadonlyMap<string, MenuSourceView>;
    readonly stale: readonly StaleMenuPermissionSource[];
}

function authorizationSnapshotInvalid(reason: string): never {
    throw new PermissionCoreError(
        "PERSISTED_STATE_INVALID",
        "The authorization snapshot has invalid menu provenance.",
        {
            details: {
                kind: "persisted-state-invalid",
                stage: "load",
                reason: `authorization-snapshot-integrity:${reason}`,
            },
        },
    );
}

function menuContribution(
    rule: Readonly<InternalRoleRuleDocument>,
    source: Readonly<MenuSource>,
): MenuRuleContribution {
    return deepFreeze({
        sourceId: source.sourceId,
        grantId: source.grantId,
        semanticKey: rule.semanticKey,
        effect: rule.effect,
        action: rule.action,
        resource: rule.resource,
        ...(rule.where === undefined ? {} : { where: rule.where }),
        contribution: source.contribution,
        assetId: source.assetId,
        ...(source.contribution === "api" ? { apiBindingId: source.apiBindingId } : {}),
        ...(source.contribution === "data" ? { dataResource: source.dataResource } : {}),
    });
}

function provenanceMatches(
    left: Readonly<MenuRuleContribution>,
    right: Readonly<MenuRuleContribution>,
) {
    return left.contribution === right.contribution
        && left.assetId === right.assetId
        && left.apiBindingId === right.apiBindingId
        && left.dataResource === right.dataResource;
}

function contributionMatches(
    left: Readonly<MenuRuleContribution>,
    right: Readonly<MenuRuleContribution>,
) {
    return provenanceMatches(left, right)
        && left.effect === right.effect
        && left.action === right.action
        && left.resource === right.resource
        && canonicalString(left.where ?? null) === canonicalString(right.where ?? null);
}

function neutralizeAvailability<T extends { readonly status: "enabled" | "disabled" | "deprecated" }>(
    values: readonly Readonly<T>[],
) {
    return values.map((value) => value.status === "enabled"
        ? value
        : ({ ...value, status: "enabled" } as Readonly<T>));
}

function currentGrantPlan(
    role: Readonly<InternalRoleDocument>,
    grant: Readonly<InternalRoleMenuGrantDocument>,
    inventory: RoleMenuInventoryView,
) {
    if (inventory.completeNodes === undefined || inventory.completeBindings === undefined) return null;
    try {
        const planned = planRoleMenuSelection({
            scopeHash: role.scopeKey,
            roleId: role.roleId,
            effect: grant.effect,
            selection: {
                nodeIds: [grant.intent.anchorId],
                include: grant.intent.include,
                apiChoices: grant.intent.apiChoices,
            },
            nodes: neutralizeAvailability(inventory.completeNodes),
            bindings: neutralizeAvailability(inventory.completeBindings),
        });
        return planned.grants.find((candidate) => candidate.grantId === grant.grantId)
            ?? planned.grants.find((candidate) => candidate.intent.anchorId === grant.intent.anchorId)
            ?? null;
    } catch (error) {
        if (error instanceof PermissionCoreError && error.code === "MENU_NOT_FOUND") return null;
        throw error;
    }
}

function sourceReferenceState(
    source: Readonly<MenuSource>,
    inventory: RoleMenuInventoryView,
) {
    const node = inventory.nodesById.get(source.assetId);
    if (node === undefined) {
        return {
            integrity: "invalid" as const,
            availability: "inactive" as const,
            reason: "reference-missing" as const,
            staleReason: "asset-missing" as const,
        };
    }
    if (source.contribution === "api") {
        const binding = inventory.bindingsById.get(source.apiBindingId);
        if (binding === undefined) {
            return {
                integrity: "invalid" as const,
                availability: "inactive" as const,
                reason: "reference-missing" as const,
                staleReason: "binding-missing" as const,
            };
        }
        if (node.status !== "enabled") {
            return {
                integrity: "valid" as const,
                availability: "inactive" as const,
                reason: node.status === "disabled" ? "asset-disabled" as const : "asset-deprecated" as const,
            };
        }
        if (binding.status !== "enabled") {
            return {
                integrity: "valid" as const,
                availability: "inactive" as const,
                reason: binding.status === "disabled" ? "binding-disabled" as const : "binding-deprecated" as const,
            };
        }
        return { integrity: "valid" as const, availability: "active" as const };
    }
    if (node.status !== "enabled") {
        return {
            integrity: "valid" as const,
            availability: "inactive" as const,
            reason: node.status === "disabled" ? "asset-disabled" as const : "asset-deprecated" as const,
        };
    }
    return { integrity: "valid" as const, availability: "active" as const };
}

function activeRule(
    rule: Readonly<InternalRoleRuleDocument>,
    sourceViews: ReadonlyMap<string, MenuSourceView>,
) {
    const sources = rule.sources.filter((source) => {
        if (source.kind === "manual") return true;
        const view = sourceViews.get(source.sourceId);
        return view?.state.integrity === "valid" && view.state.availability === "active";
    });
    if (sources.length === 0) return null;
    if (sources.length === rule.sources.length) return rule;
    return deepFreeze({ ...rule, sources: Object.freeze(sources) });
}

export function resolveRoleMenuRole(input: {
    readonly role: Readonly<InternalRoleDocument>;
    readonly rules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly grants: readonly Readonly<InternalRoleMenuGrantDocument>[];
    readonly inventory: RoleMenuInventoryView;
    readonly failOnInvalidReference: boolean;
}): RoleMenuRoleResolution {
    validateRoleMenuIntegrity(input.role, input.rules, input.grants);
    const contributionsByGrant = new Map<string, MenuRuleContribution[]>();
    const menuSourcesById = new Map<string, MenuSource>();
    for (const rule of input.rules) {
        for (const source of rule.sources) {
            if (source.kind !== "menu") continue;
            menuSourcesById.set(source.sourceId, source);
            const group = contributionsByGrant.get(source.grantId) ?? [];
            group.push(menuContribution(rule, source));
            contributionsByGrant.set(source.grantId, group);
        }
    }
    for (const contributions of contributionsByGrant.values()) {
        contributions.sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
    }

    const sourceViews = new Map<string, MenuSourceView>();
    const stale: StaleMenuPermissionSource[] = [];
    const grants: ResolvedRoleMenuGrant[] = [];

    for (const grant of [...input.grants].sort((left, right) => compareUtf8(left.grantId, right.grantId))) {
        const contributions = Object.freeze(contributionsByGrant.get(grant.grantId) ?? []);
        const planned = currentGrantPlan(input.role, grant, input.inventory);
        const plannedContributions = planned?.contributions ?? [];
        const grantDrift = planned !== null
            && canonicalString(planned.snapshot.contributionContractDigest)
                !== canonicalString(grant.snapshot.contributionContractDigest)
            ? "refresh-available" as const
            : planned === null && input.inventory.completeNodes !== undefined
                ? "refresh-available" as const
                : "current" as const;
        const sourceStates: ResolvedRoleMenuGrant["sourceStates"][number][] = [];
        const reasons = new Set<string>();

        for (const contribution of contributions) {
            const source = menuSourcesById.get(contribution.sourceId)!;
            const reference = sourceReferenceState(source, input.inventory);
            const exact = plannedContributions.some((candidate) => contributionMatches(contribution, candidate));
            const drift = grantDrift === "refresh-available" || !exact
                ? "refresh-available" as const
                : "current" as const;
            const reason: MenuSourceReason | undefined = reference.reason
                ?? (drift === "refresh-available" ? "contribution-refresh-available" : undefined);
            const state: MenuRuleSourceState = deepFreeze({
                integrity: reference.integrity,
                availability: reference.availability,
                drift,
            });
            if (reason !== undefined) reasons.add(reason);
            sourceStates.push(deepFreeze({
                sourceId: source.sourceId,
                state,
                ...(reason === undefined ? {} : { reason }),
            }));
            sourceViews.set(source.sourceId, deepFreeze({
                kind: "menu",
                grantId: source.grantId,
                grantRevision: source.grantRevision,
                sourceId: source.sourceId,
                effect: source.effect,
                contribution: source.contribution,
                assetId: source.assetId,
                ...(source.contribution === "api" ? { apiBindingId: source.apiBindingId } : {}),
                ...(source.contribution === "data" ? { dataResource: source.dataResource } : {}),
                state,
                ...(reason === undefined ? {} : { stateReason: reason }),
            }) as MenuSourceView);

            if (reference.staleReason !== undefined) {
                stale.push(deepFreeze({
                    roleId: input.role.roleId,
                    grantId: grant.grantId,
                    sourceId: source.sourceId,
                    reason: reference.staleReason,
                }));
            } else if (planned !== null && !exact) {
                const sameProvenance = plannedContributions.some((candidate) => provenanceMatches(contribution, candidate));
                stale.push(deepFreeze({
                    roleId: input.role.roleId,
                    grantId: grant.grantId,
                    sourceId: source.sourceId,
                    reason: sameProvenance ? "permission-changed" : "selection-drift",
                }));
            }
        }

        const invalid = sourceStates.some((entry) => entry.state.integrity === "invalid");
        if (invalid && input.failOnInvalidReference) {
            authorizationSnapshotInvalid(`role:${input.role.roleId}:grant:${grant.grantId}:reference-missing`);
        }
        const activeCount = sourceStates.filter((entry) => entry.state.availability === "active").length;
        const availability = activeCount === 0
            ? "inactive" as const
            : activeCount === sourceStates.length
                ? "active" as const
                : "partially-active" as const;
        grants.push(deepFreeze({
            document: grant,
            contributions,
            sourceStates: Object.freeze(sourceStates),
            sourceStatus: deepFreeze({
                integrity: invalid ? "invalid" as const : "valid" as const,
                availability,
                drift: grantDrift,
            }),
            stateReasons: Object.freeze([...reasons].sort(compareUtf8)),
            planned,
        }));
    }

    const activeRules = input.rules.flatMap((rule) => {
        const filtered = activeRule(rule, sourceViews);
        return filtered === null ? [] : [filtered];
    });
    stale.sort((left, right) => compareUtf8(left.roleId, right.roleId)
        || compareUtf8(left.grantId, right.grantId)
        || compareUtf8(left.sourceId, right.sourceId));
    return deepFreeze({
        roleId: input.role.roleId,
        grants: Object.freeze(grants),
        activeRules: Object.freeze(activeRules),
        sourceViews,
        stale: Object.freeze(stale),
    });
}

export function completeDirectMenuGrant(value: ResolvedRoleMenuGrant): DirectMenuGrantSnapshot {
    return deepFreeze({
        grantId: value.document.grantId,
        revision: value.document.grantRevision,
        effect: value.document.effect,
        intent: value.document.intent,
        snapshot: deepFreeze({
            ...value.document.snapshot,
            contributingAssetIds: completeDetails(value.document.snapshot.contributingAssetIds),
            contributingBindingIds: completeDetails(value.document.snapshot.contributingBindingIds),
        }),
        contributions: completeDetails(value.contributions),
        sourceStatus: value.sourceStatus,
        sourceStates: completeDetails(value.sourceStates),
        stateReasons: completeDetails(value.stateReasons),
    });
}

export function publicDirectMenuGrant(
    value: ResolvedRoleMenuGrant,
    budget: DetailBudgetAllocator,
): DirectMenuGrantSnapshot {
    const complete = completeDirectMenuGrant(value);
    return deepFreeze({
        ...complete,
        snapshot: deepFreeze({
            ...complete.snapshot,
            contributingAssetIds: budget.bounded(complete.snapshot.contributingAssetIds.items),
            contributingBindingIds: budget.bounded(complete.snapshot.contributingBindingIds.items),
        }),
        contributions: budget.bounded(complete.contributions.items),
        sourceStates: budget.bounded(complete.sourceStates.items),
        stateReasons: budget.bounded(complete.stateReasons.items),
    });
}

export class RoleMenuAuthorizationResolver implements RbacAuthorizationResolver {
    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
    ) {}

    resolveAuthorization(
        reader: RbacScopeReader,
        roleIds: readonly string[],
        rules: readonly Readonly<InternalRoleRuleDocument>[],
    ) {
        return this.resolve(reader, roleIds, rules, false, true);
    }

    resolveManagement(
        reader: RbacScopeReader,
        roleIds: readonly string[],
        rules: readonly Readonly<InternalRoleRuleDocument>[],
    ) {
        return this.resolve(reader, roleIds, rules, true, false);
    }

    private async resolve(
        reader: RbacScopeReader,
        roleIds: readonly string[],
        rules: readonly Readonly<InternalRoleRuleDocument>[],
        includeDrift: boolean,
        failOnInvalidReference: boolean,
    ): Promise<ResolvedAuthorizationRules> {
        if (roleIds.length === 0) {
            return Object.freeze({ rules: Object.freeze([]), sourceViews: new Map<string, RuleSourceView>() });
        }
        const menuReader = new MenuScopeReader(
            this.repository,
            this.schemes,
            reader.state,
            reader.databaseSession(),
        );
        const [rolesById, grants] = await Promise.all([
            reader.readRoles(roleIds),
            menuReader.readGrantsForRoles(roleIds),
        ]);
        const menuSources = rules.flatMap((rule) => rule.sources.flatMap((source) => (
            source.kind === "menu" ? [source] : []
        )));
        let inventory: RoleMenuInventoryView;
        if (includeDrift) {
            const complete = await menuReader.readCompleteInventory();
            inventory = {
                nodesById: new Map(complete.nodes.map((node) => [node.nodeId, node] as const)),
                bindingsById: new Map(complete.bindings.map((binding) => [binding.bindingId, binding] as const)),
                completeNodes: complete.nodes,
                completeBindings: complete.bindings,
            };
        } else {
            const nodeIds = [...new Set(menuSources.map((source) => source.assetId))];
            const bindingIds = [...new Set(menuSources.flatMap((source) => (
                source.contribution === "api" ? [source.apiBindingId] : []
            )))];
            const [nodesById, bindingsById] = await Promise.all([
                menuReader.readNodesByIds(nodeIds),
                menuReader.readBindingsByIds(bindingIds),
            ]);
            inventory = { nodesById, bindingsById };
        }

        const rulesByRole = new Map(roleIds.map((roleId) => [roleId, [] as Readonly<InternalRoleRuleDocument>[]]));
        for (const rule of rules) rulesByRole.get(rule.roleId)?.push(rule);
        const grantsByRole = new Map(roleIds.map((roleId) => [roleId, [] as Readonly<InternalRoleMenuGrantDocument>[]]));
        for (const grant of grants) grantsByRole.get(grant.roleId)?.push(grant);
        const activeRules: Readonly<InternalRoleRuleDocument>[] = [];
        const sourceViews = new Map<string, RuleSourceView>();
        for (const roleId of roleIds) {
            const role = rolesById.get(roleId);
            if (role === undefined) authorizationSnapshotInvalid(`role:${roleId}:missing`);
            const resolution = resolveRoleMenuRole({
                role,
                rules: rulesByRole.get(roleId) ?? [],
                grants: grantsByRole.get(roleId) ?? [],
                inventory,
                failOnInvalidReference,
            });
            activeRules.push(...resolution.activeRules);
            for (const [sourceId, view] of resolution.sourceViews) {
                if (sourceViews.has(sourceId)) authorizationSnapshotInvalid(`source:${sourceId}:duplicate`);
                sourceViews.set(sourceId, view);
            }
        }
        await menuReader.verifyMenuAuthorizationUnchanged();
        return Object.freeze({
            rules: Object.freeze(activeRules),
            sourceViews,
        });
    }
}
