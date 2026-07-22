import type {
    BatchMutationSummary,
    ManagementConflict,
    MenuConfigChange,
    MenuConfigPlan,
    MenuConfigRemovePlan,
    MenuConfigRemoveResult,
    MenuConfigSaveResult,
    PolicyValue,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type {
    InternalApiBindingDocument,
    InternalMenuConfigDocument,
    InternalMenuNodeDocument,
} from "../persistence/documents";
import { DetailBudgetAllocator } from "../rbac/result";
import { normalizeRbacId } from "../rbac/validation";
import { compileMenuConfigInput, type CompiledMenuConfig } from "./config-compiler";
import { sampledCountSample } from "./impact-support";
import { sortBatchMutationSamples } from "./mutations";

export type ConfigChangeOperation =
    | { readonly operation: "save"; readonly config: CompiledMenuConfig }
    | { readonly operation: "remove"; readonly configId: string };

export interface MenuDocumentUpdate<T> {
    readonly before: Readonly<T>;
    readonly after: Readonly<T>;
}

export interface MenuDocumentSplit<T> {
    readonly inserts: readonly Readonly<T>[];
    readonly updates: readonly MenuDocumentUpdate<T>[];
    readonly deletes: readonly Readonly<T>[];
    readonly unchanged: readonly string[];
}

export function splitDocuments<T, TKey extends string>(
    current: readonly Readonly<T>[],
    target: readonly Readonly<T>[],
    key: (value: Readonly<T>) => TKey,
    equal: (left: Readonly<T>, right: Readonly<T>) => boolean,
): MenuDocumentSplit<T> {
    const currentById = new Map(current.map((item) => [key(item), item] as const));
    const targetById = new Map(target.map((item) => [key(item), item] as const));
    const inserts: Readonly<T>[] = [];
    const updates: MenuDocumentUpdate<T>[] = [];
    const deletes: Readonly<T>[] = [];
    const unchanged: string[] = [];
    for (const item of target) {
        const before = currentById.get(key(item));
        if (before === undefined) inserts.push(item);
        else if (equal(before, item)) unchanged.push(key(item));
        else updates.push({ before, after: item });
    }
    for (const item of current) {
        if (!targetById.has(key(item))) deletes.push(item);
    }
    return deepFreeze({ inserts, updates, deletes, unchanged: Object.freeze(unchanged.sort(compareUtf8)) });
}

export function normalizeConfigOperations(
    changes: readonly MenuConfigChange[],
    now: number,
    allowEmptyDraft: boolean,
    schemes: ResourceSchemeRegistry,
) {
    return changes.map((change): ConfigChangeOperation => {
        if (change.operation === "remove") return { operation: "remove", configId: change.configId };
        return {
            operation: "save",
            config: compileMenuConfigInput(change.config, {
                revision: 1,
                createdAt: now,
                updatedAt: now,
                allowEmptyMenus: allowEmptyDraft,
                allowEmptyContainers: allowEmptyDraft,
            }, schemes),
        };
    });
}

export function summarizeConfigManifestOperations(input: {
    readonly configSplit: MenuDocumentSplit<InternalMenuConfigDocument>;
    readonly nodeSplit: MenuDocumentSplit<InternalMenuNodeDocument>;
    readonly bindingSplit: MenuDocumentSplit<InternalApiBindingDocument>;
    readonly conflicts: readonly ManagementConflict[];
}) {
    const samples = [
        ...input.configSplit.inserts.map((config) => ({ id: `config:${config.configId}`, outcome: "inserted" as const })),
        ...input.configSplit.updates.map((update) => ({ id: `config:${update.before.configId}`, outcome: "updated" as const })),
        ...input.configSplit.deletes.map((config) => ({ id: `config:${config.configId}`, outcome: "deleted" as const })),
        ...input.configSplit.unchanged.map((id) => ({ id: `config:${id}`, outcome: "unchanged" as const })),
        ...input.nodeSplit.inserts.map((node) => ({ id: `node:${node.nodeId}`, outcome: "inserted" as const })),
        ...input.nodeSplit.updates.map((update) => ({ id: `node:${update.before.nodeId}`, outcome: "updated" as const })),
        ...input.nodeSplit.deletes.map((node) => ({ id: `node:${node.nodeId}`, outcome: "deleted" as const })),
        ...input.nodeSplit.unchanged.map((id) => ({ id: `node:${id}`, outcome: "unchanged" as const })),
        ...input.bindingSplit.inserts.map((binding) => ({ id: `api-binding:${binding.bindingId}`, outcome: "inserted" as const })),
        ...input.bindingSplit.updates.map((update) => ({ id: `api-binding:${update.before.bindingId}`, outcome: "updated" as const })),
        ...input.bindingSplit.deletes.map((binding) => ({ id: `api-binding:${binding.bindingId}`, outcome: "deleted" as const })),
        ...input.bindingSplit.unchanged.map((id) => ({ id: `api-binding:${id}`, outcome: "unchanged" as const })),
        ...input.conflicts.map((conflict) => ({
            id: conflict.id,
            outcome: "conflicted" as const,
            conflict: {
                code: conflict.code,
                message: conflict.message,
                ...(conflict.currentRevision === undefined ? {} : { currentRevision: conflict.currentRevision }),
            },
        })),
    ];
    return deepFreeze({
        inserted: input.configSplit.inserts.length + input.nodeSplit.inserts.length + input.bindingSplit.inserts.length,
        updated: input.configSplit.updates.length + input.nodeSplit.updates.length + input.bindingSplit.updates.length,
        unchanged: input.configSplit.unchanged.length + input.nodeSplit.unchanged.length + input.bindingSplit.unchanged.length,
        deleted: input.configSplit.deletes.length + input.nodeSplit.deletes.length + input.bindingSplit.deletes.length,
        conflicted: input.conflicts.length,
        samples: new DetailBudgetAllocator().bounded(sortBatchMutationSamples(samples)),
    }) satisfies BatchMutationSummary;
}

export function countConfigManifestMutations(input: {
    readonly configSplit: MenuDocumentSplit<InternalMenuConfigDocument>;
    readonly nodeSplit: MenuDocumentSplit<InternalMenuNodeDocument>;
    readonly bindingSplit: MenuDocumentSplit<InternalApiBindingDocument>;
}) {
    return input.configSplit.inserts.length + input.configSplit.updates.length + input.configSplit.deletes.length
        + input.nodeSplit.inserts.length + input.nodeSplit.updates.length + input.nodeSplit.deletes.length
        + input.bindingSplit.inserts.length + input.bindingSplit.updates.length + input.bindingSplit.deletes.length;
}

export function configMutationLimitConflicts(mutationCount: number, limit: number): ManagementConflict[] {
    if (mutationCount <= limit) return [];
    return [{
        id: "menu-config-mutation-capacity",
        code: "LIMIT_EXCEEDED",
        message: `Menu config change set requires ${mutationCount} document mutations; the atomic limit is ${limit}.`,
    }];
}

export function buildConfigChangeOperationPlans(input: {
    readonly operations: readonly ConfigChangeOperation[];
    readonly currentConfigById: ReadonlyMap<string, Readonly<InternalMenuConfigDocument>>;
    readonly targetConfigById: ReadonlyMap<string, Readonly<InternalMenuConfigDocument>>;
    readonly nodeDeletes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly bindingDeletes: readonly Readonly<InternalApiBindingDocument>[];
    readonly manifestSummary: BatchMutationSummary;
}) {
    const savePlans: MenuConfigPlan[] = [];
    const removePlans: MenuConfigRemovePlan[] = [];
    const changeResults: (MenuConfigSaveResult | MenuConfigRemoveResult)[] = [];
    for (const operation of input.operations) {
        if (operation.operation === "save") {
            const plan = saveOperationPlan(operation, input.currentConfigById, input.targetConfigById, input.manifestSummary);
            savePlans.push(plan.plan);
            changeResults.push(plan.result);
        } else {
            const plan = removeOperationPlan(operation.configId, input.currentConfigById, input.nodeDeletes, input.bindingDeletes);
            removePlans.push(plan.plan);
            changeResults.push(plan.result);
        }
    }
    return deepFreeze({ savePlans, removePlans, changeResults });
}

function saveOperationPlan(
    operation: Extract<ConfigChangeOperation, { readonly operation: "save" }>,
    currentConfigById: ReadonlyMap<string, Readonly<InternalMenuConfigDocument>>,
    targetConfigById: ReadonlyMap<string, Readonly<InternalMenuConfigDocument>>,
    manifestSummary: BatchMutationSummary,
) {
    const before = currentConfigById.get(operation.config.configId);
    const after = targetConfigById.get(operation.config.configId)!;
    return deepFreeze({
        plan: deepFreeze({
            configId: operation.config.configId,
            operation: "save",
            ...(before === undefined ? {} : { before: before.config }),
            after: after.config,
            manifestOperations: sampledCountSample(manifestSummary.samples.items.map((item) => `${item.outcome}:${item.id}`)),
            affectedRoles: sampledCountSample([]),
            affectedUsers: sampledCountSample([]),
        }) satisfies MenuConfigPlan,
        result: deepFreeze({
            config: after.config,
            manifestOperations: manifestSummary,
            retainedGrantCount: 0,
            revokedGrantCount: 0,
        }) satisfies MenuConfigSaveResult,
    });
}

function removeOperationPlan(
    configId: string,
    currentConfigById: ReadonlyMap<string, Readonly<InternalMenuConfigDocument>>,
    nodeDeletes: readonly Readonly<InternalMenuNodeDocument>[],
    bindingDeletes: readonly Readonly<InternalApiBindingDocument>[],
) {
    const before = currentConfigById.get(configId);
    if (before === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu config ${configId} was not found.`);
    const removedAssets = [...nodeDeletes.map((node) => node.nodeId), ...bindingDeletes.map((binding) => binding.bindingId)];
    return deepFreeze({
        plan: deepFreeze({
            configId,
            before: before.config,
            removedAssets: sampledCountSample(removedAssets),
            revokedGrants: sampledCountSample([]),
            affectedRoles: sampledCountSample([]),
            affectedUsers: sampledCountSample([]),
        }) satisfies MenuConfigRemovePlan,
        result: deepFreeze({
            configId,
            removedAssets: sampledCountSample(removedAssets),
            revokedGrantCount: 0,
        }) satisfies MenuConfigRemoveResult,
    });
}

export function createConfigChangeAuditPlan(input: {
    readonly changes: readonly MenuConfigChange[];
    readonly targetAggregateDigest: string;
    readonly manifestSummary: BatchMutationSummary;
}) {
    return toPolicyValue({
        operation: "menus.config.changeSet",
        changes: input.changes.map((change) => change.operation === "save"
            ? { operation: "save", configId: normalizeRbacId(change.config.configId, "config.configId"), digest: digestCanonical(change.config) }
            : { operation: "remove", configId: change.configId }),
        targetAggregateDigest: input.targetAggregateDigest,
        manifestSummary: input.manifestSummary,
    });
}

export function configChangeRevisionEntities(input: {
    readonly scopeKey: string;
    readonly scopeRevision: number;
    readonly operations: readonly ConfigChangeOperation[];
    readonly currentConfigById: ReadonlyMap<string, Readonly<InternalMenuConfigDocument>>;
}) {
    return [
        { kind: "scope" as const, id: input.scopeKey, revision: input.scopeRevision },
        ...input.operations.flatMap((operation) => {
            const configId = operation.operation === "save" ? operation.config.configId : operation.configId;
            const current = input.currentConfigById.get(configId);
            return current === undefined ? [] : [{ kind: "menu-config" as const, id: configId, revision: current.configRevision }];
        }),
    ];
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}
