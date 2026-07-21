import type { MongoSession } from "monsqlize";
import type {
    BatchMutationSummary,
    BoundedDetails,
    CountSample,
    ImpactPreview,
    ManagementConflict,
    MenuConfigChange,
    MenuConfigChangeSetOptions,
    MenuConfigChangeSetPlan,
    MenuConfigChangeSetResult,
    MenuConfigInput,
    MenuConfigListQuery,
    MenuConfigPlan,
    MenuConfigPreviewOptions,
    MenuConfigRemoveOptions,
    MenuConfigRemovePlan,
    MenuConfigRemoveResult,
    MenuConfigSaveOptions,
    MenuConfigSaveResult,
    MenuConfigSnapshot,
    MenuConfigSummary,
    MenuActionInput,
    MenuConfigMenuInput,
    MenuLoadInput,
    MenuManagementChange,
    MenuManagementExecuteOptions,
    MenuManagementPlan,
    MenuManagementPlannedOperation,
    MenuManagementPreviewOptions,
    MenuManagementResult,
    MenuResponseOwnerRef,
    MenuResponseRemoveInput,
    MenuResponseSetInput,
    MenuViewInput,
    MenuManifestInput,
    MutationResult,
    NonEmptyMenuConfigChangeArray,
    NonEmptyMenuManagementChangeArray,
    PageResult,
    PermissionScope,
    PolicyValue,
    PreviewExecutionOptions,
    RequiredRevisionVectorOptions,
    VersionedResult,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalByteLength, canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { SignedTokenCodec } from "../internal/signed-token";
import {
    assertAuditChangeBudget,
    assertInternalDocumentBudget,
    type InternalApiBindingDocument,
    type InternalMenuConfigDocument,
    type InternalMenuNodeDocument,
} from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import { mapDatabaseReadError, type PermissionRepository } from "../persistence/repository";
import {
    ManagementMutationExecutor,
    type CacheInvalidator,
    type NormalizedMutationOptions,
    normalizeMutationOptions,
} from "../rbac/mutation-executor";
import {
    type NormalizedPreviewExecutionOptions,
    type NormalizedPreviewOptions,
    normalizeMenuPreviewExecutionOptions,
    normalizePreviewOptions,
} from "../rbac/preview-inputs";
import {
    DetailBudgetAllocator,
    assertAuthorizationResponseBudget,
    revisionVector,
} from "../rbac/result";
import { normalizeRbacId } from "../rbac/validation";
import { createScopeKey } from "../scope/scope";
import {
    aggregateCompiledMenuConfigs,
    type CompiledScopeMenuTarget,
} from "./config-aggregate";
import { configInputFromSnapshot } from "./config-draft";
import {
    compileMenuConfigInput,
    compileMenuConfigSnapshot,
    normalizeMenuConfigInput,
    type CompiledMenuConfig,
} from "./config-compiler";
import { sampledCountSample } from "./impact-support";
import {
    apiBindingDocumentFromInput,
    apiBindingManifestItemFromDocument,
    materializeApiBindingDocument,
    materializeMenuNodeDocument,
    menuNodeDocumentFromInput,
    menuNodeManifestItemFromDocument,
} from "./materialize";
import {
    buildMenuPreview,
    emptyBatchCounts,
    expectedMenuRevisions,
    menuPlanHash,
    sortBatchMutationSamples,
    validateMenuExecution,
    type PreparedMenuPlan,
} from "./mutations";
import { readNestedDuplicate, revisionConflict } from "./api-mutations";
import { MAX_API_BINDINGS, MAX_MENU_NODES, MenuReadStore, MenuScopeReader } from "./store";
import { decodeBatchMutationSummaryReplay } from "./views";
import { denseMenuArray, exactMenuRecord } from "./validation";

const CURSOR_TTL_MS = 15 * 60 * 1_000;
const CURSOR_MAX_BYTES = 8 * 1024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const MAX_CONFIG_CHANGES = 100;
const CONFIG_MUTATION_LIMIT = 1_000;
const MENU_MANAGEMENT_EXECUTE_OPTION_KEYS = [
    "actorId",
    "reason",
    "requestId",
    "idempotencyKey",
    "expectedRevisions",
    "expectedRevision",
    "previewToken",
    "acknowledgeCapacityRisk",
] as const;

type NormalizedMenuManagementExecution =
    | { readonly mode: "auto"; readonly options: NormalizedMutationOptions }
    | { readonly mode: "strict"; readonly options: NormalizedPreviewExecutionOptions };

type ConfigChangeOperation =
    | { readonly operation: "save"; readonly config: CompiledMenuConfig }
    | { readonly operation: "remove"; readonly configId: string };

interface MenuConfigDocumentUpdate {
    readonly before: Readonly<InternalMenuConfigDocument>;
    readonly after: Readonly<InternalMenuConfigDocument>;
}

interface MenuDocumentUpdate<T> {
    readonly before: Readonly<T>;
    readonly after: Readonly<T>;
}

interface PreparedConfigPlan extends PreparedMenuPlan<MenuConfigChangeSetPlan> {
    readonly target: CompiledScopeMenuTarget;
    readonly configInserts: readonly Readonly<InternalMenuConfigDocument>[];
    readonly configUpdates: readonly MenuConfigDocumentUpdate[];
    readonly configDeletes: readonly Readonly<InternalMenuConfigDocument>[];
    readonly nodeInserts: readonly Readonly<InternalMenuNodeDocument>[];
    readonly nodeUpdates: readonly MenuDocumentUpdate<InternalMenuNodeDocument>[];
    readonly nodeDeletes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly bindingInserts: readonly Readonly<InternalApiBindingDocument>[];
    readonly bindingUpdates: readonly MenuDocumentUpdate<InternalApiBindingDocument>[];
    readonly bindingDeletes: readonly Readonly<InternalApiBindingDocument>[];
    readonly targetConfigs: readonly Readonly<InternalMenuConfigDocument>[];
    readonly targetNodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly targetBindings: readonly Readonly<InternalApiBindingDocument>[];
    readonly targetReplaceManifestBytes: number;
    readonly savePlans: readonly MenuConfigPlan[];
    readonly removePlans: readonly MenuConfigRemovePlan[];
    readonly changeResults: readonly (MenuConfigSaveResult | MenuConfigRemoveResult)[];
    readonly manifestSummary: BatchMutationSummary;
    readonly changedConfigId?: string;
}

interface ConfigCursorPayload {
    readonly method: "menus.config.list";
    readonly scopeKey: string;
    readonly queryHash: string;
    readonly menuRevision: number;
    readonly anchor: { readonly configId: string };
    readonly issuedAt: number;
    readonly expiresAt: number;
}

function readOptions(session?: MongoSession) {
    return { ...(session === undefined ? {} : { session }), cache: 0, collation: SIMPLE_COLLATION };
}

function insertOptions(session: MongoSession) {
    return { session, cache: { invalidate: false as const } };
}

function writeOptions(session: MongoSession) {
    return { session, cache: { invalidate: false as const }, collation: SIMPLE_COLLATION };
}

function normalizeMenuManagementExecutionOptions(value: MenuManagementExecuteOptions): NormalizedMenuManagementExecution {
    const record = exactMenuRecord(value ?? {}, MENU_MANAGEMENT_EXECUTE_OPTION_KEYS, "options");
    if (Object.hasOwn(record, "expectedRevision")) {
        throw validationError("INVALID_ARGUMENT", "options.expectedRevision", "is not supported for menu management execution");
    }
    const hasExpectedRevisions = Object.hasOwn(record, "expectedRevisions");
    const hasPreviewToken = Object.hasOwn(record, "previewToken");
    if (hasExpectedRevisions !== hasPreviewToken) {
        throw validationError("INVALID_ARGUMENT", "options", "requires expectedRevisions and previewToken together");
    }
    if (Object.hasOwn(record, "acknowledgeCapacityRisk") && !hasExpectedRevisions) {
        throw validationError("INVALID_ARGUMENT", "acknowledgeCapacityRisk", "requires explicit previewToken execution");
    }
    if (hasExpectedRevisions) {
        return {
            mode: "strict",
            options: normalizeMenuPreviewExecutionOptions(record as unknown as RequiredRevisionVectorOptions & PreviewExecutionOptions),
        };
    }
    const mutationRecord = Object.fromEntries(
        ["actorId", "reason", "requestId", "idempotencyKey"]
            .filter((key) => Object.hasOwn(record, key))
            .map((key) => [key, record[key]]),
    );
    return { mode: "auto", options: normalizeMutationOptions(mutationRecord) };
}

function previewOptionsFromMutation(options: NormalizedMutationOptions): NormalizedPreviewOptions {
    return {
        actorId: options.actorId,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    };
}

function hasExplicitRemoveRisk(change: MenuManagementChange) {
    switch (change.operation) {
        case "config.remove":
        case "menu.remove":
        case "view.remove":
        case "loadApi.remove":
        case "action.remove":
            return change.input?.cascade === true || change.input?.revokeGrants === true;
        case "response.remove":
            return change.input.revokeGrants === true;
        default:
            return false;
    }
}

function requiresExplicitManagementPreview(
    preview: ImpactPreview<MenuManagementPlan>,
    changes: readonly MenuManagementChange[],
) {
    return changes.some(hasExplicitRemoveRisk)
        || (preview.capacity !== null && preview.capacity.disposition !== "safe");
}

function menuManagementPreviewConflict(preview: ImpactPreview<MenuManagementPlan>) {
    return new PermissionCoreError(
        "MENU_MANAGEMENT_PREVIEW_CONFLICT",
        `Menu management changes for ${preview.plan.configId} require explicit preview confirmation.`,
        {
            details: {
                kind: "menu-management-preview-conflict",
                configId: preview.plan.configId,
                changeDigest: preview.plan.changeDigest,
                conflicts: preview.conflicts,
                warnings: preview.warnings,
                operations: preview.plan.operations,
            },
        },
    );
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function persistedInvalid(reason: string, cause?: unknown): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu config state is malformed.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The menu config write result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function positiveInteger(value: unknown, field: string) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        persistedInvalid(`${field} must be a positive safe integer`);
    }
    return value as number;
}

function nonNegativeInteger(value: unknown, field: string) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        persistedInvalid(`${field} must be a non-negative safe integer`);
    }
    return value as number;
}

function exactPersistedMenuConfigDocument(value: unknown) {
    const allowed = new Set([
        "_id",
        "scopeKey",
        "scope",
        "configId",
        "title",
        "config",
        "configDigest",
        "aggregateDigest",
        "configRevision",
        "menuCount",
        "viewCount",
        "actionCount",
        "apiCount",
        "responseFieldCount",
        "responseFieldOwnerCount",
        "configBytes",
        "compiledMenuNodeCount",
        "compiledApiBindingCount",
        "compiledManifestBytes",
        "createdAt",
        "updatedAt",
    ]);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        persistedInvalid("menu-config must be a plain document");
    }
    const record = value as Record<string, unknown>;
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(record)) {
        if (typeof key !== "string" || !allowed.has(key)) {
            persistedInvalid(`menu-config contains unexpected field ${String(key)}`);
        }
        if (key === "_id") continue;
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            persistedInvalid(`menu-config.${key} must be an enumerable defined data property`);
        }
        snapshot[key] = descriptor.value;
    }
    return snapshot;
}

export function materializeMenuConfigDocument(
    value: unknown,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
    schemes: ResourceSchemeRegistry,
): Readonly<InternalMenuConfigDocument> {
    const raw = exactPersistedMenuConfigDocument(value);
    if (raw.scopeKey !== expectedScopeKey) persistedInvalid("menu-config.scopeKey does not match the requested scope");
    if (canonicalString(raw.scope) !== canonicalString(expectedScope) || createScopeKey(raw.scope as PermissionScope) !== expectedScopeKey) {
        persistedInvalid("menu-config.scope is not canonical for the requested scope");
    }
    const configId = normalizeRbacId(raw.configId, "menu-config.configId");
    const createdAt = nonNegativeInteger(raw.createdAt, "menu-config.createdAt");
    const updatedAt = nonNegativeInteger(raw.updatedAt, "menu-config.updatedAt");
    if (updatedAt < createdAt) persistedInvalid("menu-config.updatedAt precedes createdAt");
    const configRevision = positiveInteger(raw.configRevision, "menu-config.configRevision");
    const normalized = normalizePersistedMenuConfigSnapshot(raw.config as MenuConfigSnapshot, configRevision, createdAt, updatedAt);
    if (normalized.configId !== configId) persistedInvalid("menu-config.configId differs from its snapshot");
    if (canonicalString(raw.config) !== canonicalString(normalized)) {
        persistedInvalid("menu-config.config is not canonical");
    }
    const compiled = compileMenuConfigSnapshot(normalized, schemes);
    const configBytes = canonicalByteLength(normalized);
    const document: InternalMenuConfigDocument = {
        scopeKey: expectedScopeKey,
        scope: expectedScope,
        configId,
        ...(normalized.title === undefined ? {} : { title: normalized.title }),
        config: normalized,
        configDigest: compiled.configDigest,
        aggregateDigest: raw.aggregateDigest as string,
        configRevision,
        menuCount: compiled.metrics.menuCount,
        viewCount: compiled.metrics.viewCount,
        actionCount: compiled.metrics.actionCount,
        apiCount: compiled.metrics.apiCount,
        responseFieldCount: compiled.metrics.responseFieldCount,
        responseFieldOwnerCount: compiled.metrics.responseFieldOwnerCount,
        configBytes,
        compiledMenuNodeCount: nonNegativeInteger(raw.compiledMenuNodeCount, "menu-config.compiledMenuNodeCount"),
        compiledApiBindingCount: nonNegativeInteger(raw.compiledApiBindingCount, "menu-config.compiledApiBindingCount"),
        compiledManifestBytes: nonNegativeInteger(raw.compiledManifestBytes, "menu-config.compiledManifestBytes"),
        createdAt,
        updatedAt,
    };
    assertMenuConfigDocumentMetrics(document, raw);
    assertInternalDocumentBudget(document);
    return deepFreeze(document);
}

function normalizePersistedMenuConfigSnapshot(
    rawConfig: MenuConfigSnapshot,
    revision: number,
    createdAt: number,
    updatedAt: number,
) {
    try {
        return normalizeMenuConfigInput(configInputFromSnapshot(rawConfig), {
            revision,
            createdAt,
            updatedAt,
            allowEmptyMenus: true,
            allowEmptyContainers: true,
        });
    } catch (error) {
        persistedInvalid("menu-config.config is invalid", error);
    }
}

function assertMenuConfigDocumentMetrics(
    document: Readonly<InternalMenuConfigDocument>,
    raw: ReturnType<typeof exactPersistedMenuConfigDocument>,
) {
    const numericFields = [
        "menuCount",
        "viewCount",
        "actionCount",
        "apiCount",
        "responseFieldCount",
        "responseFieldOwnerCount",
        "configBytes",
    ] as const;
    for (const field of numericFields) {
        if (document[field] !== raw[field]) persistedInvalid(`menu-config.${field} does not match its config snapshot`);
    }
    if (document.configDigest !== raw.configDigest) persistedInvalid("menu-config.configDigest does not match its config snapshot");
    if (typeof document.aggregateDigest !== "string" || document.aggregateDigest.length === 0) {
        persistedInvalid("menu-config.aggregateDigest is invalid");
    }
}

export async function readScopedMenuConfigDocuments(
    repository: PermissionRepository,
    schemes: ResourceSchemeRegistry,
    reader: MenuScopeReader,
    session?: MongoSession,
) {
    const result: Readonly<InternalMenuConfigDocument>[] = [];
    let after: string | undefined;
    const pageSize = Math.min(repository.findMaxLimit, 200);
    try {
        const collection = resolveMenuConfigCollection(repository, reader);
        if (collection === undefined) return Object.freeze(result);
        while (result.length <= 1_000) {
            const rows = await readMenuConfigPage(collection, reader.state.scopeKey, pageSize, after, session);
            if (!reader.state.persisted && rows.length > 0) {
                persistedInvalid("menu config documents exist without their owning scope state");
            }
            if (rows.length === 0) break;
            for (const row of rows) {
                const document = materializeMenuConfigDocument(row, reader.state.scope, reader.state.scopeKey, schemes);
                if (after !== undefined && compareUtf8(document.configId, after) <= 0) {
                    persistedInvalid("menu-config keyset did not advance");
                }
                after = document.configId;
                result.push(document);
                if (result.length > 1_000) persistedInvalid("menu config inventory exceeds the scope limit");
            }
            if (rows.length < pageSize) break;
        }
        if (result.length !== reader.state.menuConfigCount) {
            persistedInvalid("scope menuConfigCount does not match the config inventory");
        }
        const bytes = result.reduce((total, config) => total + config.configBytes, 0);
        if (bytes !== reader.state.menuConfigBytes) {
            persistedInvalid("scope menuConfigBytes does not match the config inventory");
        }
        return Object.freeze(result);
    } catch (error) {
        throw mapDatabaseReadError("The menu config inventory read failed.", error);
    }
}

function resolveMenuConfigCollection(repository: PermissionRepository, reader: MenuScopeReader) {
    const collection = (repository.collections as typeof repository.collections & {
        readonly menuConfigs?: typeof repository.collections.menuConfigs;
    }).menuConfigs;
    if (collection !== undefined) return collection;
    if ((reader.state.menuConfigCount ?? 0) !== 0 || (reader.state.menuConfigBytes ?? 0) !== 0) {
        persistedInvalid("scope references menu configs but the config collection is unavailable");
    }
    return undefined;
}

async function readMenuConfigPage(
    collection: PermissionRepository["collections"]["menuConfigs"],
    scopeKey: string,
    pageSize: number,
    after: string | undefined,
    session?: MongoSession,
) {
    const filter = after === undefined
        ? { scopeKey }
        : { scopeKey, configId: { $gt: after } };
    return collection.find(filter, readOptions(session))
        .sort({ configId: 1 })
        .limit(pageSize)
        .toArray();
}

export async function readScopedMenuConfigDocument(
    repository: PermissionRepository,
    schemes: ResourceSchemeRegistry,
    reader: MenuScopeReader,
    configId: string,
    session?: MongoSession,
) {
    try {
        const raw = await repository.collections.menuConfigs.findOne(
            { scopeKey: reader.state.scopeKey, configId },
            readOptions(session),
        );
        if (raw === null) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu config ${configId} was not found.`);
        return materializeMenuConfigDocument(raw, reader.state.scope, reader.state.scopeKey, schemes);
    } catch (error) {
        throw mapDatabaseReadError("The menu config read failed.", error);
    }
}

function nodeManifestEqual(
    left: Readonly<InternalMenuNodeDocument>,
    right: Readonly<InternalMenuNodeDocument>,
) {
    return canonicalString(menuNodeManifestItemFromDocument(left))
        === canonicalString(menuNodeManifestItemFromDocument(right));
}

function bindingManifestEqual(
    left: Readonly<InternalApiBindingDocument>,
    right: Readonly<InternalApiBindingDocument>,
) {
    return canonicalString(apiBindingManifestItemFromDocument(left))
        === canonicalString(apiBindingManifestItemFromDocument(right));
}

function configDocumentEqual(
    left: Readonly<InternalMenuConfigDocument>,
    right: Readonly<InternalMenuConfigDocument>,
) {
    const comparable = (document: Readonly<InternalMenuConfigDocument>) => ({
        config: document.config,
        configDigest: document.configDigest,
        menuCount: document.menuCount,
        viewCount: document.viewCount,
        actionCount: document.actionCount,
        apiCount: document.apiCount,
        responseFieldCount: document.responseFieldCount,
        responseFieldOwnerCount: document.responseFieldOwnerCount,
        configBytes: document.configBytes,
        compiledMenuNodeCount: document.compiledMenuNodeCount,
        compiledApiBindingCount: document.compiledApiBindingCount,
        compiledManifestBytes: document.compiledManifestBytes,
    });
    return canonicalString(comparable(left)) === canonicalString(comparable(right));
}

function configSummary(document: Readonly<InternalMenuConfigDocument>): MenuConfigSummary {
    return deepFreeze({
        configId: document.configId,
        ...(document.title === undefined ? {} : { title: document.title }),
        menuCount: document.menuCount,
        viewCount: document.viewCount,
        actionCount: document.actionCount,
        responseFieldCount: document.responseFieldCount,
        revision: document.configRevision,
        updatedAt: document.updatedAt,
    });
}

function configEtag(revision: number, queryHash: string) {
    return `W/"pc-menu-config-${revision}-${queryHash}"`;
}

function countSampleFromTotal(owner: string, total: number): CountSample {
    return deepFreeze({
        total,
        sampleIds: Object.freeze([]),
        truncated: total > 0,
        digest: digestCanonical({ owner, total }),
    });
}

function boundedChanges<T>(items: readonly T[]): BoundedDetails<T> {
    const budget = new DetailBudgetAllocator();
    return budget.bounded(items);
}

function decodeConfigSnapshotReplay(value: unknown): MenuConfigSnapshot {
    const record = exactMenuRecord(value, ["configId", "title", "menus", "revision", "aggregateDigest", "createdAt", "updatedAt", "meta"], "replay.menuConfig");
    const input = configInputFromSnapshot(record as unknown as MenuConfigSnapshot);
    const normalized = normalizeMenuConfigInput(input, {
        revision: positiveInteger(record.revision, "replay.menuConfig.revision"),
        createdAt: nonNegativeInteger(record.createdAt, "replay.menuConfig.createdAt"),
        updatedAt: nonNegativeInteger(record.updatedAt, "replay.menuConfig.updatedAt"),
    });
    if (canonicalString(record) !== canonicalString(normalized)) {
        throw new TypeError("Menu config replay snapshot is not canonical.");
    }
    return normalized;
}

function decodeConfigSaveResult(value: unknown): MenuConfigSaveResult {
    const record = exactMenuRecord(value, ["config", "manifestOperations", "retainedGrantCount", "revokedGrantCount"], "replay.menuConfigSave");
    return deepFreeze({
        config: decodeConfigSnapshotReplay(record.config),
        manifestOperations: decodeBatchMutationSummaryReplay(record.manifestOperations),
        retainedGrantCount: nonNegativeInteger(record.retainedGrantCount, "replay.menuConfigSave.retainedGrantCount"),
        revokedGrantCount: nonNegativeInteger(record.revokedGrantCount, "replay.menuConfigSave.revokedGrantCount"),
    });
}

function decodeConfigRemoveResult(value: unknown): MenuConfigRemoveResult {
    const record = exactMenuRecord(value, ["configId", "removedAssets", "revokedGrantCount"], "replay.menuConfigRemove");
    return deepFreeze({
        configId: normalizeRbacId(record.configId, "replay.menuConfigRemove.configId"),
        removedAssets: record.removedAssets as CountSample,
        revokedGrantCount: nonNegativeInteger(record.revokedGrantCount, "replay.menuConfigRemove.revokedGrantCount"),
    });
}

function decodeConfigChangeSetResult(value: unknown): MenuConfigChangeSetResult {
    const record = exactMenuRecord(value, ["changes", "manifestOperations"], "replay.menuConfigChangeSet");
    const changes = exactMenuRecord(record.changes, ["total", "items", "truncated", "digest"], "replay.menuConfigChangeSet.changes");
    const items = denseMenuArray(changes.items, "replay.menuConfigChangeSet.changes.items", 100)
        .map((item) => {
            const candidate = item as Record<string, unknown>;
            return Object.hasOwn(candidate, "config")
                ? decodeConfigSaveResult(item)
                : decodeConfigRemoveResult(item);
        });
    return deepFreeze({
        changes: {
            total: nonNegativeInteger(changes.total, "replay.menuConfigChangeSet.changes.total"),
            items,
            truncated: changes.truncated === true,
            digest: typeof changes.digest === "string" ? changes.digest : digestCanonical(items),
        },
        manifestOperations: decodeBatchMutationSummaryReplay(record.manifestOperations),
    });
}

function normalizeListQuery(value?: MenuConfigListQuery) {
    const record = exactMenuRecord(value ?? {}, ["first", "after", "configId"], "query");
    const first = Object.hasOwn(record, "first")
        ? record.first
        : PAGE_DEFAULT;
    if (!Number.isSafeInteger(first) || (first as number) < 1 || (first as number) > PAGE_MAX) {
        throw validationError("INVALID_ARGUMENT", "query.first", `must be an integer between 1 and ${PAGE_MAX}`);
    }
    return deepFreeze({
        first: first as number,
        ...(Object.hasOwn(record, "after") ? { after: typeof record.after === "string" ? record.after : invalidCursorType() } : {}),
        ...(Object.hasOwn(record, "configId") ? { configId: normalizeRbacId(record.configId, "query.configId") } : {}),
    });
}

function invalidCursorType(): never {
    throw new PermissionCoreError("INVALID_CURSOR", "query.after must be a string.", {
        details: { kind: "validation", field: "query.after", reason: "must be a string" },
    });
}

function normalizeChangeSet(changesInput: NonEmptyMenuConfigChangeArray | readonly MenuConfigChange[]) {
    const raw = denseMenuArray(changesInput, "changes", MAX_CONFIG_CHANGES);
    if (raw.length === 0) {
        throw validationError("INVALID_ARGUMENT", "changes", "must contain at least one change");
    }
    const normalized = raw.map((value, index): MenuConfigChange => {
        const record = exactMenuRecord(value, ["operation", "config", "configId"], `changes[${index}]`);
        if (record.operation === "save") {
            if (!Object.hasOwn(record, "config") || Object.hasOwn(record, "configId")) {
                throw validationError("INVALID_ARGUMENT", `changes[${index}]`, "save requires config and no configId");
            }
            return deepFreeze({ operation: "save", config: record.config as MenuConfigInput });
        }
        if (record.operation === "remove") {
            if (!Object.hasOwn(record, "configId") || Object.hasOwn(record, "config")) {
                throw validationError("INVALID_ARGUMENT", `changes[${index}]`, "remove requires configId and no config");
            }
            return deepFreeze({ operation: "remove", configId: normalizeRbacId(record.configId, `changes[${index}].configId`) });
        }
        throw validationError("INVALID_ARGUMENT", `changes[${index}].operation`, "must be save or remove");
    });
    const ids = normalized.map((change) => change.operation === "save" ? normalizeRbacId(change.config.configId, "config.configId") : change.configId);
    if (new Set(ids).size !== ids.length) {
        throw validationError("INVALID_ARGUMENT", "changes", "cannot contain duplicate configId values");
    }
    return deepFreeze(normalized.sort((left, right) => compareUtf8(
        left.operation === "save" ? normalizeRbacId(left.config.configId, "config.configId") : left.configId,
        right.operation === "save" ? normalizeRbacId(right.config.configId, "config.configId") : right.configId,
    )));
}

type MutableMenuConfigInput = Omit<MenuConfigInput, "menus"> & {
    menus: MutableMenuInput[];
};
type MutableMenuInput = Omit<MenuConfigMenuInput, "children" | "views"> & {
    children?: MutableMenuInput[];
    views?: MutableViewInput[];
};
type MutableViewInput = Omit<MenuViewInput, "load" | "actions"> & {
    load?: MutableLoadInput[];
    actions?: MutableActionInput[];
};
type MutableLoadInput = MenuLoadInput;
type MutableActionInput = MenuActionInput;

interface NormalizedManagementChangeSet {
    readonly configId: string;
    readonly changes: readonly MenuManagementChange[];
    readonly configChanges: readonly MenuConfigChange[];
    readonly operations: readonly MenuManagementPlannedOperation[];
    readonly changeDigest: string;
}

function mutableClone<T>(value: T): T {
    return JSON.parse(canonicalString(value)) as T;
}

function mutableConfigInputFromSnapshot(snapshot: MenuConfigSnapshot): MutableMenuConfigInput {
    return mutableClone(configInputFromSnapshot(snapshot)) as MutableMenuConfigInput;
}

function managementOperationTarget(change: MenuManagementChange) {
    switch (change.operation) {
        case "config.create":
            return change.input.configId;
        case "config.update":
        case "config.remove":
            return "config";
        case "menu.create":
            return change.input.id;
        case "menu.update":
        case "menu.remove":
            return change.menuId;
        case "view.create":
            return change.input.id;
        case "view.update":
        case "view.remove":
            return change.viewId;
        case "loadApi.add":
            return change.input.resource;
        case "loadApi.update":
        case "loadApi.remove":
            return change.resource;
        case "action.create":
            return change.input.id ?? change.input.resource;
        case "action.update":
        case "action.remove":
            return change.actionId;
        case "response.set":
            return responseOwnerTarget(change.input.owner);
        case "response.remove":
            return responseOwnerTarget(change.input.owner);
    }
}

function managementOutcome(operation: MenuManagementChange["operation"]): MenuManagementPlannedOperation["outcome"] {
    if (operation.endsWith(".create") || operation.endsWith(".add") || operation === "response.set") return "created";
    if (operation.endsWith(".remove")) return "removed";
    return "updated";
}

function responseOwnerTarget(owner: MenuResponseOwnerRef) {
    if (owner.ownerType === "load") return `${owner.viewId}:${owner.resource}`;
    if (owner.ownerType === "action") return `${owner.viewId}:${owner.actionId}`;
    return owner.apiResource;
}

function normalizeManagementChangeSetInput(
    configIdInput: string,
    changesInput: NonEmptyMenuManagementChangeArray | readonly MenuManagementChange[],
): { readonly configId: string; readonly changes: readonly MenuManagementChange[]; readonly operations: readonly MenuManagementPlannedOperation[]; readonly changeDigest: string } {
    const configId = normalizeRbacId(configIdInput, "configId");
    const raw = denseMenuArray(changesInput, "changes", MAX_CONFIG_CHANGES) as MenuManagementChange[];
    if (raw.length === 0) {
        throw validationError("INVALID_ARGUMENT", "changes", "must contain at least one change");
    }
    const changes = raw.map((change, index) => {
        const record = exactMenuRecord(change, [
            "operation", "input", "patch", "menuId", "viewId", "resource", "actionId",
        ], `changes[${index}]`);
        if (typeof record.operation !== "string") {
            throw validationError("INVALID_ARGUMENT", `changes[${index}].operation`, "must be a string");
        }
        return deepFreeze(change);
    });
    const configCreate = changes.filter((change) => change.operation === "config.create");
    if (configCreate.length > 1) {
        throw validationError("INVALID_ARGUMENT", "changes", "can contain at most one config.create");
    }
    if (changes.some((change) => change.operation === "config.remove") && changes.length > 1) {
        throw validationError("INVALID_ARGUMENT", "changes", "config.remove must be the only change in the set");
    }
    const operations = changes.map((change) => deepFreeze({
        operation: change.operation,
        targetId: managementOperationTarget(change),
        outcome: managementOutcome(change.operation),
    }) satisfies MenuManagementPlannedOperation);
    return deepFreeze({
        configId,
        changes,
        operations: Object.freeze(operations),
        changeDigest: digestCanonical({ configId, changes }),
    });
}

function emptyConfigDraft(input: MenuManagementChange & { operation: "config.create" }, configId: string): MutableMenuConfigInput {
    const create = exactMenuRecord(input.input, ["configId", "title", "meta"], "changes.config.create.input");
    const inputConfigId = normalizeRbacId(create.configId, "changes.config.create.input.configId");
    if (inputConfigId !== configId) {
        throw validationError("INVALID_ARGUMENT", "changes.config.create.input.configId", "must match the target configId");
    }
    return mutableClone({
        configId,
        ...(Object.hasOwn(create, "title") ? { title: create.title } : {}),
        menus: [],
        ...(Object.hasOwn(create, "meta") ? { meta: create.meta } : {}),
    }) as MutableMenuConfigInput;
}

function updateConfigDraft(draft: MutableMenuConfigInput, patch: MenuManagementChange & { operation: "config.update" }) {
    for (const [key, value] of Object.entries(patch.patch)) {
        if (value === null) delete (draft as unknown as Record<string, unknown>)[key];
        else (draft as unknown as Record<string, unknown>)[key] = value;
    }
}

function findMenuDraft(menus: MutableMenuInput[], menuId: string): MutableMenuInput | undefined {
    for (const menu of menus) {
        if (menu.id === menuId) return menu;
        const found = findMenuDraft(menu.children ?? [], menuId);
        if (found !== undefined) return found;
    }
    return undefined;
}

function removeMenuDraft(menus: MutableMenuInput[], menuId: string, cascade: boolean): boolean {
    const index = menus.findIndex((menu) => menu.id === menuId);
    if (index >= 0) {
        const menu = menus[index]!;
        const hasChildren = (menu.children?.length ?? 0) > 0 || (menu.views?.length ?? 0) > 0;
        if (hasChildren && !cascade) {
            throw validationError("INVALID_ARGUMENT", "changes.menu.remove.input.cascade", "is required when removing a non-empty menu");
        }
        menus.splice(index, 1);
        return true;
    }
    return menus.some((menu) => removeMenuDraft(menu.children ?? [], menuId, cascade));
}

function allViewsInDraft(menus: readonly MutableMenuInput[], output: MutableViewInput[] = []) {
    for (const menu of menus) {
        output.push(...(menu.views ?? []));
        allViewsInDraft(menu.children ?? [], output);
    }
    return output;
}

function findViewDraft(draft: MutableMenuConfigInput, viewId: string): MutableViewInput | undefined {
    return allViewsInDraft(draft.menus).find((view) => view.id === viewId);
}

function removeViewDraft(menus: MutableMenuInput[], viewId: string): boolean {
    for (const menu of menus) {
        const views = menu.views ?? [];
        const index = views.findIndex((view) => view.id === viewId);
        if (index >= 0) {
            views.splice(index, 1);
            menu.views = views;
            return true;
        }
        if (removeViewDraft(menu.children ?? [], viewId)) return true;
    }
    return false;
}

function findActionDraft(view: MutableViewInput, actionId: string): MutableActionInput | undefined {
    return (view.actions ?? []).find((action) => action.id === actionId || action.resource === actionId);
}

function applyNullablePatch(target: Record<string, unknown>, patch: Readonly<Record<string, unknown>>) {
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete target[key];
        else target[key] = value;
    }
}

function applyResponseToOwner(draft: MutableMenuConfigInput, input: MenuResponseSetInput) {
    const setResponse = (owner: { resource: string; response?: unknown }) => {
        if (!owner.resource.startsWith("api:")) {
            throw validationError("INVALID_ARGUMENT", "response.owner", "response fields can only be attached to API owners");
        }
        owner.response = input.response;
    };
    if (input.owner.ownerType === "load") {
        const resource = input.owner.resource;
        const view = findViewDraft(draft, input.owner.viewId);
        const load = view?.load?.find((candidate) => candidate.resource === resource);
        if (load === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", "The response owner load API was not found.");
        setResponse(load);
        return;
    }
    if (input.owner.ownerType === "action") {
        const view = findViewDraft(draft, input.owner.viewId);
        const action = view === undefined ? undefined : findActionDraft(view, input.owner.actionId);
        if (action === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", "The response owner action was not found.");
        setResponse(action);
        return;
    }
    let matched = 0;
    for (const view of allViewsInDraft(draft.menus)) {
        for (const load of view.load ?? []) {
            if (load.resource === input.owner.apiResource) {
                setResponse(load);
                matched += 1;
            }
        }
        for (const action of view.actions ?? []) {
            if (action.resource === input.owner.apiResource) {
                setResponse(action);
                matched += 1;
            }
        }
    }
    if (matched === 0) throw new PermissionCoreError("MENU_NOT_FOUND", "The response owner API was not found.");
}

function responseTargetMatches(response: unknown, target: string | undefined) {
    if (target === undefined) return true;
    if (response === null || typeof response !== "object" || Array.isArray(response)) return false;
    return (response as { target?: unknown }).target === target;
}

function removeResponseFromOwner(owner: { response?: unknown }, input: MenuResponseRemoveInput) {
    if (owner.response === undefined || !responseTargetMatches(owner.response, input.target)) return;
    if (input.fields === undefined) {
        delete owner.response;
        return;
    }
    if (owner.response === null || typeof owner.response !== "object" || Array.isArray(owner.response)) {
        delete owner.response;
        return;
    }
    const response = owner.response as { fields?: unknown };
    const fields = denseMenuArray(response.fields, "response.fields", 256)
        .filter((field) => {
            if (field === null || typeof field !== "object" || Array.isArray(field)) return true;
            const name = (field as { field?: unknown }).field;
            return typeof name !== "string" || !input.fields!.includes(name);
        });
    if (fields.length === 0) delete owner.response;
    else response.fields = fields;
}

function removeResponseByInput(draft: MutableMenuConfigInput, input: MenuResponseRemoveInput) {
    const removeFromLoad = (viewId: string, resource: string) => {
        const view = findViewDraft(draft, viewId);
        const load = view?.load?.find((candidate) => candidate.resource === resource);
        if (load === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", "The response owner load API was not found.");
        removeResponseFromOwner(load, input);
    };
    const removeFromAction = (viewId: string, actionId: string) => {
        const view = findViewDraft(draft, viewId);
        const action = view === undefined ? undefined : findActionDraft(view, actionId);
        if (action === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", "The response owner action was not found.");
        removeResponseFromOwner(action, input);
    };
    if (input.owner.ownerType === "load") {
        removeFromLoad(input.owner.viewId, input.owner.resource);
        return;
    }
    if (input.owner.ownerType === "action") {
        removeFromAction(input.owner.viewId, input.owner.actionId);
        return;
    }
    let matched = 0;
    for (const view of allViewsInDraft(draft.menus)) {
        for (const load of view.load ?? []) {
            if (load.resource === input.owner.apiResource) {
                removeResponseFromOwner(load, input);
                matched += 1;
            }
        }
        for (const action of view.actions ?? []) {
            if (action.resource === input.owner.apiResource) {
                removeResponseFromOwner(action, input);
                matched += 1;
            }
        }
    }
    if (matched === 0) throw new PermissionCoreError("MENU_NOT_FOUND", "The response owner API was not found.");
}

function applyMenuManagementChange(draft: MutableMenuConfigInput, change: Extract<MenuManagementChange, { operation: `menu.${string}` }>) {
    if (change.operation === "menu.create") {
        const { parentId, ...menu } = change.input;
        const created = mutableClone(menu) as MutableMenuInput;
        if (parentId === undefined || parentId === null) {
            draft.menus.push(created);
            return;
        }
        const parent = findMenuDraft(draft.menus, normalizeRbacId(parentId, "changes.menu.create.input.parentId"));
        if (parent === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu ${parentId} was not found.`);
        if ((parent.views?.length ?? 0) > 0) {
            throw validationError("INVALID_ARGUMENT", "changes.menu.create.input.parentId", "cannot add a child menu under a menu that already owns views");
        }
        parent.children = parent.children ?? [];
        parent.children.push(created);
        return;
    }
    if (change.operation === "menu.update") {
        const menu = findMenuDraft(draft.menus, normalizeRbacId(change.menuId, "changes.menu.update.menuId"));
        if (menu === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu ${change.menuId} was not found.`);
        applyNullablePatch(menu as unknown as Record<string, unknown>, change.patch as Readonly<Record<string, unknown>>);
        return;
    }
    const removed = removeMenuDraft(draft.menus, normalizeRbacId(change.menuId, "changes.menu.remove.menuId"), change.input?.cascade === true);
    if (!removed) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu ${change.menuId} was not found.`);
}

function applyViewManagementChange(draft: MutableMenuConfigInput, change: Extract<MenuManagementChange, { operation: `view.${string}` }>) {
    if (change.operation === "view.create") {
        const menu = findMenuDraft(draft.menus, normalizeRbacId(change.menuId, "changes.view.create.menuId"));
        if (menu === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu ${change.menuId} was not found.`);
        if ((menu.children?.length ?? 0) > 0) {
            throw validationError("INVALID_ARGUMENT", "changes.view.create.menuId", "cannot add a view under a menu that already owns child menus");
        }
        menu.views = menu.views ?? [];
        menu.views.push(mutableClone(change.input) as MutableViewInput);
        return;
    }
    if (change.operation === "view.update") {
        const view = findViewDraft(draft, normalizeRbacId(change.viewId, "changes.view.update.viewId"));
        if (view === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `View ${change.viewId} was not found.`);
        applyNullablePatch(view as unknown as Record<string, unknown>, change.patch as Readonly<Record<string, unknown>>);
        return;
    }
    const removed = removeViewDraft(draft.menus, normalizeRbacId(change.viewId, "changes.view.remove.viewId"));
    if (!removed) throw new PermissionCoreError("MENU_NOT_FOUND", `View ${change.viewId} was not found.`);
}

function applyLoadApiManagementChange(draft: MutableMenuConfigInput, change: Extract<MenuManagementChange, { operation: `loadApi.${string}` }>) {
    const view = findViewDraft(draft, normalizeRbacId(change.viewId, `changes.${change.operation}.viewId`));
    if (view === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `View ${change.viewId} was not found.`);
    if (change.operation === "loadApi.add") {
        view.load = view.load ?? [];
        view.load.push(mutableClone(change.input) as MutableLoadInput);
        return;
    }
    const loads = view.load;
    const index = loads?.findIndex((candidate) => candidate.resource === change.resource) ?? -1;
    if (loads === undefined || index < 0) throw new PermissionCoreError("MENU_NOT_FOUND", `Load ${change.resource} was not found.`);
    if (change.operation === "loadApi.update") {
        applyNullablePatch(loads[index]! as unknown as Record<string, unknown>, change.patch as Readonly<Record<string, unknown>>);
    } else {
        loads.splice(index, 1);
    }
}

function applyActionManagementChange(draft: MutableMenuConfigInput, change: Extract<MenuManagementChange, { operation: `action.${string}` }>) {
    const view = findViewDraft(draft, normalizeRbacId(change.viewId, `changes.${change.operation}.viewId`));
    if (view === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `View ${change.viewId} was not found.`);
    if (change.operation === "action.create") {
        view.actions = view.actions ?? [];
        view.actions.push(mutableClone(change.input) as MutableActionInput);
        return;
    }
    const actions = view.actions;
    const index = actions?.findIndex((action) => action.id === change.actionId || action.resource === change.actionId) ?? -1;
    if (actions === undefined || index < 0) throw new PermissionCoreError("MENU_NOT_FOUND", `Action ${change.actionId} was not found.`);
    if (change.operation === "action.update") {
        applyNullablePatch(actions[index]! as unknown as Record<string, unknown>, change.patch as Readonly<Record<string, unknown>>);
    } else {
        actions.splice(index, 1);
    }
}

function applyManagementChange(draft: MutableMenuConfigInput, change: MenuManagementChange) {
    switch (change.operation) {
        case "config.create":
        case "config.remove":
            return;
        case "config.update":
            return updateConfigDraft(draft, change);
        case "menu.create":
        case "menu.update":
        case "menu.remove":
            return applyMenuManagementChange(draft, change);
        case "view.create":
        case "view.update":
        case "view.remove":
            return applyViewManagementChange(draft, change);
        case "loadApi.add":
        case "loadApi.update":
        case "loadApi.remove":
            return applyLoadApiManagementChange(draft, change);
        case "action.create":
        case "action.update":
        case "action.remove":
            return applyActionManagementChange(draft, change);
        case "response.set":
            return applyResponseToOwner(draft, change.input);
        case "response.remove":
            return removeResponseByInput(draft, change.input);
    }
}

function decodeManagementResult(value: unknown): MenuManagementResult {
    return deepFreeze(value as MenuManagementResult);
}

function materializeTargetNodes(input: {
    readonly manifest: MenuManifestInput & { readonly schemaVersion: 2; readonly mode: "replace" };
    readonly current: readonly Readonly<InternalMenuNodeDocument>[];
    readonly scopeKey: string;
    readonly scope: Readonly<PermissionScope>;
    readonly now: number;
}) {
    const currentById = new Map(input.current.map((node) => [node.nodeId, node] as const));
    const groups = new Map<string | null, typeof input.manifest.nodes[number][]>();
    for (const node of input.manifest.nodes) {
        const parentId = node.parentId ?? null;
        const group = groups.get(parentId) ?? [];
        group.push(node);
        groups.set(parentId, group);
    }
    const denseOrder = new Map<string, number>();
    for (const group of groups.values()) {
        group.sort((left, right) => left.order - right.order || compareUtf8(left.id, right.id));
        group.forEach((node, order) => denseOrder.set(node.id, order));
    }
    return input.manifest.nodes.map((node) => {
        const current = currentById.get(node.id);
        const { order: _order, ...create } = node;
        const candidate = menuNodeDocumentFromInput(
            input.scopeKey,
            input.scope,
            {
                ...create,
                parentId: node.parentId ?? null,
                status: node.status ?? "enabled",
                hidden: node.hidden ?? false,
            },
            denseOrder.get(node.id)!,
            current === undefined ? 1 : current.revision + 1,
            current?.createdAt ?? input.now,
            input.now,
        );
        return current !== undefined && nodeManifestEqual(current, candidate) ? current : candidate;
    }).sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
}

function materializeTargetBindings(input: {
    readonly manifest: MenuManifestInput & { readonly schemaVersion: 2; readonly mode: "replace" };
    readonly current: readonly Readonly<InternalApiBindingDocument>[];
    readonly scopeKey: string;
    readonly scope: Readonly<PermissionScope>;
    readonly now: number;
}) {
    const currentById = new Map(input.current.map((binding) => [binding.bindingId, binding] as const));
    return input.manifest.apiBindings.map((binding) => {
        const current = currentById.get(binding.id);
        const candidate = apiBindingDocumentFromInput(
            input.scopeKey,
            input.scope,
            {
                ...binding,
                status: binding.status ?? "enabled",
                owners: binding.owners ?? [],
            },
            current === undefined ? 1 : current.revision + 1,
            current?.createdAt ?? input.now,
            input.now,
        );
        return current !== undefined && bindingManifestEqual(current, candidate) ? current : candidate;
    }).sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
}

function splitDocuments<T, TKey extends string>(
    current: readonly Readonly<T>[],
    target: readonly Readonly<T>[],
    key: (value: Readonly<T>) => TKey,
    equal: (left: Readonly<T>, right: Readonly<T>) => boolean,
) {
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

export class MenuConfigService {
    private readonly executor: ManagementMutationExecutor;
    private readonly store: MenuReadStore;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly tokens: SignedTokenCodec,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
        this.store = new MenuReadStore(repository, schemes);
    }

    private async readConfigs(reader: MenuScopeReader, session?: MongoSession) {
        return readScopedMenuConfigDocuments(this.repository, this.schemes, reader, session);
    }

    private buildConfigDocument(input: {
        readonly compiled: CompiledMenuConfig;
        readonly current?: Readonly<InternalMenuConfigDocument>;
        readonly aggregate: CompiledScopeMenuTarget;
        readonly now: number;
        readonly scope: Readonly<PermissionScope>;
        readonly scopeKey: string;
    }): Readonly<InternalMenuConfigDocument> {
        const revision = input.current === undefined ? 1 : input.current.configRevision + 1;
        const snapshot = normalizeMenuConfigInput(configInputFromSnapshot(input.compiled.snapshot), {
            revision,
            createdAt: input.current?.createdAt ?? input.now,
            updatedAt: input.now,
            allowEmptyMenus: true,
            allowEmptyContainers: true,
        });
        const compiled = compileMenuConfigSnapshot(snapshot, this.schemes);
        const document: InternalMenuConfigDocument = {
            scopeKey: input.scopeKey,
            scope: input.scope,
            configId: compiled.configId,
            ...(compiled.title === undefined ? {} : { title: compiled.title }),
            config: compiled.snapshot,
            configDigest: compiled.configDigest,
            aggregateDigest: input.aggregate.aggregateDigest,
            configRevision: revision,
            menuCount: compiled.metrics.menuCount,
            viewCount: compiled.metrics.viewCount,
            actionCount: compiled.metrics.actionCount,
            apiCount: compiled.metrics.apiCount,
            responseFieldCount: compiled.metrics.responseFieldCount,
            responseFieldOwnerCount: compiled.metrics.responseFieldOwnerCount,
            configBytes: compiled.metrics.configBytes,
            compiledMenuNodeCount: compiled.nodes.length,
            compiledApiBindingCount: input.aggregate.metrics.apiBindingCount,
            compiledManifestBytes: input.aggregate.metrics.compiledManifestBytes,
            createdAt: input.current?.createdAt ?? input.now,
            updatedAt: input.now,
        };
        assertInternalDocumentBudget(document);
        return deepFreeze(document);
    }

    private targetConfigs(input: {
        readonly changes: readonly ConfigChangeOperation[];
        readonly currentConfigs: readonly Readonly<InternalMenuConfigDocument>[];
        readonly now: number;
        readonly scope: Readonly<PermissionScope>;
        readonly scopeKey: string;
    }) {
        const currentById = new Map(input.currentConfigs.map((config) => [config.configId, config] as const));
        const changedConfigIds = new Set(input.changes.map((change) =>
            change.operation === "save" ? change.config.configId : change.configId));
        const candidate = new Map<string, CompiledMenuConfig>();
        for (const current of input.currentConfigs) {
            candidate.set(current.configId, compileMenuConfigSnapshot(current.config, this.schemes));
        }
        for (const change of input.changes) {
            if (change.operation === "save") {
                candidate.set(change.config.configId, change.config);
            } else {
                if (!candidate.has(change.configId)) {
                    throw new PermissionCoreError("MENU_NOT_FOUND", `Menu config ${change.configId} was not found.`);
                }
                candidate.delete(change.configId);
            }
        }
        const aggregate = aggregateCompiledMenuConfigs([...candidate.values()], this.schemes);
        const target = [...candidate.values()]
            .sort((left, right) => compareUtf8(left.configId, right.configId))
            .map((compiled) => {
                const current = currentById.get(compiled.configId);
                if (current !== undefined && !changedConfigIds.has(compiled.configId)) {
                    return current;
                }
                const provisional = this.buildConfigDocument({
                    compiled,
                    current,
                    aggregate,
                    now: input.now,
                    scope: input.scope,
                    scopeKey: input.scopeKey,
                });
                return current !== undefined && configDocumentEqual(current, provisional) ? current : provisional;
            });
        return deepFreeze({ aggregate, configs: Object.freeze(target) });
    }

    private normalizeOperations(changes: readonly MenuConfigChange[], now: number, allowEmptyDraft = false) {
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
                }, this.schemes),
            };
        });
    }

    private summarizeManifestOperations(input: {
        readonly configSplit: ReturnType<typeof splitDocuments<InternalMenuConfigDocument, string>>;
        readonly nodeSplit: ReturnType<typeof splitDocuments<InternalMenuNodeDocument, string>>;
        readonly bindingSplit: ReturnType<typeof splitDocuments<InternalApiBindingDocument, string>>;
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
        const summary: BatchMutationSummary = deepFreeze({
            inserted: input.configSplit.inserts.length + input.nodeSplit.inserts.length + input.bindingSplit.inserts.length,
            updated: input.configSplit.updates.length + input.nodeSplit.updates.length + input.bindingSplit.updates.length,
            unchanged: input.configSplit.unchanged.length + input.nodeSplit.unchanged.length + input.bindingSplit.unchanged.length,
            deleted: input.configSplit.deletes.length + input.nodeSplit.deletes.length + input.bindingSplit.deletes.length,
            conflicted: input.conflicts.length,
            samples: new DetailBudgetAllocator().bounded(sortBatchMutationSamples(samples)),
        });
        return summary;
    }

    private async planChangeSet(
        reader: MenuScopeReader,
        changes: readonly MenuConfigChange[],
        issuedAt: number,
        method: "menus.config.preview" | "menus.config.previewRemove" | "menus.config.previewChanges",
        allowEmptyDraft = false,
        session?: MongoSession,
    ): Promise<PreparedConfigPlan> {
        const operations = this.normalizeOperations(changes, issuedAt, allowEmptyDraft);
        const currentConfigs = await this.readConfigs(reader, session);
        const currentInventory = await reader.readCompleteInventory();
        const targetConfigState = this.targetConfigs({
            changes: operations,
            currentConfigs,
            now: issuedAt,
            scope: reader.state.scope,
            scopeKey: reader.state.scopeKey,
        });
        const targetNodes = materializeTargetNodes({
            manifest: targetConfigState.aggregate.manifest,
            current: currentInventory.nodes,
            scopeKey: reader.state.scopeKey,
            scope: reader.state.scope,
            now: issuedAt,
        });
        const targetBindings = materializeTargetBindings({
            manifest: targetConfigState.aggregate.manifest,
            current: currentInventory.bindings,
            scopeKey: reader.state.scopeKey,
            scope: reader.state.scope,
            now: issuedAt,
        });
        const configSplit = splitDocuments(
            currentConfigs,
            targetConfigState.configs,
            (config) => config.configId,
            configDocumentEqual,
        );
        const nodeSplit = splitDocuments(
            currentInventory.nodes,
            targetNodes,
            (node) => node.nodeId,
            nodeManifestEqual,
        );
        const bindingSplit = splitDocuments(
            currentInventory.bindings,
            targetBindings,
            (binding) => binding.bindingId,
            bindingManifestEqual,
        );
        const targetReplaceManifestBytes = canonicalByteLength({
            schemaVersion: 2,
            mode: "replace",
            nodes: targetNodes.map(menuNodeManifestItemFromDocument),
            apiBindings: targetBindings.map(apiBindingManifestItemFromDocument),
        });
        const conflicts: ManagementConflict[] = [];
        const mutationCount = configSplit.inserts.length
            + configSplit.updates.length
            + configSplit.deletes.length
            + nodeSplit.inserts.length
            + nodeSplit.updates.length
            + nodeSplit.deletes.length
            + bindingSplit.inserts.length
            + bindingSplit.updates.length
            + bindingSplit.deletes.length;
        if (mutationCount > CONFIG_MUTATION_LIMIT) {
            conflicts.push({
                id: "menu-config-mutation-capacity",
                code: "LIMIT_EXCEEDED",
                message: `Menu config change set requires ${mutationCount} document mutations; the atomic limit is ${CONFIG_MUTATION_LIMIT}.`,
            });
        }
        const manifestSummary = this.summarizeManifestOperations({ configSplit, nodeSplit, bindingSplit, conflicts });
        const currentConfigById = new Map(currentConfigs.map((config) => [config.configId, config] as const));
        const targetConfigById = new Map(targetConfigState.configs.map((config) => [config.configId, config] as const));
        const savePlans: MenuConfigPlan[] = [];
        const removePlans: MenuConfigRemovePlan[] = [];
        const changeResults: (MenuConfigSaveResult | MenuConfigRemoveResult)[] = [];
        for (const operation of operations) {
            if (operation.operation === "save") {
                const before = currentConfigById.get(operation.config.configId);
                const after = targetConfigById.get(operation.config.configId)!;
                const perConfigSummary = manifestSummary;
                savePlans.push(deepFreeze({
                    configId: operation.config.configId,
                    operation: "save",
                    ...(before === undefined ? {} : { before: before.config }),
                    after: after.config,
                    manifestOperations: sampledCountSample(perConfigSummary.samples.items.map((item) => `${item.outcome}:${item.id}`)),
                    affectedRoles: sampledCountSample([]),
                    affectedUsers: sampledCountSample([]),
                }));
                changeResults.push(deepFreeze({
                    config: after.config,
                    manifestOperations: perConfigSummary,
                    retainedGrantCount: 0,
                    revokedGrantCount: 0,
                }));
            } else {
                const before = currentConfigById.get(operation.configId);
                if (before === undefined) {
                    throw new PermissionCoreError("MENU_NOT_FOUND", `Menu config ${operation.configId} was not found.`);
                }
                const removedNodeIds = nodeSplit.deletes.map((node) => node.nodeId);
                const removedBindingIds = bindingSplit.deletes.map((binding) => binding.bindingId);
                removePlans.push(deepFreeze({
                    configId: operation.configId,
                    before: before.config,
                    removedAssets: sampledCountSample([...removedNodeIds, ...removedBindingIds]),
                    revokedGrants: sampledCountSample([]),
                    affectedRoles: sampledCountSample([]),
                    affectedUsers: sampledCountSample([]),
                }));
                changeResults.push(deepFreeze({
                    configId: operation.configId,
                    removedAssets: sampledCountSample([...removedNodeIds, ...removedBindingIds]),
                    revokedGrantCount: 0,
                }));
            }
        }
        const completePlan = toPolicyValue({
            operation: "menus.config.changeSet",
            changes: changes.map((change) => change.operation === "save"
                ? { operation: "save", configId: normalizeRbacId(change.config.configId, "config.configId"), digest: digestCanonical(change.config) }
                : { operation: "remove", configId: change.configId }),
            targetAggregateDigest: targetConfigState.aggregate.aggregateDigest,
            manifestSummary,
        });
        try {
            assertAuditChangeBudget({ kind: "menu-config", plan: completePlan });
        } catch (error) {
            if (!(error instanceof PermissionCoreError) || error.code !== "LIMIT_EXCEEDED") throw error;
            conflicts.push({
                id: "menu-config-audit-budget",
                code: "LIMIT_EXCEEDED",
                message: "The complete menu config audit diff exceeds its atomic byte budget.",
            });
        }
        const revisionEntities = [
            { kind: "scope" as const, id: reader.state.scopeKey, revision: reader.state.revision },
            ...operations.flatMap((operation) => {
                const configId = operation.operation === "save" ? operation.config.configId : operation.configId;
                const current = currentConfigById.get(configId);
                return current === undefined ? [] : [{ kind: "menu-config" as const, id: configId, revision: current.configRevision }];
            }),
        ];
        const expectedRevisions = expectedMenuRevisions(reader, revisionEntities, false);
        const inputHash = digestCanonical({ changes });
        const planHash = menuPlanHash(method, inputHash, expectedRevisions, completePlan);
        return {
            method,
            reader,
            inputHash,
            planHash,
            completePlan,
            publicPlan: (budget) => deepFreeze({
                changes: budget.bounded([...savePlans, ...removePlans].sort((left, right) => compareUtf8(left.configId, right.configId))),
                manifestOperations: sampledCountSample(manifestSummary.samples.items.map((item) => `${item.outcome}:${item.id}`)),
                affectedRoles: sampledCountSample([]),
                affectedUsers: sampledCountSample([]),
            }),
            expectedRevisions,
            revisionEntities,
            summaryCounts: emptyBatchCounts({
                inserted: manifestSummary.inserted,
                updated: manifestSummary.updated,
                unchanged: manifestSummary.unchanged,
                deleted: manifestSummary.deleted,
                conflicted: conflicts.length,
            }),
            summarySamples: manifestSummary.samples.items,
            warnings: Object.freeze([]),
            conflicts,
            capacity: null,
            target: targetConfigState.aggregate,
            configInserts: configSplit.inserts,
            configUpdates: configSplit.updates as MenuConfigDocumentUpdate[],
            configDeletes: configSplit.deletes,
            nodeInserts: nodeSplit.inserts,
            nodeUpdates: nodeSplit.updates,
            nodeDeletes: nodeSplit.deletes,
            bindingInserts: bindingSplit.inserts,
            bindingUpdates: bindingSplit.updates,
            bindingDeletes: bindingSplit.deletes,
            targetConfigs: targetConfigState.configs,
            targetNodes,
            targetBindings,
            targetReplaceManifestBytes,
            savePlans,
            removePlans,
            changeResults,
            manifestSummary,
            ...(operations.length === 1 ? {
                changedConfigId: operations[0]!.operation === "save"
                    ? operations[0]!.config.configId
                    : operations[0]!.configId,
            } : {}),
        };
    }

    private async buildPreview<TPlan>(
        scope: PermissionScope,
        changes: readonly MenuConfigChange[],
        optionsValue: MenuConfigPreviewOptions | undefined,
        method: "menus.config.preview" | "menus.config.previewRemove" | "menus.config.previewChanges",
        selectPlan: (prepared: PreparedConfigPlan) => PreparedMenuPlan<TPlan>,
    ) {
        const actor = normalizePreviewOptions(optionsValue);
        const issuedAt = await this.repository.getDatabaseTime();
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const reader = await this.store.open(scope, transaction.session);
            return this.planChangeSet(reader, changes, issuedAt, method, false, transaction.session);
        });
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared: selectPlan(prepared) });
    }

    private singlePlan<TPlan>(prepared: PreparedConfigPlan, plan: TPlan): PreparedMenuPlan<TPlan> {
        return {
            ...prepared,
            publicPlan: () => plan,
            method: prepared.method,
        };
    }

    async preview(
        scope: PermissionScope,
        config: MenuConfigInput,
        options?: MenuConfigPreviewOptions,
    ): Promise<ImpactPreview<MenuConfigPlan>> {
        return this.buildPreview(
            scope,
            [{ operation: "save", config }],
            options,
            "menus.config.preview",
            (prepared) => this.singlePlan(prepared, prepared.savePlans[0]!),
        );
    }

    async save(
        scope: PermissionScope,
        config: MenuConfigInput,
        options: MenuConfigSaveOptions,
    ): Promise<MutationResult<MenuConfigSaveResult>> {
        return this.executeChanges(
            scope,
            [{ operation: "save", config }],
            options,
            "menus.config.save",
            "update",
            "menu-config:*",
            (prepared) => prepared.changeResults[0] as MenuConfigSaveResult,
            decodeConfigSaveResult,
        );
    }

    async get(scope: PermissionScope, configIdInput: string): Promise<VersionedResult<MenuConfigSnapshot>> {
        const configId = normalizeRbacId(configIdInput, "configId");
        const reader = await this.store.open(scope);
        const document = await this.readConfig(reader, configId);
        await reader.verifyMenuUnchanged();
        const queryHash = digestCanonical({ method: "menus.config.get", configId });
        const result = deepFreeze({
            data: document.config,
            revision: document.configRevision,
            revisions: revisionVector(reader.state, [{ kind: "menu-config", id: configId, revision: document.configRevision }]),
            etag: configEtag(document.configRevision, queryHash),
            detailBudget: new DetailBudgetAllocator().finish([]),
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async list(scope: PermissionScope, queryInput?: MenuConfigListQuery): Promise<PageResult<MenuConfigSummary>> {
        const query = normalizeListQuery(queryInput);
        const reader = await this.store.open(scope);
        const queryHash = digestCanonical({ method: "menus.config.list", configId: query.configId ?? null, sortVersion: 1 });
        const cursor = this.readCursor(query.after, reader, queryHash);
        const base = query.configId === undefined
            ? { scopeKey: reader.state.scopeKey }
            : { scopeKey: reader.state.scopeKey, configId: query.configId };
        const filter = cursor === undefined
            ? base
            : { $and: [base, { configId: { $gt: cursor.anchor.configId } }] };
        let rows: Record<string, unknown>[];
        try {
            rows = await this.repository.collections.menuConfigs.find(filter, readOptions())
                .sort({ configId: 1 })
                .limit(query.first + 1)
                .toArray();
        } catch (error) {
            throw mapDatabaseReadError("The menu config page read failed.", error);
        }
        const documents = rows
            .map((row) => materializeMenuConfigDocument(row, reader.state.scope, reader.state.scopeKey, this.schemes));
        const selected = documents.slice(0, query.first);
        const hasNext = documents.length > query.first;
        const last = selected.at(-1);
        const endCursor = hasNext && last !== undefined ? this.writeCursor(reader, queryHash, { configId: last.configId }) : null;
        await reader.verifyMenuUnchanged();
        const result = deepFreeze({
            items: selected.map(configSummary),
            pageInfo: { hasNext, endCursor },
            revision: reader.state.menuRevision,
            revisions: revisionVector(reader.state),
            etag: configEtag(reader.state.menuRevision, queryHash),
            detailBudget: new DetailBudgetAllocator().finish([]),
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async previewRemove(
        scope: PermissionScope,
        configId: string,
        options?: MenuConfigPreviewOptions,
    ): Promise<ImpactPreview<MenuConfigRemovePlan>> {
        const normalized = normalizeRbacId(configId, "configId");
        return this.buildPreview(
            scope,
            [{ operation: "remove", configId: normalized }],
            options,
            "menus.config.previewRemove",
            (prepared) => this.singlePlan(prepared, prepared.removePlans[0]!),
        );
    }

    async remove(
        scope: PermissionScope,
        configId: string,
        options: MenuConfigRemoveOptions,
    ): Promise<MutationResult<MenuConfigRemoveResult>> {
        const normalized = normalizeRbacId(configId, "configId");
        return this.executeChanges(
            scope,
            [{ operation: "remove", configId: normalized }],
            options,
            "menus.config.remove",
            "remove",
            `menu-config:${normalized}`,
            (prepared) => prepared.changeResults[0] as MenuConfigRemoveResult,
            decodeConfigRemoveResult,
        );
    }

    async previewChanges(
        scope: PermissionScope,
        changesInput: NonEmptyMenuConfigChangeArray,
        options?: MenuConfigPreviewOptions,
    ): Promise<ImpactPreview<MenuConfigChangeSetPlan>> {
        const changes = normalizeChangeSet(changesInput);
        return this.buildPreview(
            scope,
            changes,
            options,
            "menus.config.previewChanges",
            (prepared) => prepared,
        );
    }

    async applyChanges(
        scope: PermissionScope,
        changesInput: NonEmptyMenuConfigChangeArray,
        options: MenuConfigChangeSetOptions,
    ): Promise<MutationResult<MenuConfigChangeSetResult>> {
        const changes = normalizeChangeSet(changesInput);
        return this.executeChanges(
            scope,
            changes,
            options,
            "menus.config.applyChanges",
            "replace",
            "menu-config:*",
            (prepared) => deepFreeze({
                changes: boundedChanges(prepared.changeResults),
                manifestOperations: prepared.manifestSummary,
            }),
            decodeConfigChangeSetResult,
        );
    }

    private async normalizeManagementChanges(
        reader: MenuScopeReader,
        configIdInput: string,
        changesInput: NonEmptyMenuManagementChangeArray,
        session?: MongoSession,
    ): Promise<NormalizedManagementChangeSet> {
        const normalized = normalizeManagementChangeSetInput(configIdInput, changesInput);
        if (normalized.changes[0]?.operation === "config.remove") {
            const current = await this.readExistingManagementConfig(reader, normalized.configId, session);
            if (current === null) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu config ${normalized.configId} was not found.`);
            return deepFreeze({
                ...normalized,
                configChanges: Object.freeze([{ operation: "remove", configId: normalized.configId } satisfies MenuConfigChange]),
            });
        }

        const draft = await this.buildManagementDraft(reader, normalized, session);
        return deepFreeze({
            ...normalized,
            configChanges: Object.freeze([{ operation: "save", config: draft } satisfies MenuConfigChange]),
        });
    }

    private async readExistingManagementConfig(
        reader: MenuScopeReader,
        configId: string,
        session?: MongoSession,
    ): Promise<MenuConfigSnapshot | null> {
        try {
            return (await this.readConfig(reader, configId, session)).config;
        } catch (error) {
            if (error instanceof PermissionCoreError && error.code === "MENU_NOT_FOUND") return null;
            throw error;
        }
    }

    private async buildManagementDraft(
        reader: MenuScopeReader,
        normalized: Readonly<Pick<NormalizedManagementChangeSet, "configId" | "changes">>,
        session?: MongoSession,
    ) {
        let draft: MutableMenuConfigInput | undefined;
        for (const change of normalized.changes) {
            if (change.operation === "config.create") {
                if (draft !== undefined) throw validationError("INVALID_ARGUMENT", "changes.config.create", "must be the first config change");
                const current = await this.readExistingManagementConfig(reader, normalized.configId, session);
                if (current !== null) throw new PermissionCoreError("MENU_ALREADY_EXISTS", `Menu config ${normalized.configId} already exists.`);
                draft = emptyConfigDraft(change, normalized.configId);
                continue;
            }
            if (draft === undefined) {
                const current = await this.readExistingManagementConfig(reader, normalized.configId, session);
                if (current === null) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu config ${normalized.configId} was not found.`);
                draft = mutableConfigInputFromSnapshot(current);
            }
            applyManagementChange(draft, change);
        }
        if (draft === undefined) throw validationError("INVALID_ARGUMENT", "changes", "must produce a config draft");
        return draft;
    }

    private managementPlan(
        prepared: PreparedConfigPlan,
        normalized: NormalizedManagementChangeSet,
        budget: DetailBudgetAllocator,
    ): MenuManagementPlan {
        const savePlan = prepared.savePlans.find((plan) => plan.configId === normalized.configId);
        const removePlan = prepared.removePlans.find((plan) => plan.configId === normalized.configId);
        const before = savePlan?.before ?? removePlan?.before;
        return deepFreeze({
            configId: normalized.configId,
            changeDigest: normalized.changeDigest,
            operations: budget.bounded(normalized.operations),
            ...(before === undefined ? {} : { before }),
            ...(savePlan === undefined ? {} : { after: savePlan.after }),
            manifestOperations: sampledCountSample(prepared.manifestSummary.samples.items.map((item) => `${item.outcome}:${item.id}`)),
            affectedRoles: sampledCountSample([]),
            affectedUsers: sampledCountSample([]),
            responseFieldImpacts: sampledCountSample(normalized.operations
                .filter((operation) => operation.operation.startsWith("response."))
                .map((operation) => operation.targetId)),
        });
    }

    private managementResult(prepared: PreparedConfigPlan, normalized: NormalizedManagementChangeSet): MenuManagementResult {
        const saveResult = prepared.changeResults.find((result): result is MenuConfigSaveResult =>
            "config" in result && result.config.configId === normalized.configId);
        const removeResult = prepared.changeResults.find((result): result is MenuConfigRemoveResult =>
            "configId" in result && result.configId === normalized.configId);
        return deepFreeze({
            configId: normalized.configId,
            ...(saveResult === undefined ? {} : { config: saveResult.config }),
            operations: prepared.manifestSummary,
            manifestOperations: prepared.manifestSummary,
            retainedGrantCount: saveResult?.retainedGrantCount ?? 0,
            refreshedGrantCount: 0,
            revokedGrantCount: saveResult?.revokedGrantCount ?? removeResult?.revokedGrantCount ?? 0,
            detachedResponseFieldCount: 0,
        });
    }

    async previewManagementChanges(
        scope: PermissionScope,
        configId: string,
        changesInput: NonEmptyMenuManagementChangeArray,
        options?: MenuManagementPreviewOptions,
    ): Promise<ImpactPreview<MenuManagementPlan>> {
        const actor = normalizePreviewOptions(options);
        const issuedAt = await this.repository.getDatabaseTime();
        let normalized: NormalizedManagementChangeSet | undefined;
        const prepared = await this.repository.withTransaction(async (transaction) => {
            const reader = await this.store.open(scope, transaction.session);
            normalized = await this.normalizeManagementChanges(reader, configId, changesInput, transaction.session);
            return this.planChangeSet(reader, normalized.configChanges, issuedAt, "menus.config.previewChanges", true, transaction.session);
        });
        const preparedManagement: PreparedMenuPlan<MenuManagementPlan> = {
            ...prepared,
            publicPlan: (budget) => this.managementPlan(prepared, normalized!, budget),
        };
        return buildMenuPreview({ tokens: this.tokens, actor, issuedAt, prepared: preparedManagement });
    }

    async applyManagementChanges(
        scope: PermissionScope,
        configId: string,
        changesInput: NonEmptyMenuManagementChangeArray,
        options: MenuManagementExecuteOptions,
    ): Promise<MutationResult<MenuManagementResult>> {
        const execution = normalizeMenuManagementExecutionOptions(options);
        if (execution.mode === "strict") {
            return this.applyManagementChangesStrict(scope, configId, changesInput, execution.options);
        }
        return this.executeManagementChangesAuto(scope, configId, changesInput, execution.options);
    }

    private executeManagementChangesAuto(
        scope: PermissionScope,
        configIdInput: string,
        changesInput: NonEmptyMenuManagementChangeArray,
        options: NormalizedMutationOptions,
    ): Promise<MutationResult<MenuManagementResult>> {
        const normalizedInput = normalizeManagementChangeSetInput(configIdInput, changesInput);
        return this.executor.execute({
            scope,
            operation: "menus.config.applyChanges",
            action: "replace",
            resource: "menu-config:*",
            request: toPolicyValue({ mode: "auto", configId: normalizedInput.configId, changes: normalizedInput.changes }),
            options,
            decodeReplay: decodeManagementResult,
            replayDetails: (data) => ({
                returned: data.operations.samples.items.length,
                total: data.operations.samples.total,
                tree: toPolicyValue(data),
            }),
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const normalized = await this.normalizeManagementChanges(
                    reader,
                    normalizedInput.configId,
                    normalizedInput.changes as NonEmptyMenuManagementChangeArray,
                    transaction.session,
                );
                const prepared = await this.planChangeSet(reader, normalized.configChanges, now, "menus.config.previewChanges", true, transaction.session);
                const preparedManagement: PreparedMenuPlan<MenuManagementPlan> = {
                    ...prepared,
                    publicPlan: (budget) => this.managementPlan(prepared, normalized, budget),
                };
                const preview = buildMenuPreview({
                    tokens: this.tokens,
                    actor: previewOptionsFromMutation(options),
                    issuedAt: now,
                    prepared: preparedManagement,
                });
                if (!preview.executable || requiresExplicitManagementPreview(preview, normalized.changes)) {
                    throw menuManagementPreviewConflict(preview);
                }
                const changed = prepared.configInserts.length > 0
                    || prepared.configUpdates.length > 0
                    || prepared.configDeletes.length > 0
                    || prepared.nodeInserts.length > 0
                    || prepared.nodeUpdates.length > 0
                    || prepared.nodeDeletes.length > 0
                    || prepared.bindingInserts.length > 0
                    || prepared.bindingUpdates.length > 0
                    || prepared.bindingDeletes.length > 0;
                const data = this.managementResult(prepared, normalized);
                const primaryEntity = {
                    kind: "scope" as const,
                    id: state.scopeKey,
                    before: state.revision,
                    after: state.revision + (changed ? 1 : 0),
                };
                if (!changed) {
                    return {
                        changed: false,
                        data,
                        primaryRevision: primaryEntity.after,
                        entity: primaryEntity,
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "menu-config-change-set", plan: prepared.completePlan },
                        cacheTargets: [],
                        validatedPlanHash: prepared.planHash,
                    };
                }
                await this.applyDocuments(prepared, transaction.session, reader);
                const [configCount, nodeCount, bindingCount] = await Promise.all([
                    this.repository.collections.menuConfigs.count({ scopeKey: state.scopeKey }, readOptions(transaction.session)),
                    this.repository.collections.menuNodes.count({ scopeKey: state.scopeKey }, readOptions(transaction.session)),
                    this.repository.collections.apiBindings.count({ scopeKey: state.scopeKey }, readOptions(transaction.session)),
                ]);
                if (
                    configCount !== prepared.targetConfigs.length
                    || nodeCount !== prepared.targetNodes.length
                    || bindingCount !== prepared.targetBindings.length
                ) {
                    databaseWriteFailure("menu config post-count differs from the compiled target inventory");
                }
                return {
                    changed: true,
                    data,
                    primaryRevision: primaryEntity.after,
                    entity: primaryEntity,
                    relatedEntities: prepared.configInserts.map((config) => ({
                        kind: "menu-config" as const,
                        id: config.configId,
                        before: 0,
                        after: config.configRevision,
                    })),
                    revisionImpact: { rbac: false, menu: true },
                    scopeAggregate: {
                        menuConfigCount: prepared.target.metrics.menuConfigCount,
                        menuConfigBytes: prepared.targetConfigs.reduce((total, config) => total + config.configBytes, 0),
                        menuNodeCount: prepared.target.metrics.menuNodeCount,
                        apiBindingCount: prepared.target.metrics.apiBindingCount,
                        responseFieldCount: prepared.target.metrics.responseFieldCount,
                        responseFieldOwnerCount: prepared.target.metrics.responseFieldOwnerCount,
                        replaceManifestBytes: prepared.targetReplaceManifestBytes,
                    },
                    change: { kind: "menu-config-change-set", plan: prepared.completePlan },
                    cacheTargets: [`scope:${state.scopeKey}:menu`],
                    validatedPlanHash: prepared.planHash,
                };
            },
        });
    }

    private async applyManagementChangesStrict(
        scope: PermissionScope,
        configId: string,
        changesInput: NonEmptyMenuManagementChangeArray,
        options: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    ): Promise<MutationResult<MenuManagementResult>> {
        const reader = await this.store.open(scope);
        const normalized = await this.normalizeManagementChanges(reader, configId, changesInput);
        await reader.verifyMenuUnchanged();
        return this.executeChanges(
            scope,
            normalized.configChanges,
            options,
            "menus.config.applyChanges",
            "replace",
            "menu-config:*",
            (prepared) => this.managementResult(prepared, normalized),
            decodeManagementResult,
            true,
        );
    }

    private async readConfig(reader: MenuScopeReader, configId: string, session?: MongoSession) {
        return readScopedMenuConfigDocument(this.repository, this.schemes, reader, configId, session);
    }

    private readCursor(token: string | undefined, reader: MenuScopeReader, queryHash: string): ConfigCursorPayload | undefined {
        if (token === undefined) return undefined;
        const payload = exactMenuRecord(
            this.tokens.decode(token, "pc:v2:manager-cursor", "INVALID_CURSOR", CURSOR_MAX_BYTES),
            ["method", "scopeKey", "queryHash", "menuRevision", "anchor", "issuedAt", "expiresAt"],
            "cursor",
        );
        const anchor = exactMenuRecord(payload.anchor, ["configId"], "cursor.anchor");
        const result: ConfigCursorPayload = {
            method: payload.method as "menus.config.list",
            scopeKey: payload.scopeKey as string,
            queryHash: payload.queryHash as string,
            menuRevision: payload.menuRevision as number,
            anchor: { configId: normalizeRbacId(anchor.configId, "cursor.anchor.configId") },
            issuedAt: payload.issuedAt as number,
            expiresAt: payload.expiresAt as number,
        };
        if (result.method !== "menus.config.list" || result.scopeKey !== reader.state.scopeKey || result.queryHash !== queryHash) {
            throw new PermissionCoreError("INVALID_CURSOR", "The menu config cursor does not match the current method, scope, or query.", {
                details: { kind: "validation", field: "cursor", reason: "method, scope, or query mismatch" },
            });
        }
        if (result.expiresAt - result.issuedAt !== CURSOR_TTL_MS || result.issuedAt > Date.now() || result.expiresAt <= Date.now()) {
            throw new PermissionCoreError("CURSOR_STALE", "The menu config cursor has expired.");
        }
        if (result.menuRevision !== reader.state.menuRevision) {
            throw new PermissionCoreError("CURSOR_STALE", "The menu config cursor is stale.", {
                details: { kind: "cursor-stale", owner: "scope.menu", expected: result.menuRevision, current: reader.state.menuRevision },
            });
        }
        return deepFreeze(result);
    }

    private writeCursor(reader: MenuScopeReader, queryHash: string, anchor: { readonly configId: string }) {
        const issuedAt = Date.now();
        return this.tokens.encode("pc:v2:manager-cursor", {
            method: "menus.config.list",
            scopeKey: reader.state.scopeKey,
            queryHash,
            menuRevision: reader.state.menuRevision,
            anchor,
            issuedAt,
            expiresAt: issuedAt + CURSOR_TTL_MS,
        });
    }

    private executeChanges<T>(
        scope: PermissionScope,
        changes: readonly MenuConfigChange[],
        optionsValue: RequiredRevisionVectorOptions & PreviewExecutionOptions,
        operation: "menus.config.save" | "menus.config.remove" | "menus.config.applyChanges",
        action: "remove" | "replace" | "update",
        resource: string,
        selectData: (prepared: PreparedConfigPlan) => T,
        decodeReplay: (value: unknown) => T,
        allowEmptyDraft = false,
    ) {
        const previewMethod = operation === "menus.config.save"
            ? "menus.config.preview" as const
            : operation === "menus.config.remove"
                ? "menus.config.previewRemove" as const
                : "menus.config.previewChanges" as const;
        const options = normalizeMenuPreviewExecutionOptions(optionsValue);
        return this.executor.execute({
            scope,
            operation,
            action,
            resource,
            request: toPolicyValue({ changes, expectedRevisions: options.expectedRevisions }),
            options,
            decodeReplay,
            replayDetails: (data) => ({
                returned: data === null || typeof data !== "object" || !("changes" in data) ? 0 : (data.changes as BoundedDetails<unknown>).items.length,
                total: data === null || typeof data !== "object" || !("changes" in data) ? 0 : (data.changes as BoundedDetails<unknown>).total,
                tree: toPolicyValue(data),
            }),
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const prepared = await this.planChangeSet(reader, changes, now, previewMethod, allowEmptyDraft, transaction.session);
                validateMenuExecution({ tokens: this.tokens, prepared, options, now });
                const changed = prepared.configInserts.length > 0
                    || prepared.configUpdates.length > 0
                    || prepared.configDeletes.length > 0
                    || prepared.nodeInserts.length > 0
                    || prepared.nodeUpdates.length > 0
                    || prepared.nodeDeletes.length > 0
                    || prepared.bindingInserts.length > 0
                    || prepared.bindingUpdates.length > 0
                    || prepared.bindingDeletes.length > 0;
                const data = selectData(prepared);
                let primaryEntity: {
                    readonly kind: "scope" | "menu-config";
                    readonly id: string;
                    readonly before: number;
                    readonly after: number;
                };
                if (operation === "menus.config.applyChanges" || prepared.changedConfigId === undefined) {
                    primaryEntity = {
                        kind: "scope",
                        id: state.scopeKey,
                        before: state.revision,
                        after: state.revision + (changed ? 1 : 0),
                    };
                } else {
                    const configId = prepared.changedConfigId;
                    const deleted = prepared.configDeletes.find((config) => config.configId === configId);
                    const updated = prepared.configUpdates.find((config) => config.before.configId === configId);
                    const inserted = prepared.configInserts.find((config) => config.configId === configId);
                    const before = deleted?.configRevision ?? updated?.before.configRevision ?? 0;
                    const after = updated?.after.configRevision
                        ?? inserted?.configRevision
                        ?? (deleted === undefined ? before : deleted.configRevision + (changed ? 1 : 0));
                    primaryEntity = { kind: "menu-config", id: configId, before, after };
                }
                if (!changed) {
                    return {
                        changed: false,
                        data,
                        primaryRevision: primaryEntity.after,
                        entity: primaryEntity,
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "menu-config-change-set", plan: prepared.completePlan },
                        cacheTargets: [],
                        validatedPlanHash: prepared.planHash,
                    };
                }
                await this.applyDocuments(prepared, transaction.session, reader);
                const [configCount, nodeCount, bindingCount] = await Promise.all([
                    this.repository.collections.menuConfigs.count({ scopeKey: state.scopeKey }, readOptions(transaction.session)),
                    this.repository.collections.menuNodes.count({ scopeKey: state.scopeKey }, readOptions(transaction.session)),
                    this.repository.collections.apiBindings.count({ scopeKey: state.scopeKey }, readOptions(transaction.session)),
                ]);
                if (
                    configCount !== prepared.targetConfigs.length
                    || nodeCount !== prepared.targetNodes.length
                    || bindingCount !== prepared.targetBindings.length
                ) {
                    databaseWriteFailure("menu config post-count differs from the compiled target inventory");
                }
                return {
                    changed: true,
                    data,
                    primaryRevision: primaryEntity.after,
                    entity: primaryEntity,
                    relatedEntities: operation === "menus.config.applyChanges"
                        ? prepared.configInserts.map((config) => ({ kind: "menu-config" as const, id: config.configId, before: 0, after: config.configRevision }))
                        : undefined,
                    revisionImpact: { rbac: false, menu: true },
                    scopeAggregate: {
                        menuConfigCount: prepared.target.metrics.menuConfigCount,
                        menuConfigBytes: prepared.targetConfigs.reduce((total, config) => total + config.configBytes, 0),
                        menuNodeCount: prepared.target.metrics.menuNodeCount,
                        apiBindingCount: prepared.target.metrics.apiBindingCount,
                        responseFieldCount: prepared.target.metrics.responseFieldCount,
                        responseFieldOwnerCount: prepared.target.metrics.responseFieldOwnerCount,
                        replaceManifestBytes: prepared.targetReplaceManifestBytes,
                    },
                    change: { kind: "menu-config-change-set", plan: prepared.completePlan },
                    cacheTargets: [`scope:${state.scopeKey}:menu`],
                    validatedPlanHash: prepared.planHash,
                };
            },
        });
    }

    private async applyDocuments(prepared: PreparedConfigPlan, session: MongoSession, reader: MenuScopeReader) {
        const removedBindings = [
            ...prepared.bindingDeletes,
            ...prepared.bindingUpdates.map((update) => update.before),
        ].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        for (const binding of removedBindings) {
            const result = await this.repository.collections.apiBindings.deleteOne(
                { scopeKey: binding.scopeKey, bindingId: binding.bindingId, revision: binding.revision },
                writeOptions(session),
            );
            if (result.deletedCount !== 1) revisionConflict(`api-binding:${binding.bindingId}`, binding.revision);
        }
        const removedNodes = [
            ...prepared.nodeDeletes,
            ...prepared.nodeUpdates.map((update) => update.before),
        ].sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
        for (const node of removedNodes) {
            const result = await this.repository.collections.menuNodes.deleteOne(
                { scopeKey: node.scopeKey, nodeId: node.nodeId, revision: node.revision },
                writeOptions(session),
            );
            if (result.deletedCount !== 1) revisionConflict(`menu-node:${node.nodeId}`, node.revision);
        }
        const removedConfigs = [
            ...prepared.configDeletes,
            ...prepared.configUpdates.map((update) => update.before),
        ].sort((left, right) => compareUtf8(left.configId, right.configId));
        for (const config of removedConfigs) {
            const result = await this.repository.collections.menuConfigs.deleteOne(
                { scopeKey: config.scopeKey, configId: config.configId, configRevision: config.configRevision },
                writeOptions(session),
            );
            if (result.deletedCount !== 1) revisionConflict(`menu-config:${config.configId}`, config.configRevision);
        }
        const insertedConfigs = [
            ...prepared.configInserts,
            ...prepared.configUpdates.map((update) => update.after),
        ].sort((left, right) => compareUtf8(left.configId, right.configId));
        for (const config of insertedConfigs) {
            try {
                const result = await this.repository.collections.menuConfigs.insertOne({ ...config }, insertOptions(session));
                if (result.acknowledged !== true) databaseWriteFailure(`menu config ${config.configId} insert was not acknowledged`);
            } catch (error) {
                if (readNestedDuplicate(error)) {
                    throw new PermissionCoreError("MENU_ALREADY_EXISTS", "The menu config conflicts with an existing config identity.", { cause: error });
                }
                throw error;
            }
        }
        const insertedNodes = [
            ...prepared.nodeInserts,
            ...prepared.nodeUpdates.map((update) => update.after),
        ].sort((left, right) => compareUtf8(left.nodeId, right.nodeId));
        for (const node of insertedNodes) {
            try {
                const result = await this.repository.collections.menuNodes.insertOne({ ...node }, insertOptions(session));
                if (result.acknowledged !== true) databaseWriteFailure(`menu node ${node.nodeId} insert was not acknowledged`);
            } catch (error) {
                if (readNestedDuplicate(error)) {
                    throw new PermissionCoreError("MENU_ALREADY_EXISTS", "The menu config conflicts with an existing menu identity, path, name, or sibling code.", { cause: error });
                }
                throw error;
            }
        }
        const insertedBindings = [
            ...prepared.bindingInserts,
            ...prepared.bindingUpdates.map((update) => update.after),
        ].sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
        for (const binding of insertedBindings) {
            try {
                const result = await this.repository.collections.apiBindings.insertOne({ ...binding }, insertOptions(session));
                if (result.acknowledged !== true) databaseWriteFailure(`API binding ${binding.bindingId} insert was not acknowledged`);
            } catch (error) {
                if (readNestedDuplicate(error)) {
                    throw new PermissionCoreError("API_BINDING_ALREADY_EXISTS", "The menu config conflicts with an existing API binding ID or endpoint.", { cause: error });
                }
                throw error;
            }
        }
        for (const config of prepared.configDeletes) {
            const post = await this.repository.collections.menuConfigs.findOne(
                { scopeKey: config.scopeKey, configId: config.configId },
                readOptions(session),
            );
            if (post !== null) databaseWriteFailure(`deleted menu config ${config.configId} is still visible in the transaction`);
        }
        for (const node of prepared.nodeDeletes) {
            if (await reader.readNode(node.nodeId) !== null) {
                databaseWriteFailure(`deleted menu node ${node.nodeId} is still visible in the transaction`);
            }
        }
        for (const binding of prepared.bindingDeletes) {
            if (await reader.readBinding(binding.bindingId) !== null) {
                databaseWriteFailure(`deleted API binding ${binding.bindingId} is still visible in the transaction`);
            }
        }
    }
}
