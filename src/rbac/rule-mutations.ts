import type {
    BatchMutationSummary,
    ManualRuleChange,
    ManualRuleChangeResult,
    ManualRuleSelector,
    MutationOptions,
    MutationResult,
    PermissionRuleInput,
    PermissionRuleView,
    PermissionScope,
    PolicyValue,
    RuleSourceView,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import {
    assertInternalDocumentBudget,
    type InternalRoleDocument,
    type InternalRoleRuleDocument,
    type InternalRoleRuleSource,
} from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import {
    normalizeManualRuleSelector,
    normalizePermissionRuleInput,
} from "./inputs";
import { createSemanticKey, MAX_RULE_SOURCES } from "./materialize";
import {
    normalizeMutationOptions,
    RbacMutationExecutor,
    type CacheInvalidator,
    type MutationWorkContext,
    type NormalizedMutationOptions,
} from "./mutation-executor";
import {
    decodePermissionRuleReplay,
    decodeRuleRevokeReplay,
    permissionRuleView,
} from "./views";
import {
    MAX_RULES_PER_ROLE,
    type RbacAuthorizationResolver,
    type RbacScopeReader,
} from "./store";
import { normalizeRbacId } from "./validation";

function insertOptions(session: unknown) {
    return { session, cache: { invalidate: false as const } };
}

function writeOptions(session: unknown) {
    return { session, collation: SIMPLE_COLLATION, cache: { invalidate: false as const } };
}

function revisionConflict(roleId: string, expected: number): never {
    throw new PermissionCoreError("REVISION_CONFLICT", `Role ${roleId} changed during the rule mutation.`, {
        details: { kind: "revision-conflict", owner: `role:${roleId}`, expected },
    });
}

function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The manual rule write result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function assertRoleMutable(role: Readonly<InternalRoleDocument>) {
    if (role.status === "deprecated") {
        throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated roles cannot change rules.", {
            details: { kind: "validation", field: "roleId", reason: "role is deprecated" },
        });
    }
}

async function bumpRoleRevision(
    repository: PermissionRepository,
    role: Readonly<InternalRoleDocument>,
    now: number,
    session: unknown,
) {
    const next: InternalRoleDocument = { ...role, revision: role.revision + 1, updatedAt: now };
    assertInternalDocumentBudget(next);
    const result = await repository.collections.roles.updateOne(
        { scopeKey: role.scopeKey, roleId: role.roleId, revision: role.revision },
        { $set: { revision: next.revision, updatedAt: now } },
        writeOptions(session),
    );
    if (result.matchedCount !== 1) {
        revisionConflict(role.roleId, role.revision);
    }
    if (result.modifiedCount !== 1) {
        databaseWriteFailure("role revision owner did not advance exactly once");
    }
    return next;
}

function manualSource(semanticKey: string): InternalRoleRuleSource {
    return Object.freeze({ kind: "manual", sourceId: `manual:${semanticKey}` });
}

function hasManualSource(rule: Readonly<InternalRoleRuleDocument>) {
    return rule.sources.some((source) => source.kind === "manual");
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

export interface PreparedRuleSetExecution {
    readonly validatedPlanHash: string;
    readonly capacity: PolicyValue;
    readonly beforeRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly afterRules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly summary: BatchMutationSummary;
}

export type DirectRuleMutationPreflight = (context: MutationWorkContext) => Promise<void>;

function replayRecord(value: unknown, field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${field} must be an object`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function decodeManualRuleChangeResult(value: unknown, resourceSchemes: ResourceSchemeRegistry): ManualRuleChangeResult {
    const record = replayRecord(value, "manual rule result");
    if (record.operation === "allow" || record.operation === "deny") {
        if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "rule")) {
            throw new TypeError("manual rule result has an invalid rule envelope");
        }
        return deepFreeze({
            operation: record.operation,
            rule: decodePermissionRuleReplay(record.rule, resourceSchemes),
        });
    }
    if (record.operation === "revoke") {
        if (Object.keys(record).length !== 4) {
            throw new TypeError("manual rule result has an invalid revoke envelope");
        }
        const data = decodeRuleRevokeReplay({
            removed: record.removed,
            remainingCount: record.remainingCount,
            remainingDigest: record.remainingDigest,
        });
        return deepFreeze({ operation: "revoke", ...data });
    }
    throw new TypeError("manual rule result has an invalid operation");
}

function manualRuleResultDetails(data: ManualRuleChangeResult): {
    returned: number;
    total: number;
    tree: PolicyValue;
} {
    if (data.operation === "revoke") {
        return { returned: 0, total: 0, tree: { warnings: [] } };
    }
    return {
        returned: data.rule.sources.items.length,
        total: data.rule.sources.total,
        tree: { sourcesDigest: data.rule.sources.digest, warnings: [] },
    };
}

function decodeBatchSummary(value: unknown): BatchMutationSummary {
    const record = replayRecord(value, "batch summary");
    const keys = ["inserted", "updated", "unchanged", "deleted", "conflicted"] as const;
    for (const key of keys) {
        if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) {
            throw new TypeError(`batch summary ${key} is invalid`);
        }
    }
    const samples = replayRecord(record.samples, "batch summary samples");
    if (
        !Number.isSafeInteger(samples.total)
        || (samples.total as number) < 0
        || !Array.isArray(samples.items)
        || samples.items.length > 100
        || typeof samples.truncated !== "boolean"
        || typeof samples.digest !== "string"
    ) {
        throw new TypeError("batch summary samples are invalid");
    }
    const normalizedSamples = samples.items.map((entry, index) => {
        const item = replayRecord(entry, `batch summary samples[${index}]`);
        if (
            typeof item.id !== "string"
            || !["inserted", "updated", "unchanged", "deleted", "conflicted"].includes(item.outcome as string)
        ) {
            throw new TypeError("batch summary sample is invalid");
        }
        return deepFreeze({ id: item.id, outcome: item.outcome as "inserted" | "updated" | "unchanged" | "deleted" });
    });
    return deepFreeze({
        inserted: record.inserted as number,
        updated: record.updated as number,
        unchanged: record.unchanged as number,
        deleted: record.deleted as number,
        conflicted: record.conflicted as number,
        samples: {
            total: samples.total as number,
            items: normalizedSamples,
            truncated: samples.truncated,
            digest: samples.digest,
        },
    });
}

export class RuleMutationService {
    private readonly executor: RbacMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly resourceSchemes: ResourceSchemeRegistry,
        invalidateCache?: CacheInvalidator,
        private readonly authorizationResolver?: RbacAuthorizationResolver,
    ) {
        this.executor = new RbacMutationExecutor(repository, resourceSchemes, invalidateCache);
    }

    private async resolveMenuSourceViews(
        reader: RbacScopeReader,
        roleId: string,
        rules: readonly Readonly<InternalRoleRuleDocument>[],
    ): Promise<ReadonlyMap<string, RuleSourceView>> {
        const hasMenuSource = rules.some((rule) => rule.sources.some((source) => source.kind === "menu"));
        if (!hasMenuSource) return new Map<string, RuleSourceView>();
        if (this.authorizationResolver === undefined) {
            throw new PermissionCoreError(
                "INVALID_CONFIGURATION",
                "Menu-backed rule mutations require an authorization source resolver.",
                {
                    details: {
                        kind: "validation",
                        field: "authorizationResolver",
                        reason: "is required when a role contains menu-backed rule sources",
                    },
                },
            );
        }
        const resolved = await this.authorizationResolver.resolveManagement(reader, [roleId], rules);
        return resolved.sourceViews;
    }

    allow(
        scope: PermissionScope,
        roleId: string,
        rule: PermissionRuleInput,
        options?: MutationOptions,
        preflight?: DirectRuleMutationPreflight,
    ) {
        return this.upsert(scope, roleId, "allow", rule, options, preflight);
    }

    deny(
        scope: PermissionScope,
        roleId: string,
        rule: PermissionRuleInput,
        options?: MutationOptions,
        preflight?: DirectRuleMutationPreflight,
    ) {
        return this.upsert(scope, roleId, "deny", rule, options, preflight);
    }

    private async upsert(
        scope: PermissionScope,
        roleIdInput: string,
        effect: "allow" | "deny",
        ruleInput: PermissionRuleInput,
        optionsInput?: MutationOptions,
        preflight?: DirectRuleMutationPreflight,
    ): Promise<MutationResult<PermissionRuleView>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const rule = normalizePermissionRuleInput(ruleInput, this.resourceSchemes);
        const semanticKey = createSemanticKey(effect, rule.action, rule.resource, rule.where);
        const options = normalizeMutationOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: effect === "allow" ? "roles.allow" : "roles.deny",
            action: effect,
            resource: `role:${roleId}:rule:${semanticKey}`,
            request: toPolicyValue({ roleId, effect, rule }),
            options,
            decodeReplay: (value) => decodePermissionRuleReplay(value, this.resourceSchemes),
            replayDetails: (data) => ({
                returned: data.sources.items.length,
                total: data.sources.total,
                tree: { sourcesDigest: data.sources.digest, warnings: [] },
            }),
            work: async ({ transaction, reader, now }) => {
                const roleDocument = await reader.requireRole(roleId);
                assertRoleMutable(roleDocument);
                const existing = await reader.readRule(roleId, semanticKey);
                const sourceViews = existing?.sources.some((source) => source.kind === "menu") === true
                    ? await this.resolveMenuSourceViews(reader, roleId, await reader.readRulesForRole(roleId))
                    : new Map<string, RuleSourceView>();
                if (existing && hasManualSource(existing)) {
                    const data = permissionRuleView(existing, sourceViews);
                    return {
                        changed: false,
                        data,
                        primaryRevision: roleDocument.revision,
                        entity: {
                            kind: "role",
                            id: roleId,
                            before: roleDocument.revision,
                            after: roleDocument.revision,
                        },
                        change: { kind: "manual-rule", operation: effect, before: data, after: data },
                        cacheTargets: [],
                    };
                }
                await preflight?.({ transaction, state: reader.state, reader, now });

                let nextRule: InternalRoleRuleDocument;
                if (existing === null) {
                    const currentRules = await reader.readRulesForRole(roleId);
                    if (currentRules.length >= MAX_RULES_PER_ROLE) {
                        throw new PermissionCoreError("LIMIT_EXCEEDED", "The role semantic rule limit was reached.", {
                            details: {
                                kind: "limit-exceeded",
                                origin: "caller-input",
                                limitName: "rules-per-role",
                                current: currentRules.length + 1,
                                max: MAX_RULES_PER_ROLE,
                                unit: "items",
                            },
                        });
                    }
                    nextRule = {
                        scopeKey: reader.state.scopeKey,
                        scope: reader.state.scope,
                        roleId,
                        effect,
                        action: rule.action,
                        resource: rule.resource,
                        ...(rule.where === undefined ? {} : { where: rule.where }),
                        semanticKey,
                        sources: Object.freeze([manualSource(semanticKey)]),
                        revision: 1,
                        createdAt: now,
                        updatedAt: now,
                    };
                    assertInternalDocumentBudget(nextRule);
                    const result = await this.repository.collections.roleRules.insertOne(
                        { ...nextRule, sources: nextRule.sources.map((source) => ({ ...source })) },
                        insertOptions(transaction.session),
                    );
                    if (result.acknowledged !== true) {
                        databaseWriteFailure("manual rule insert was not acknowledged");
                    }
                } else {
                    if (existing.sources.length >= MAX_RULE_SOURCES) {
                        throw new PermissionCoreError("LIMIT_EXCEEDED", "The semantic rule source limit was reached.", {
                            details: {
                                kind: "limit-exceeded",
                                origin: "caller-input",
                                limitName: "rule-sources",
                                current: existing.sources.length + 1,
                                max: MAX_RULE_SOURCES,
                                unit: "items",
                            },
                        });
                    }
                    const sources = [...existing.sources, manualSource(semanticKey)]
                        .sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
                    nextRule = {
                        ...existing,
                        sources: Object.freeze(sources),
                        revision: existing.revision + 1,
                        updatedAt: now,
                    };
                    assertInternalDocumentBudget(nextRule);
                    const result = await this.repository.collections.roleRules.updateOne(
                        {
                            scopeKey: reader.state.scopeKey,
                            roleId,
                            semanticKey,
                            revision: existing.revision,
                        },
                        {
                            $set: {
                                sources: sources.map((source) => ({ ...source })),
                                revision: nextRule.revision,
                                updatedAt: now,
                            },
                        },
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1) {
                        revisionConflict(roleId, roleDocument.revision);
                    }
                    if (result.modifiedCount !== 1) {
                        databaseWriteFailure("manual source append did not modify exactly one rule");
                    }
                }
                const nextRole = await bumpRoleRevision(
                    this.repository,
                    roleDocument,
                    now,
                    transaction.session,
                );
                const rolePostImage = await reader.requireRole(roleId);
                if (canonicalString(rolePostImage) !== canonicalString(nextRole)) {
                    databaseWriteFailure("role revision post-image differs from the validated document");
                }
                const postImage = await reader.readRule(roleId, semanticKey);
                if (postImage === null || canonicalString(postImage) !== canonicalString(nextRule)) {
                    databaseWriteFailure("manual rule post-image differs from the validated document");
                }
                const data = permissionRuleView(postImage, sourceViews);
                return {
                    changed: true,
                    data,
                    primaryRevision: nextRole.revision,
                    entity: {
                        kind: "role",
                        id: roleId,
                        before: roleDocument.revision,
                        after: nextRole.revision,
                    },
                    change: {
                        kind: "manual-rule",
                        operation: effect,
                        before: existing === null ? null : permissionRuleView(existing, sourceViews),
                        after: data,
                    },
                    cacheTargets: [`scope:${reader.state.scopeKey}:rbac`],
                };
            },
        });
    }

    async revoke(
        scope: PermissionScope,
        roleIdInput: string,
        selectorInput: ManualRuleSelector,
        optionsInput?: MutationOptions,
        preflight?: DirectRuleMutationPreflight,
    ) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const selector = normalizeManualRuleSelector(selectorInput, this.resourceSchemes);
        const options = normalizeMutationOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: "roles.revoke",
            action: "revoke",
            resource: `role:${roleId}:rule:${selector.semanticKey}`,
            request: toPolicyValue({ roleId, selector }),
            options,
            decodeReplay: decodeRuleRevokeReplay,
            work: async ({ transaction, reader, now }) => {
                const roleDocument = await reader.requireRole(roleId);
                assertRoleMutable(roleDocument);
                const existing = await reader.readRule(roleId, selector.semanticKey);
                const removable = existing?.sources.some((source) => source.kind === "manual") === true;
                const remainingKeys = (await reader.readManualRuleKeysForRole(roleId))
                    .filter((semanticKey) => semanticKey !== selector.semanticKey);
                if (!removable) {
                    const data = {
                        removed: 0,
                        remainingCount: remainingKeys.length,
                        remainingDigest: digestCanonical(remainingKeys),
                    };
                    return {
                        changed: false,
                        data,
                        primaryRevision: roleDocument.revision,
                        entity: {
                            kind: "role",
                            id: roleId,
                            before: roleDocument.revision,
                            after: roleDocument.revision,
                        },
                        change: { kind: "manual-rule", operation: "revoke", selector, removed: 0 },
                        cacheTargets: [],
                    };
                }
                await preflight?.({ transaction, state: reader.state, reader, now });
                const retainedSources = existing!.sources.filter((source) => source.kind !== "manual");
                let expectedPostImage: InternalRoleRuleDocument | null;
                if (retainedSources.length === 0) {
                    const result = await this.repository.collections.roleRules.deleteOne(
                        {
                            scopeKey: reader.state.scopeKey,
                            roleId,
                            semanticKey: selector.semanticKey,
                            revision: existing!.revision,
                        },
                        writeOptions(transaction.session),
                    );
                    if (result.deletedCount !== 1) {
                        revisionConflict(roleId, roleDocument.revision);
                    }
                    expectedPostImage = null;
                } else {
                    const nextRule: InternalRoleRuleDocument = {
                        ...existing!,
                        sources: Object.freeze(retainedSources),
                        revision: existing!.revision + 1,
                        updatedAt: now,
                    };
                    assertInternalDocumentBudget(nextRule);
                    const result = await this.repository.collections.roleRules.updateOne(
                        {
                            scopeKey: reader.state.scopeKey,
                            roleId,
                            semanticKey: selector.semanticKey,
                            revision: existing!.revision,
                        },
                        {
                            $set: {
                                sources: retainedSources.map((source) => ({ ...source })),
                                revision: nextRule.revision,
                                updatedAt: now,
                            },
                        },
                        writeOptions(transaction.session),
                    );
                    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
                        revisionConflict(roleId, roleDocument.revision);
                    }
                    expectedPostImage = nextRule;
                }
                const nextRole = await bumpRoleRevision(
                    this.repository,
                    roleDocument,
                    now,
                    transaction.session,
                );
                const rolePostImage = await reader.requireRole(roleId);
                if (canonicalString(rolePostImage) !== canonicalString(nextRole)) {
                    databaseWriteFailure("role revision post-image differs from the validated document");
                }
                const postImage = await reader.readRule(roleId, selector.semanticKey);
                if (canonicalString(postImage) !== canonicalString(expectedPostImage)) {
                    databaseWriteFailure("manual revoke post-image is inconsistent");
                }
                const data = {
                    removed: 1,
                    remainingCount: remainingKeys.length,
                    remainingDigest: digestCanonical(remainingKeys),
                };
                return {
                    changed: true,
                    data,
                    primaryRevision: nextRole.revision,
                    entity: {
                        kind: "role",
                        id: roleId,
                        before: roleDocument.revision,
                        after: nextRole.revision,
                    },
                    change: { kind: "manual-rule", operation: "revoke", selector, removed: 1 },
                    cacheTargets: [`scope:${reader.state.scopeKey}:rbac`],
                };
            },
        });
    }

    private async applyPreparedRuleSet(
        context: MutationWorkContext,
        roleId: string,
        prepared: PreparedRuleSetExecution,
    ) {
        const { transaction, reader, now } = context;
        const role = await reader.requireRole(roleId);
        assertRoleMutable(role);
        const currentRules = await reader.readRulesForRole(roleId);
        if (canonicalString(currentRules) !== canonicalString(prepared.beforeRules)) {
            throw new PermissionCoreError("READ_CONFLICT", "The role rules changed while preparing execution.", {
                details: {
                    kind: "read-conflict",
                    owner: `role:${roleId}:rules`,
                    expected: digestCanonical(prepared.beforeRules),
                    current: digestCanonical(currentRules),
                },
            });
        }
        const before = new Map(currentRules.map((rule) => [rule.semanticKey, rule]));
        const after = new Map(prepared.afterRules.map((rule) => [rule.semanticKey, rule]));
        const keys = [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8);
        let changedCount = 0;
        for (const semanticKey of keys) {
            const previous = before.get(semanticKey);
            const next = after.get(semanticKey);
            if (canonicalString(previous ?? null) === canonicalString(next ?? null)) continue;
            changedCount += 1;
            if (!previous && next) {
                assertInternalDocumentBudget(next);
                const result = await this.repository.collections.roleRules.insertOne(
                    { ...next, sources: next.sources.map((source) => ({ ...source })) },
                    insertOptions(transaction.session),
                );
                if (result.acknowledged !== true) databaseWriteFailure("prepared rule insert was not acknowledged");
                continue;
            }
            if (previous && !next) {
                const result = await this.repository.collections.roleRules.deleteOne(
                    { scopeKey: reader.state.scopeKey, roleId, semanticKey, revision: previous.revision },
                    writeOptions(transaction.session),
                );
                if (result.deletedCount !== 1) revisionConflict(roleId, role.revision);
                continue;
            }
            const stableBefore = {
                ...previous!,
                sources: [],
                revision: 0,
                updatedAt: 0,
            };
            const stableAfter = {
                ...next!,
                sources: [],
                revision: 0,
                updatedAt: 0,
            };
            if (
                canonicalString(stableBefore) !== canonicalString(stableAfter)
                || next!.revision !== previous!.revision + 1
                || next!.updatedAt !== now
            ) {
                databaseWriteFailure("prepared rule update changed fields outside its manual source set");
            }
            assertInternalDocumentBudget(next!);
            const result = await this.repository.collections.roleRules.updateOne(
                { scopeKey: reader.state.scopeKey, roleId, semanticKey, revision: previous!.revision },
                {
                    $set: {
                        sources: next!.sources.map((source) => ({ ...source })),
                        revision: next!.revision,
                        updatedAt: next!.updatedAt,
                    },
                },
                writeOptions(transaction.session),
            );
            if (result.matchedCount !== 1 || result.modifiedCount !== 1) revisionConflict(roleId, role.revision);
        }
        const changed = changedCount > 0;
        const nextRole = changed
            ? await bumpRoleRevision(this.repository, role, now, transaction.session)
            : role;
        const rolePostImage = await reader.requireRole(roleId);
        if (canonicalString(rolePostImage) !== canonicalString(nextRole)) {
            databaseWriteFailure("prepared rule mutation role post-image is inconsistent");
        }
        const postRules = await reader.readRulesForRole(roleId);
        if (canonicalString(postRules) !== canonicalString(prepared.afterRules)) {
            databaseWriteFailure("prepared rule mutation post-image is inconsistent");
        }
        return { role, nextRole, postRules, changed };
    }

    async executeRuleChange(
        scope: PermissionScope,
        roleIdInput: string,
        change: ReturnType<typeof import("./preview-inputs").normalizeManualRuleChange>,
        options: NormalizedMutationOptions,
        request: PolicyValue,
        validate: (context: MutationWorkContext) => Promise<PreparedRuleSetExecution>,
    ): Promise<MutationResult<ManualRuleChangeResult>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const normalizedRule = change.operation === "revoke" ? change.selector : change.rule;
        const effect = change.operation === "revoke" ? change.selector.effect : change.operation;
        const semanticKey = createSemanticKey(effect, normalizedRule.action, normalizedRule.resource, normalizedRule.where);
        return this.executor.execute({
            scope,
            operation: "roles.executeRuleChange",
            action: change.operation,
            resource: `role:${roleId}:rule:${semanticKey}`,
            request,
            options,
            decodeReplay: (value) => decodeManualRuleChangeResult(value, this.resourceSchemes),
            replayDetails: manualRuleResultDetails,
            work: async (context) => {
                const prepared = await validate(context);
                const sourceViews = await this.resolveMenuSourceViews(
                    context.reader,
                    roleId,
                    prepared.afterRules,
                );
                const applied = await this.applyPreparedRuleSet(context, roleId, prepared);
                let data: ManualRuleChangeResult;
                if (change.operation === "allow" || change.operation === "deny") {
                    const rule = applied.postRules.find((candidate) => candidate.semanticKey === semanticKey);
                    if (!rule) databaseWriteFailure("executed manual rule is missing from the post-image");
                    data = { operation: change.operation, rule: permissionRuleView(rule!, sourceViews) };
                } else {
                    const remainingKeys = applied.postRules
                        .filter(hasManualSource)
                        .map((rule) => rule.semanticKey)
                        .sort(compareUtf8);
                    const removed = prepared.beforeRules.some((rule) => rule.semanticKey === semanticKey && hasManualSource(rule)) ? 1 : 0;
                    data = {
                        operation: "revoke",
                        removed,
                        remainingCount: remainingKeys.length,
                        remainingDigest: digestCanonical(remainingKeys),
                    };
                }
                const details = manualRuleResultDetails(data);
                return {
                    changed: applied.changed,
                    data,
                    primaryRevision: applied.nextRole.revision,
                    entity: {
                        kind: "role",
                        id: roleId,
                        before: applied.role.revision,
                        after: applied.nextRole.revision,
                    },
                    change: { kind: "manual-rule-preview-execution", operation: change.operation, semanticKey, summary: prepared.summary },
                    cacheTargets: applied.changed ? [`scope:${context.reader.state.scopeKey}:rbac`] : [],
                    returnedDetails: details.returned,
                    completeDetailTree: details.tree,
                    validatedPlanHash: prepared.validatedPlanHash,
                    capacity: prepared.capacity,
                };
            },
        });
    }

    async replaceManualRules(
        scope: PermissionScope,
        roleIdInput: string,
        options: NormalizedMutationOptions,
        request: PolicyValue,
        validate: (context: MutationWorkContext) => Promise<PreparedRuleSetExecution>,
    ): Promise<MutationResult<BatchMutationSummary>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        return this.executor.execute({
            scope,
            operation: "roles.replaceRules",
            action: "replace",
            resource: `role:${roleId}:rules`,
            request,
            options,
            decodeReplay: decodeBatchSummary,
            replayDetails: (data) => ({
                returned: data.samples.items.length,
                total: data.samples.total,
                tree: { samplesDigest: data.samples.digest, warnings: [] },
            }),
            work: async (context) => {
                const prepared = await validate(context);
                const applied = await this.applyPreparedRuleSet(context, roleId, prepared);
                return {
                    changed: applied.changed,
                    data: prepared.summary,
                    primaryRevision: applied.nextRole.revision,
                    entity: {
                        kind: "role",
                        id: roleId,
                        before: applied.role.revision,
                        after: applied.nextRole.revision,
                    },
                    change: { kind: "manual-rule-replace", summary: prepared.summary },
                    cacheTargets: applied.changed ? [`scope:${context.reader.state.scopeKey}:rbac`] : [],
                    returnedDetails: prepared.summary.samples.items.length,
                    completeDetailTree: { samplesDigest: prepared.summary.samples.digest, warnings: [] },
                    validatedPlanHash: prepared.validatedPlanHash,
                    capacity: prepared.capacity,
                };
            },
        });
    }
}
