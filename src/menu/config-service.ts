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
    MenuManifestInput,
    MutationResult,
    NonEmptyMenuConfigChangeArray,
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
} from "../rbac/mutation-executor";
import {
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

function responseInputFromSnapshot(response: NonNullable<MenuConfigSnapshot["menus"][number]["views"][number]["load"][number]["response"]>) {
    return {
        ...(response.target === undefined ? {} : { target: response.target }),
        ...(response.preserve === undefined ? {} : { preserve: response.preserve }),
        fields: response.fields.map(({ fieldId: _fieldId, ...field }) => field),
    };
}

function configInputFromSnapshot(snapshot: MenuConfigSnapshot): MenuConfigInput {
    const menuInput = (menu: MenuConfigSnapshot["menus"][number]): MenuConfigInput["menus"][number] => ({
        id: menu.id,
        title: menu.title,
        ...(menu.children.length === 0 ? {} : { children: menu.children.map(menuInput) }),
        ...(menu.views.length === 0 ? {} : { views: menu.views.map((view) => ({
            id: view.id,
            type: view.type,
            title: view.title,
            ...(view.path === undefined ? {} : { path: view.path }),
            ...(view.component === undefined ? {} : { component: view.component }),
            ...(view.url === undefined ? {} : { url: view.url }),
            navigation: view.navigation,
            enabled: view.enabled,
            ...(view.i18nKey === undefined ? {} : { i18nKey: view.i18nKey }),
            ...(view.load.length === 0 ? {} : { load: view.load.map((load) => ({
                resource: load.resource,
                ...(load.response === undefined ? {} : { response: responseInputFromSnapshot(load.response) }),
                ...(load.meta === undefined ? {} : { meta: load.meta }),
            })) }),
            ...(view.actions.length === 0 ? {} : { actions: view.actions.map((action) => ({
                ...(action.id === undefined ? {} : { id: action.id }),
                title: action.title,
                resource: action.resource,
                ...(action.opens === undefined ? {} : { opens: action.opens }),
                ...(action.response === undefined ? {} : { response: responseInputFromSnapshot(action.response) }),
                enabled: action.enabled,
                ...(action.i18nKey === undefined ? {} : { i18nKey: action.i18nKey }),
                ...(action.meta === undefined ? {} : { meta: action.meta }),
            })) }),
            ...(view.meta === undefined ? {} : { meta: view.meta }),
        })) }),
        navigation: menu.navigation,
        enabled: menu.enabled,
        ...(menu.icon === undefined ? {} : { icon: menu.icon }),
        ...(menu.i18nKey === undefined ? {} : { i18nKey: menu.i18nKey }),
        ...(menu.meta === undefined ? {} : { meta: menu.meta }),
    });
    return {
        configId: snapshot.configId,
        ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
        menus: snapshot.menus.map(menuInput),
        ...(snapshot.meta === undefined ? {} : { meta: snapshot.meta }),
    };
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
    const rawConfig = raw.config as MenuConfigSnapshot;
    let normalized: MenuConfigSnapshot;
    try {
        const input = configInputFromSnapshot(rawConfig);
        normalized = normalizeMenuConfigInput(input, { revision: configRevision, createdAt, updatedAt });
    } catch (error) {
        persistedInvalid("menu-config.config is invalid", error);
    }
    if (normalized.configId !== configId) persistedInvalid("menu-config.configId differs from its snapshot");
    if (canonicalString(rawConfig) !== canonicalString(normalized)) {
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
    assertInternalDocumentBudget(document);
    return deepFreeze(document);
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
        const collection = (repository.collections as typeof repository.collections & {
            readonly menuConfigs?: typeof repository.collections.menuConfigs;
        }).menuConfigs;
        if (collection === undefined) {
            if ((reader.state.menuConfigCount ?? 0) !== 0 || (reader.state.menuConfigBytes ?? 0) !== 0) {
                persistedInvalid("scope references menu configs but the config collection is unavailable");
            }
            return Object.freeze(result);
        }
        while (result.length <= 1_000) {
            const filter = after === undefined
                ? { scopeKey: reader.state.scopeKey }
                : { scopeKey: reader.state.scopeKey, configId: { $gt: after } };
            const rows = await collection.find(filter, readOptions(session))
                .sort({ configId: 1 })
                .limit(pageSize)
                .toArray();
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

    private normalizeOperations(changes: readonly MenuConfigChange[], now: number) {
        return changes.map((change): ConfigChangeOperation => {
            if (change.operation === "remove") return { operation: "remove", configId: change.configId };
            return {
                operation: "save",
                config: compileMenuConfigInput(change.config, { revision: 1, createdAt: now, updatedAt: now }, this.schemes),
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
        session?: MongoSession,
    ): Promise<PreparedConfigPlan> {
        const operations = this.normalizeOperations(changes, issuedAt);
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
            return this.planChangeSet(reader, changes, issuedAt, method, transaction.session);
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
                const prepared = await this.planChangeSet(reader, changes, now, previewMethod, transaction.session);
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
