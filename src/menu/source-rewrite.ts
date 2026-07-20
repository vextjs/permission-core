import type { MongoSession } from "monsqlize";
import type {
    EntityStatus,
    ManagementConflict,
    MenuGrantIntent,
    MenuRuleContribution,
    PermissionRuleInput,
    SourceRewriteDecision,
    SourceRewriteImpact,
} from "../types";
import type { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import {
    assertInternalDocumentBudget,
    assertRoleMenuGrantBudget,
    type InternalRoleMenuGrantDocument,
    type InternalApiBindingDocument,
    type InternalMenuNodeDocument,
    type InternalRoleDocument,
    type InternalRoleRuleDocument,
    type InternalRoleRuleSource,
} from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import {
    createMenuSourceId,
    createSemanticKey,
    materializeRoleDocument,
    materializeRoleRuleDocument,
} from "../rbac/materialize";
import type { EffectiveAuthorizationReader } from "../rbac/effective";
import { RESPONSE_DETAIL_LIMIT, type DetailBudgetAllocator } from "../rbac/result";
import type { RbacScopeReader } from "../rbac/store";
import { boundedDetails } from "../rbac/views";
import { materializeRoleMenuGrantDocument } from "./materialize";
import type { PreparedSourceRewriteExecution } from "./source-rewrite-plan";
import type { MenuScopeReader } from "./store";

const MAX_DISCOVERED_MENU_SOURCES = 50_000;
export const MAX_SOURCE_REWRITE_OPERATIONS = 1_000;

export type MenuSource = Extract<InternalRoleRuleSource, { kind: "menu" }>;

export interface MenuAvailabilityOverrides {
    readonly nodes?: ReadonlyMap<string, EntityStatus>;
    readonly bindings?: ReadonlyMap<string, EntityStatus>;
    readonly rules?: ReadonlyMap<string, readonly Readonly<InternalRoleRuleDocument>[]>;
}

interface MenuAvailabilityReaderInput {
    readonly rbacReader: RbacScopeReader;
    readonly menuReader: MenuScopeReader;
    readonly before?: MenuAvailabilityOverrides;
    readonly after?: MenuAvailabilityOverrides;
}

export function createMenuAvailabilityReaders(input: MenuAvailabilityReaderInput) {
    const roles = new Map<string, Readonly<InternalRoleDocument> | null>();
    const rawRulesByRoleId = new Map<string, readonly Readonly<InternalRoleRuleDocument>[]>();
    const nodes = new Map<string, Readonly<InternalMenuNodeDocument> | null>();
    const bindings = new Map<string, Readonly<InternalApiBindingDocument> | null>();

    const readRoles = async (roleIds: readonly string[]) => {
        const normalized = [...new Set(roleIds)].sort(compareUtf8);
        const missing = normalized.filter((roleId) => !roles.has(roleId));
        if (missing.length > 0) {
            const loaded = await input.rbacReader.readRoles(missing);
            for (const roleId of missing) roles.set(roleId, loaded.get(roleId) ?? null);
        }
        return new Map(normalized.flatMap((roleId) => {
            const role = roles.get(roleId);
            return role === null || role === undefined ? [] : [[roleId, role] as const];
        }));
    };

    const loadRawRules = async (roleIds: readonly string[]) => {
        const normalized = [...new Set(roleIds)].sort(compareUtf8);
        const missing = normalized.filter((roleId) => !rawRulesByRoleId.has(roleId));
        if (missing.length > 0) {
            const loaded = await input.rbacReader.readRulesForRoles(missing);
            const grouped = new Map(missing.map((roleId) => [roleId, [] as Readonly<InternalRoleRuleDocument>[]]));
            for (const rule of loaded) grouped.get(rule.roleId)?.push(rule);
            for (const roleId of missing) {
                rawRulesByRoleId.set(roleId, Object.freeze(grouped.get(roleId) ?? []));
            }
        }
        return normalized.flatMap((roleId) => rawRulesByRoleId.get(roleId) ?? []);
    };

    const loadAssets = async (rules: readonly Readonly<InternalRoleRuleDocument>[]) => {
        const nodeIds = new Set<string>();
        const bindingIds = new Set<string>();
        for (const rule of rules) {
            for (const source of rule.sources) {
                if (source.kind !== "menu") continue;
                nodeIds.add(source.assetId);
                if (source.contribution === "api") bindingIds.add(source.apiBindingId);
            }
        }
        const missingNodeIds = [...nodeIds].filter((nodeId) => !nodes.has(nodeId)).sort(compareUtf8);
        if (missingNodeIds.length > 0) {
            const loaded = await input.menuReader.readNodesByIds(missingNodeIds);
            for (const nodeId of missingNodeIds) nodes.set(nodeId, loaded.get(nodeId) ?? null);
        }
        const missingBindingIds = [...bindingIds].filter((bindingId) => !bindings.has(bindingId)).sort(compareUtf8);
        if (missingBindingIds.length > 0) {
            const loaded = await input.menuReader.readBindingsByIds(missingBindingIds);
            for (const bindingId of missingBindingIds) bindings.set(bindingId, loaded.get(bindingId) ?? null);
        }
    };

    const createReader = (overrides: MenuAvailabilityOverrides = {}): EffectiveAuthorizationReader => {
        const nodeOverrides = new Map(overrides.nodes ?? []);
        const bindingOverrides = new Map(overrides.bindings ?? []);
        const ruleOverrides = new Map([...overrides.rules ?? []].map(([roleId, rules]) => [
            roleId,
            Object.freeze([...rules]),
        ] as const));
        const filteredByRoleId = new Map<string, readonly Readonly<InternalRoleRuleDocument>[]>();
        return {
            readRoles,
            async readRulesForRoles(roleIds) {
                const normalized = [...new Set(roleIds)].sort(compareUtf8);
                const missing = normalized.filter((roleId) => !filteredByRoleId.has(roleId));
                if (missing.length > 0) {
                    const persistedRoleIds = missing.filter((roleId) => !ruleOverrides.has(roleId));
                    const persistedRules = await loadRawRules(persistedRoleIds);
                    const rawRules = [
                        ...persistedRules,
                        ...missing.flatMap((roleId) => ruleOverrides.get(roleId) ?? []),
                    ];
                    await loadAssets(rawRules);
                    const grouped = new Map(missing.map((roleId) => [roleId, [] as Readonly<InternalRoleRuleDocument>[]]));
                    for (const rule of rawRules) {
                        const activeSources = rule.sources.filter((source) => {
                            if (source.kind === "manual") return true;
                            const node = nodes.get(source.assetId);
                            if (node === null || node === undefined) {
                                persistedInvalid(`menu source ${source.sourceId} references missing node ${source.assetId}`);
                            }
                            const nodeStatus = nodeOverrides.get(source.assetId) ?? node.status;
                            if (nodeStatus !== "enabled") return false;
                            if (source.contribution !== "api") return true;
                            const binding = bindings.get(source.apiBindingId);
                            if (binding === null || binding === undefined) {
                                persistedInvalid(`menu source ${source.sourceId} references missing API binding ${source.apiBindingId}`);
                            }
                            if (!binding.owners.some((owner) => owner.id === source.assetId)) {
                                persistedInvalid(`menu source ${source.sourceId} has a mismatched API binding owner`);
                            }
                            return (bindingOverrides.get(source.apiBindingId) ?? binding.status) === "enabled";
                        });
                        if (activeSources.length === 0) continue;
                        const activeRule = activeSources.length === rule.sources.length
                            ? rule
                            : deepFreeze({ ...rule, sources: activeSources });
                        grouped.get(rule.roleId)?.push(activeRule);
                    }
                    for (const roleId of missing) {
                        filteredByRoleId.set(roleId, Object.freeze(grouped.get(roleId) ?? []));
                    }
                }
                return Object.freeze(normalized.flatMap((roleId) => filteredByRoleId.get(roleId) ?? []));
            },
        };
    };

    return deepFreeze({
        before: createReader(input.before),
        after: createReader(input.after),
    });
}

export interface MenuSourceRecord {
    readonly rule: Readonly<InternalRoleRuleDocument>;
    readonly source: Readonly<MenuSource>;
}

export interface PreparedSourceImpact {
    readonly public: SourceRewriteImpact;
    readonly record: MenuSourceRecord;
    readonly candidates: ReadonlyMap<string, Readonly<PermissionRuleInput>>;
}

function readOptions(session: MongoSession) {
    return { session, cache: 0, collation: SIMPLE_COLLATION };
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu source state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

export async function loadMenuSourceRecords(input: {
    readonly repository: PermissionRepository;
    readonly schemes: ResourceSchemeRegistry;
    readonly reader: MenuScopeReader;
    readonly session: MongoSession;
    readonly mongoFilter: Readonly<Record<string, unknown>>;
    matches(source: Readonly<MenuSource>): boolean;
}) {
    const records: MenuSourceRecord[] = [];
    let after: { roleId: string; semanticKey: string } | undefined;
    const pageSize = Math.min(200, input.repository.findMaxLimit);
    while (records.length <= MAX_DISCOVERED_MENU_SOURCES) {
        const base = { scopeKey: input.reader.state.scopeKey, ...input.mongoFilter };
        const filter = after === undefined
            ? base
            : {
                $and: [
                    base,
                    {
                        $or: [
                            { roleId: { $gt: after.roleId } },
                            { roleId: after.roleId, semanticKey: { $gt: after.semanticKey } },
                        ],
                    },
                ],
            };
        const rows = await input.repository.collections.roleRules.find(filter, readOptions(input.session))
            .sort({ roleId: 1, semanticKey: 1 })
            .limit(pageSize)
            .toArray();
        if (rows.length === 0) break;
        for (const row of rows) {
            const rule = materializeRoleRuleDocument(
                row,
                input.reader.state.scope,
                input.reader.state.scopeKey,
                input.schemes,
            );
            if (
                after !== undefined
                && (
                    compareUtf8(rule.roleId, after.roleId) < 0
                    || (rule.roleId === after.roleId && compareUtf8(rule.semanticKey, after.semanticKey) <= 0)
                )
            ) {
                persistedInvalid("menu source keyset did not advance");
            }
            after = { roleId: rule.roleId, semanticKey: rule.semanticKey };
            for (const source of rule.sources) {
                if (source.kind === "menu" && input.matches(source)) {
                    records.push(Object.freeze({ rule, source }));
                    if (records.length > MAX_DISCOVERED_MENU_SOURCES) {
                        persistedInvalid("menu source reference inventory exceeds its bounded limit");
                    }
                }
            }
        }
        if (rows.length < pageSize) break;
    }
    records.sort((left, right) => compareUtf8(left.source.sourceId, right.source.sourceId));
    const ids = records.map((record) => record.source.sourceId);
    if (new Set(ids).size !== ids.length) persistedInvalid("menu source identities are not unique in the affected scope");
    return Object.freeze(records);
}

export function prepareSourceImpacts(
    records: readonly MenuSourceRecord[],
    reason: SourceRewriteImpact["reason"],
    candidateRules: (record: MenuSourceRecord) => readonly Readonly<PermissionRuleInput>[],
) {
    return Object.freeze(records.map((record): PreparedSourceImpact => {
        const candidates = new Map<string, Readonly<PermissionRuleInput>>();
        for (const rule of candidateRules(record)) {
            const semanticKey = createSemanticKey(
                record.rule.effect,
                rule.action,
                rule.resource,
                rule.where,
            );
            candidates.set(semanticKey, Object.freeze({
                action: rule.action,
                resource: rule.resource,
                ...(rule.where === undefined ? {} : { where: rule.where }),
            }));
        }
        const sorted = [...candidates.entries()].sort(([left], [right]) => compareUtf8(left, right));
        const publicCandidates = sorted.map(([semanticKey, rule]) => ({ semanticKey, rule }));
        const resolutions: ("replace" | "revoke")[] = publicCandidates.length === 0
            ? ["revoke"]
            : ["replace", "revoke"];
        return Object.freeze({
            record,
            candidates: new Map(sorted),
            public: Object.freeze({
                roleId: record.rule.roleId,
                grantId: record.source.grantId,
                sourceId: record.source.sourceId,
                semanticKey: record.rule.semanticKey,
                reason,
                resolutions: Object.freeze(resolutions),
                replacementCandidates: boundedDetails(publicCandidates),
            }),
        });
    }));
}

export function sourceRewriteDecisionDetailCount(impacts: readonly PreparedSourceImpact[]) {
    return impacts.reduce((total, impact) => total + 1 + impact.candidates.size, 0);
}

export function budgetSourceImpacts(
    impacts: readonly PreparedSourceImpact[],
    budget: DetailBudgetAllocator,
) {
    const complete = impacts.map((impact) => impact.public);
    const selectedImpacts = budget.sample(impacts, impacts.length);
    const items = selectedImpacts.map((impact) => {
        const candidates = [...impact.candidates.entries()]
            .map(([semanticKey, rule]) => ({ semanticKey, rule }));
        const selectedCandidates = budget.sample(candidates, candidates.length);
        return deepFreeze({
            ...impact.public,
            replacementCandidates: {
                total: candidates.length,
                items: selectedCandidates,
                truncated: selectedCandidates.length < candidates.length,
                digest: digestCanonical(candidates),
            },
        });
    });
    return deepFreeze({
        total: impacts.length,
        items,
        truncated: items.length < impacts.length,
        digest: digestCanonical(complete),
    });
}

export function sourceRewriteConflicts(
    impacts: readonly PreparedSourceImpact[],
    decision: SourceRewriteDecision,
) {
    const conflicts: ManagementConflict[] = [];
    if (impacts.length > MAX_SOURCE_REWRITE_OPERATIONS) {
        conflicts.push({
            id: "source-rewrite-capacity",
            code: "LIMIT_EXCEEDED",
            message: `Source rewrite requires ${impacts.length} operations; the atomic limit is ${MAX_SOURCE_REWRITE_OPERATIONS}.`,
        });
        return Object.freeze(conflicts);
    }
    const decisionDetailCount = sourceRewriteDecisionDetailCount(impacts);
    if (decisionDetailCount > RESPONSE_DETAIL_LIMIT) {
        conflicts.push({
            id: "source-rewrite-decision-details",
            code: "LIMIT_EXCEEDED",
            message: `Source rewrite requires ${decisionDetailCount} impact and replacement-candidate details; narrow the operation to at most ${RESPONSE_DETAIL_LIMIT}.`,
        });
        return Object.freeze(conflicts);
    }
    if (impacts.length === 0) {
        if (decision.mode === "apply" && Object.keys(decision.resolutions).length > 0) {
            conflicts.push({ id: "source-rewrite-extra", code: "INVALID_ARGUMENT", message: "Source rewrite resolutions were provided but no source is affected." });
        }
        return Object.freeze(conflicts);
    }
    if (decision.mode === "reject") {
        for (const impact of impacts) {
            conflicts.push({
                id: impact.record.source.sourceId,
                code: "SOURCE_REWRITE_REQUIRED",
                message: "The affected menu source requires an explicit replace or revoke decision.",
            });
        }
        return Object.freeze(conflicts);
    }
    const expected = impacts.map((impact) => impact.record.source.sourceId).sort(compareUtf8);
    const actual = Object.keys(decision.resolutions).sort(compareUtf8);
    if (expected.length !== actual.length || expected.some((sourceId, index) => sourceId !== actual[index])) {
        conflicts.push({
            id: "source-rewrite-resolution-set",
            code: "INVALID_ARGUMENT",
            message: "Source rewrite resolution keys must exactly match the affected source IDs.",
        });
        return Object.freeze(conflicts);
    }
    for (const impact of impacts) {
        const resolution = decision.resolutions[impact.record.source.sourceId]!;
        if (resolution.action === "replace" && !impact.candidates.has(resolution.replacementSemanticKey)) {
            conflicts.push({
                id: impact.record.source.sourceId,
                code: "INVALID_ARGUMENT",
                message: "The replacement semantic key is not one of this source impact's candidates.",
            });
        }
    }
    return Object.freeze(conflicts);
}

type MenuContribution = {
    readonly rule: Readonly<InternalRoleRuleDocument>;
    readonly source: Readonly<MenuSource>;
};

export interface RoleMenuAggregateFields {
    readonly menuGrantCount: number;
    readonly menuGrantDigest: string;
    readonly menuSourceCount: number;
    readonly menuSourceDigest: string;
}

function insertOptions(session: MongoSession) {
    return { session, cache: { invalidate: false as const } };
}

function sourceWriteOptions(session: MongoSession) {
    return { session, cache: { invalidate: false as const }, collation: SIMPLE_COLLATION };
}

function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The menu source rewrite result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function sourceRevisionConflict(owner: string, expected: number): never {
    throw new PermissionCoreError("REVISION_CONFLICT", `${owner} changed during the menu source rewrite.`, {
        details: { kind: "revision-conflict", owner, expected },
    });
}

function contributionRecord(contribution: MenuContribution) {
    const { rule, source } = contribution;
    return {
        sourceId: source.sourceId,
        semanticKey: rule.semanticKey,
        effect: rule.effect,
        action: rule.action,
        resource: rule.resource,
        ...(rule.where === undefined ? {} : { where: rule.where }),
        contribution: source.contribution,
        assetId: source.assetId,
        ...(source.contribution === "api" ? { apiBindingId: source.apiBindingId } : {}),
        ...(source.contribution === "data" ? { dataResource: source.dataResource } : {}),
    };
}

function sortedContributions(contributions: readonly MenuContribution[]) {
    return [...contributions]
        .sort((left, right) => compareUtf8(left.source.sourceId, right.source.sourceId));
}

export function createRoleMenuGrantSnapshot(
    intent: Readonly<MenuGrantIntent>,
    contributions: readonly MenuContribution[],
) {
    return createRoleMenuGrantSnapshotFromContributions(intent, contributions.map(({ rule, source }) => ({
        ...contributionRecord({ rule, source }),
        grantId: source.grantId,
    })));
}

export function createRoleMenuGrantSnapshotFromContributions(
    intent: Readonly<MenuGrantIntent>,
    contributions: readonly Readonly<MenuRuleContribution>[],
) {
    const records = [...contributions]
        .sort((left, right) => compareUtf8(left.sourceId, right.sourceId))
        .map(({ grantId: _grantId, ...contribution }) => ({ ...contribution }));
    const contractRecords = records.map(({ sourceId: _sourceId, ...record }) => record);
    const contributingAssetIds = [...new Set(records.map((record) => record.assetId))].sort(compareUtf8);
    const contributingBindingIds = [...new Set(records.flatMap((record) =>
        record.apiBindingId === undefined ? [] : [record.apiBindingId]))].sort(compareUtf8);
    return deepFreeze({
        contributionContractDigest: digestCanonical({ intent, contributions: contractRecords }),
        contributionDigest: digestCanonical(records),
        contributingAssetCount: contributingAssetIds.length,
        contributingBindingCount: contributingBindingIds.length,
        contributingAssetIds,
        contributingBindingIds,
    });
}

function contributionSnapshotOnly(snapshot: Readonly<InternalRoleMenuGrantDocument["snapshot"]>) {
    return deepFreeze({
        contributionContractDigest: snapshot.contributionContractDigest,
        contributionDigest: snapshot.contributionDigest,
        contributingAssetCount: snapshot.contributingAssetCount,
        contributingBindingCount: snapshot.contributingBindingCount,
        contributingAssetIds: snapshot.contributingAssetIds,
        contributingBindingIds: snapshot.contributingBindingIds,
    });
}

export function createRoleMenuAggregateFields(
    grants: readonly Readonly<InternalRoleMenuGrantDocument>[],
    rules: readonly Readonly<InternalRoleRuleDocument>[],
): RoleMenuAggregateFields {
    const grantTuples = grants
        .map((grant) => [grant.grantId, grant.grantRevision] as const)
        .sort(([left], [right]) => compareUtf8(left, right));
    const sourceTuples = rules.flatMap((rule) => rule.sources.flatMap((source) =>
        source.kind === "menu"
            ? [[source.sourceId, rule.semanticKey, rule.effect] as const]
            : []))
        .sort(([left], [right]) => compareUtf8(left, right));
    return deepFreeze({
        menuGrantCount: grantTuples.length,
        menuGrantDigest: digestCanonical(grantTuples),
        menuSourceCount: sourceTuples.length,
        menuSourceDigest: digestCanonical(sourceTuples),
    });
}

function sameRoleMenuAggregates(
    role: Readonly<InternalRoleDocument>,
    aggregate: RoleMenuAggregateFields,
) {
    return role.menuGrantCount === aggregate.menuGrantCount
        && role.menuGrantDigest === aggregate.menuGrantDigest
        && role.menuSourceCount === aggregate.menuSourceCount
        && role.menuSourceDigest === aggregate.menuSourceDigest;
}

export function validateRoleMenuIntegrity(
    role: Readonly<InternalRoleDocument>,
    rules: readonly Readonly<InternalRoleRuleDocument>[],
    grants: readonly Readonly<InternalRoleMenuGrantDocument>[],
) {
    const aggregate = createRoleMenuAggregateFields(grants, rules);
    if (!sameRoleMenuAggregates(role, aggregate)) {
        persistedInvalid(`role ${role.roleId} menu aggregate does not match its grant/source inventory`);
    }
    const grantsById = new Map<string, Readonly<InternalRoleMenuGrantDocument>>();
    for (const grant of grants) {
        if (grant.roleId !== role.roleId || grantsById.has(grant.grantId)) {
            persistedInvalid(`role ${role.roleId} contains an invalid or duplicate menu grant`);
        }
        grantsById.set(grant.grantId, grant);
    }
    const contributionsByGrant = new Map<string, MenuContribution[]>();
    const sourceIds = new Set<string>();
    for (const rule of rules) {
        if (rule.roleId !== role.roleId) persistedInvalid(`role ${role.roleId} rule inventory crossed a role boundary`);
        for (const source of rule.sources) {
            if (source.kind !== "menu") continue;
            if (sourceIds.has(source.sourceId)) persistedInvalid(`role ${role.roleId} contains duplicate menu source identities`);
            sourceIds.add(source.sourceId);
            const grant = grantsById.get(source.grantId);
            if (
                grant === undefined
                || grant.effect !== source.effect
                || grant.effect !== rule.effect
                || grant.grantRevision !== source.grantRevision
            ) {
                persistedInvalid(`menu source ${source.sourceId} does not match its grant aggregate`);
            }
            const group = contributionsByGrant.get(source.grantId) ?? [];
            group.push({ rule, source });
            contributionsByGrant.set(source.grantId, group);
        }
    }
    for (const grant of grants) {
        const contributions = contributionsByGrant.get(grant.grantId) ?? [];
        if (contributions.length === 0) persistedInvalid(`menu grant ${grant.grantId} has no rule contribution`);
        const expected = createRoleMenuGrantSnapshot(grant.intent, contributions);
        if (canonicalString(contributionSnapshotOnly(grant.snapshot)) !== canonicalString(expected)) {
            persistedInvalid(`menu grant ${grant.grantId} snapshot does not match its rule contributions`);
        }
    }
}

export async function applySourceRewriteExecution(input: {
    readonly repository: PermissionRepository;
    readonly schemes: ResourceSchemeRegistry;
    readonly session: MongoSession;
    readonly prepared: PreparedSourceRewriteExecution;
}) {
    if (input.prepared.conflicts.length > 0) {
        throw new TypeError("A conflicted source rewrite plan cannot be executed.");
    }
    for (const rolePlan of input.prepared.roles) {
        for (const mutation of rolePlan.rules) {
            const before = mutation.before;
            const after = mutation.after;
            if (before === null && after !== null) {
                const result = await input.repository.collections.roleRules.insertOne(
                    { ...after, sources: after.sources.map((source) => ({ ...source })) },
                    insertOptions(input.session),
                );
                if (result.acknowledged !== true) databaseWriteFailure("source rewrite rule insert was not acknowledged");
            } else if (before !== null && after === null) {
                const result = await input.repository.collections.roleRules.deleteOne(
                    {
                        scopeKey: before.scopeKey,
                        roleId: before.roleId,
                        semanticKey: before.semanticKey,
                        revision: before.revision,
                    },
                    sourceWriteOptions(input.session),
                );
                if (result.deletedCount !== 1) sourceRevisionConflict(`role:${before.roleId}:rule:${before.semanticKey}`, before.revision);
            } else if (before !== null && after !== null) {
                assertInternalDocumentBudget(after);
                const result = await input.repository.collections.roleRules.updateOne(
                    {
                        scopeKey: before.scopeKey,
                        roleId: before.roleId,
                        semanticKey: before.semanticKey,
                        revision: before.revision,
                    },
                    {
                        $set: {
                            sources: after.sources.map((source) => ({ ...source })),
                            revision: after.revision,
                            updatedAt: after.updatedAt,
                        },
                    },
                    sourceWriteOptions(input.session),
                );
                if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
                    sourceRevisionConflict(`role:${before.roleId}:rule:${before.semanticKey}`, before.revision);
                }
            }
        }
        for (const mutation of rolePlan.grants) {
            const before = mutation.before;
            const after = mutation.after;
            if (before === null && after !== null) {
                const result = await input.repository.collections.roleMenuGrants.insertOne(
                    { ...after, intent: { ...after.intent }, snapshot: { ...after.snapshot } },
                    insertOptions(input.session),
                );
                if (result.acknowledged !== true) databaseWriteFailure("source rewrite grant insert was not acknowledged");
            } else if (before !== null && after === null) {
                const result = await input.repository.collections.roleMenuGrants.deleteOne(
                    {
                        scopeKey: before.scopeKey,
                        roleId: before.roleId,
                        grantId: before.grantId,
                        grantRevision: before.grantRevision,
                    },
                    sourceWriteOptions(input.session),
                );
                if (result.deletedCount !== 1) sourceRevisionConflict(`grant:${before.grantId}`, before.grantRevision);
            } else if (before !== null && after !== null) {
                assertRoleMenuGrantBudget(after);
                assertInternalDocumentBudget(after);
                const result = await input.repository.collections.roleMenuGrants.updateOne(
                    {
                        scopeKey: before.scopeKey,
                        roleId: before.roleId,
                        grantId: before.grantId,
                        grantRevision: before.grantRevision,
                    },
                    {
                        $set: {
                            intent: after.intent,
                            snapshot: after.snapshot,
                            grantRevision: after.grantRevision,
                            updatedAt: after.updatedAt,
                        },
                    },
                    sourceWriteOptions(input.session),
                );
                if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
                    sourceRevisionConflict(`grant:${before.grantId}`, before.grantRevision);
                }
            }
        }
        assertInternalDocumentBudget(rolePlan.afterRole);
        const roleResult = await input.repository.collections.roles.updateOne(
            {
                scopeKey: rolePlan.beforeRole.scopeKey,
                roleId: rolePlan.beforeRole.roleId,
                revision: rolePlan.beforeRole.revision,
            },
            {
                $set: {
                    revision: rolePlan.afterRole.revision,
                    menuGrantCount: rolePlan.afterRole.menuGrantCount,
                    menuGrantDigest: rolePlan.afterRole.menuGrantDigest,
                    menuSourceCount: rolePlan.afterRole.menuSourceCount,
                    menuSourceDigest: rolePlan.afterRole.menuSourceDigest,
                    updatedAt: rolePlan.afterRole.updatedAt,
                },
            },
            sourceWriteOptions(input.session),
        );
        if (roleResult.matchedCount !== 1 || roleResult.modifiedCount !== 1) {
            sourceRevisionConflict(`role:${rolePlan.beforeRole.roleId}`, rolePlan.beforeRole.revision);
        }

        for (const mutation of rolePlan.rules) {
            const expected = mutation.after;
            const identity = expected ?? mutation.before!;
            const raw = await input.repository.collections.roleRules.findOne(
                { scopeKey: identity.scopeKey, roleId: identity.roleId, semanticKey: identity.semanticKey },
                readOptions(input.session),
            );
            const actual = raw === null
                ? null
                : materializeRoleRuleDocument(raw, identity.scope, identity.scopeKey, input.schemes);
            if (canonicalString(actual) !== canonicalString(expected)) {
                databaseWriteFailure(`source rewrite rule ${identity.semanticKey} post-image differs from its plan`);
            }
        }
        for (const mutation of rolePlan.grants) {
            const expected = mutation.after;
            const identity = expected ?? mutation.before!;
            const raw = await input.repository.collections.roleMenuGrants.findOne(
                { scopeKey: identity.scopeKey, roleId: identity.roleId, grantId: identity.grantId },
                readOptions(input.session),
            );
            const actual = raw === null
                ? null
                : materializeRoleMenuGrantDocument(raw, identity.scope, identity.scopeKey);
            if (canonicalString(actual) !== canonicalString(expected)) {
                databaseWriteFailure(`source rewrite grant ${identity.grantId} post-image differs from its plan`);
            }
        }
        const rawRole = await input.repository.collections.roles.findOne(
            { scopeKey: rolePlan.afterRole.scopeKey, roleId: rolePlan.afterRole.roleId },
            readOptions(input.session),
        );
        const actualRole = rawRole === null
            ? null
            : materializeRoleDocument(rawRole, rolePlan.afterRole.scope, rolePlan.afterRole.scopeKey);
        if (canonicalString(actualRole) !== canonicalString(rolePlan.afterRole)) {
            databaseWriteFailure(`source rewrite role ${rolePlan.afterRole.roleId} post-image differs from its plan`);
        }
    }
}
