import type { MongoSession } from "monsqlize";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalByteLength, canonicalString, compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import {
    assertInternalDocumentBudget,
    type InternalMenuConfigDocument,
} from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import { mapDatabaseReadError, type PermissionRepository } from "../persistence/repository";
import { normalizeRbacId } from "../rbac/validation";
import { createScopeKey } from "../scope/scope";
import type { MenuConfigSnapshot, PermissionScope } from "../types";
import { configInputFromSnapshot } from "./config-draft";
import { compileMenuConfigSnapshot, normalizeMenuConfigInput } from "./config-compiler";
import type { MenuScopeReader } from "./store";

function readOptions(session?: MongoSession) {
    return { ...(session === undefined ? {} : { session }), cache: 0, collation: SIMPLE_COLLATION };
}

function persistedInvalid(reason: string, cause?: unknown): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu config state is malformed.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

export function positiveInteger(value: unknown, field: string) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        persistedInvalid(`${field} must be a positive safe integer`);
    }
    return value as number;
}

export function nonNegativeInteger(value: unknown, field: string) {
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
