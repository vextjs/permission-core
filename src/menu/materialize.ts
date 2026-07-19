import { types as utilTypes } from "node:util";
import type {
    ApiBinding,
    ApiBindingCreateInput,
    MenuManifestNodeInput,
    MenuNode,
    MenuNodeCreateInput,
    PermissionScope,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalByteLength, canonicalString } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import {
    assertInternalDocumentBudget,
    assertRoleMenuGrantBudget,
    type InternalApiBindingDocument,
    type InternalMenuNodeDocument,
    type InternalRoleMenuGrantDocument,
} from "../persistence/documents";
import { createScopeKey, normalizeScope } from "../scope/scope";
import {
    assertNonNegativeSafeInteger,
    assertPositiveSafeInteger,
    normalizeRbacId,
} from "../rbac/validation";
import {
    normalizeApiBindingCreateInput,
    normalizeMenuGrantIntent,
    normalizeMenuNodeCreateInput,
    normalizePersistedMenuGrantSnapshot,
} from "./validation";

const MENU_NODE_FIELDS = new Set([
    "scopeKey", "scope", "nodeId", "parentId", "type", "title", "path", "name", "code", "component",
    "url", "icon", "order", "status", "hidden", "i18nKey", "meta", "permission", "dataPermissions",
    "revision", "manifestItemBytes", "createdAt", "updatedAt",
]);
const API_BINDING_FIELDS = new Set([
    "scopeKey", "scope", "bindingId", "method", "path", "purpose", "authorization", "owners", "canonicalOwner",
    "status", "description", "revision", "manifestItemBytes", "createdAt", "updatedAt",
]);
const ROLE_MENU_GRANT_FIELDS = new Set([
    "scopeKey", "scope", "roleId", "grantId", "effect", "intent", "snapshot", "grantRevision", "createdAt", "updatedAt",
]);

function persistedInvalid(reason: string, cause?: unknown): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu state is malformed.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function snapshotDocument(raw: unknown, allowed: ReadonlySet<string>, kind: string) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || utilTypes.isProxy(raw)) {
        persistedInvalid(`${kind} must be a plain document`);
    }
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
        persistedInvalid(`${kind} must be a plain document`);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(raw)) {
        if (typeof key !== "string") persistedInvalid(`${kind} cannot contain symbol keys`);
        if (key !== "_id" && !allowed.has(key)) persistedInvalid(`${kind} contains unexpected field ${key}`);
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            persistedInvalid(`${kind}.${key} must be an enumerable defined data property`);
        }
        if (key !== "_id") snapshot[key] = descriptor.value;
    }
    return snapshot;
}

function baseDocument(
    raw: Readonly<Record<string, unknown>>,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
    kind: string,
) {
    if (raw.scopeKey !== expectedScopeKey) persistedInvalid(`${kind}.scopeKey does not match the requested scope`);
    let scope: Readonly<PermissionScope>;
    try {
        scope = normalizeScope(raw.scope as PermissionScope);
    } catch (error) {
        persistedInvalid(`${kind}.scope is invalid`, error);
    }
    if (
        createScopeKey(scope) !== expectedScopeKey
        || canonicalString(scope) !== canonicalString(expectedScope)
        || canonicalString(raw.scope) !== canonicalString(scope)
    ) {
        persistedInvalid(`${kind}.scope is not canonical for the requested scope`);
    }
    let createdAt: number;
    let updatedAt: number;
    try {
        createdAt = assertNonNegativeSafeInteger(raw.createdAt, `${kind}.createdAt`);
        updatedAt = assertNonNegativeSafeInteger(raw.updatedAt, `${kind}.updatedAt`);
    } catch (error) {
        persistedInvalid(`${kind} timestamps are invalid`, error);
    }
    if (updatedAt < createdAt) persistedInvalid(`${kind}.updatedAt precedes createdAt`);
    return { scope, createdAt, updatedAt };
}

function persistedId(value: unknown, field: string) {
    try {
        const normalized = normalizeRbacId(value, field);
        if (normalized !== value) persistedInvalid(`${field} is not canonical`);
        return normalized;
    } catch (error) {
        if (error instanceof PermissionCoreError && error.code === "PERSISTED_STATE_INVALID") throw error;
        persistedInvalid(`${field} is invalid`, error);
    }
}

function positiveInteger(value: unknown, field: string) {
    try {
        return assertPositiveSafeInteger(value, field);
    } catch (error) {
        persistedInvalid(`${field} is invalid`, error);
    }
}

function nonNegativeInteger(value: unknown, field: string) {
    try {
        return assertNonNegativeSafeInteger(value, field);
    } catch (error) {
        persistedInvalid(`${field} is invalid`, error);
    }
}

export function menuManifestNode(input: Readonly<MenuNodeCreateInput>, order: number): MenuManifestNodeInput {
    return deepFreeze({ ...input, order });
}

export function apiBindingManifestItem(input: Readonly<ApiBindingCreateInput>): ApiBindingCreateInput {
    return deepFreeze({ ...input });
}

export function menuNodeManifestItemFromDocument(
    document: Readonly<InternalMenuNodeDocument>,
): MenuManifestNodeInput {
    return deepFreeze({
        id: document.nodeId,
        parentId: document.parentId,
        type: document.type,
        title: document.title,
        ...(document.path === undefined ? {} : { path: document.path }),
        ...(document.name === undefined ? {} : { name: document.name }),
        ...(document.code === undefined ? {} : { code: document.code }),
        ...(document.component === undefined ? {} : { component: document.component }),
        ...(document.url === undefined ? {} : { url: document.url }),
        ...(document.icon === undefined ? {} : { icon: document.icon }),
        status: document.status,
        hidden: document.hidden,
        ...(document.i18nKey === undefined ? {} : { i18nKey: document.i18nKey }),
        ...(document.meta === undefined ? {} : { meta: document.meta }),
        ...(document.permission === undefined ? {} : { permission: document.permission }),
        ...(document.dataPermissions === undefined
            ? {}
            : { dataPermissions: document.dataPermissions as MenuManifestNodeInput["dataPermissions"] }),
        order: document.order,
    });
}

export function apiBindingManifestItemFromDocument(
    document: Readonly<InternalApiBindingDocument>,
): ApiBindingCreateInput {
    return deepFreeze({
        id: document.bindingId,
        method: document.method,
        path: document.path,
        purpose: document.purpose,
        authorization: document.authorization,
        owners: document.owners,
        ...(document.canonicalOwner === undefined ? {} : { canonicalOwner: document.canonicalOwner }),
        status: document.status,
        ...(document.description === undefined ? {} : { description: document.description }),
    });
}

export function menuNodeDocumentFromInput(
    scopeKey: string,
    scope: Readonly<PermissionScope>,
    input: ReturnType<typeof normalizeMenuNodeCreateInput>,
    order: number,
    revision: number,
    createdAt: number,
    updatedAt = createdAt,
): InternalMenuNodeDocument {
    const manifest = menuManifestNode(input, order);
    const document: InternalMenuNodeDocument = {
        scopeKey,
        scope,
        nodeId: input.id,
        parentId: input.parentId,
        type: input.type,
        title: input.title,
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.code === undefined ? {} : { code: input.code }),
        ...(input.component === undefined ? {} : { component: input.component }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        order,
        status: input.status,
        hidden: input.hidden,
        ...(input.i18nKey === undefined ? {} : { i18nKey: input.i18nKey }),
        ...(input.meta === undefined ? {} : { meta: input.meta }),
        ...(input.permission === undefined ? {} : { permission: input.permission }),
        ...(input.dataPermissions === undefined ? {} : { dataPermissions: input.dataPermissions }),
        revision,
        manifestItemBytes: canonicalByteLength(manifest),
        createdAt,
        updatedAt,
    };
    assertInternalDocumentBudget(document);
    return deepFreeze(document);
}

export function apiBindingDocumentFromInput(
    scopeKey: string,
    scope: Readonly<PermissionScope>,
    input: ReturnType<typeof normalizeApiBindingCreateInput>,
    revision: number,
    createdAt: number,
    updatedAt = createdAt,
): InternalApiBindingDocument {
    const manifest = apiBindingManifestItem(input);
    const document: InternalApiBindingDocument = {
        scopeKey,
        scope,
        bindingId: input.id,
        method: input.method,
        path: input.path,
        purpose: input.purpose,
        authorization: input.authorization,
        owners: input.owners,
        ...(input.canonicalOwner === undefined ? {} : { canonicalOwner: input.canonicalOwner }),
        status: input.status,
        ...(input.description === undefined ? {} : { description: input.description }),
        revision,
        manifestItemBytes: canonicalByteLength(manifest),
        createdAt,
        updatedAt,
    };
    assertInternalDocumentBudget(document);
    return deepFreeze(document);
}

export function materializeMenuNodeDocument(
    value: unknown,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
    schemes: ResourceSchemeRegistry,
): Readonly<InternalMenuNodeDocument> {
    const raw = snapshotDocument(value, MENU_NODE_FIELDS, "menu-node");
    const base = baseDocument(raw, expectedScope, expectedScopeKey, "menu-node");
    const nodeId = persistedId(raw.nodeId, "menu-node.nodeId");
    const parentId = raw.parentId === null ? null : persistedId(raw.parentId, "menu-node.parentId");
    if (parentId === nodeId) persistedInvalid("menu-node cannot be its own parent");
    const order = nonNegativeInteger(raw.order, "menu-node.order");
    let normalized: ReturnType<typeof normalizeMenuNodeCreateInput>;
    try {
        normalized = normalizeMenuNodeCreateInput({
            id: nodeId,
            parentId,
            type: raw.type as never,
            title: raw.title as string,
            ...(Object.hasOwn(raw, "path") ? { path: raw.path as string } : {}),
            ...(Object.hasOwn(raw, "name") ? { name: raw.name as string } : {}),
            ...(Object.hasOwn(raw, "code") ? { code: raw.code as string } : {}),
            ...(Object.hasOwn(raw, "component") ? { component: raw.component as string } : {}),
            ...(Object.hasOwn(raw, "url") ? { url: raw.url as string } : {}),
            ...(Object.hasOwn(raw, "icon") ? { icon: raw.icon as string } : {}),
            status: raw.status as never,
            hidden: raw.hidden as boolean,
            ...(Object.hasOwn(raw, "i18nKey") ? { i18nKey: raw.i18nKey as string } : {}),
            ...(Object.hasOwn(raw, "meta") ? { meta: raw.meta as never } : {}),
            ...(Object.hasOwn(raw, "permission") ? { permission: raw.permission as never } : {}),
            ...(Object.hasOwn(raw, "dataPermissions") ? { dataPermissions: raw.dataPermissions as never } : {}),
        }, schemes);
    } catch (error) {
        persistedInvalid("menu-node fields are invalid", error);
    }
    const rawManifest = {
        id: nodeId,
        parentId,
        type: raw.type,
        title: raw.title,
        ...(Object.hasOwn(raw, "path") ? { path: raw.path } : {}),
        ...(Object.hasOwn(raw, "name") ? { name: raw.name } : {}),
        ...(Object.hasOwn(raw, "code") ? { code: raw.code } : {}),
        ...(Object.hasOwn(raw, "component") ? { component: raw.component } : {}),
        ...(Object.hasOwn(raw, "url") ? { url: raw.url } : {}),
        ...(Object.hasOwn(raw, "icon") ? { icon: raw.icon } : {}),
        status: raw.status,
        hidden: raw.hidden,
        ...(Object.hasOwn(raw, "i18nKey") ? { i18nKey: raw.i18nKey } : {}),
        ...(Object.hasOwn(raw, "meta") ? { meta: raw.meta } : {}),
        ...(Object.hasOwn(raw, "permission") ? { permission: raw.permission } : {}),
        ...(Object.hasOwn(raw, "dataPermissions") ? { dataPermissions: raw.dataPermissions } : {}),
        order,
    };
    const manifest = menuManifestNode(normalized, order);
    if (canonicalString(rawManifest) !== canonicalString(manifest)) {
        persistedInvalid("menu-node fields are not canonical");
    }
    const manifestItemBytes = positiveInteger(raw.manifestItemBytes, "menu-node.manifestItemBytes");
    if (manifestItemBytes !== canonicalByteLength(manifest)) {
        persistedInvalid("menu-node.manifestItemBytes does not match its canonical manifest item");
    }
    const document = menuNodeDocumentFromInput(
        expectedScopeKey,
        base.scope,
        normalized,
        order,
        positiveInteger(raw.revision, "menu-node.revision"),
        base.createdAt,
        base.updatedAt,
    );
    if (document.manifestItemBytes !== manifestItemBytes) persistedInvalid("menu-node manifest bytes changed during materialization");
    return document;
}

export function materializeApiBindingDocument(
    value: unknown,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
    schemes: ResourceSchemeRegistry,
): Readonly<InternalApiBindingDocument> {
    const raw = snapshotDocument(value, API_BINDING_FIELDS, "api-binding");
    const base = baseDocument(raw, expectedScope, expectedScopeKey, "api-binding");
    const bindingId = persistedId(raw.bindingId, "api-binding.bindingId");
    let normalized: ReturnType<typeof normalizeApiBindingCreateInput>;
    try {
        normalized = normalizeApiBindingCreateInput({
            id: bindingId,
            method: raw.method as string,
            path: raw.path as string,
            purpose: raw.purpose as never,
            authorization: raw.authorization as never,
            owners: raw.owners as never,
            ...(Object.hasOwn(raw, "canonicalOwner") ? { canonicalOwner: raw.canonicalOwner as never } : {}),
            status: raw.status as never,
            ...(Object.hasOwn(raw, "description") ? { description: raw.description as string } : {}),
        }, schemes);
    } catch (error) {
        persistedInvalid("api-binding fields are invalid", error);
    }
    const rawManifest = {
        id: bindingId,
        method: raw.method,
        path: raw.path,
        purpose: raw.purpose,
        authorization: raw.authorization,
        owners: raw.owners,
        ...(Object.hasOwn(raw, "canonicalOwner") ? { canonicalOwner: raw.canonicalOwner } : {}),
        status: raw.status,
        ...(Object.hasOwn(raw, "description") ? { description: raw.description } : {}),
    };
    if (canonicalString(rawManifest) !== canonicalString(normalized)) {
        persistedInvalid("api-binding fields are not canonical");
    }
    const manifestItemBytes = positiveInteger(raw.manifestItemBytes, "api-binding.manifestItemBytes");
    if (manifestItemBytes !== canonicalByteLength(normalized)) {
        persistedInvalid("api-binding.manifestItemBytes does not match its canonical manifest item");
    }
    const document = apiBindingDocumentFromInput(
        expectedScopeKey,
        base.scope,
        normalized,
        positiveInteger(raw.revision, "api-binding.revision"),
        base.createdAt,
        base.updatedAt,
    );
    if (document.manifestItemBytes !== manifestItemBytes) persistedInvalid("api-binding manifest bytes changed during materialization");
    return document;
}

export function materializeRoleMenuGrantDocument(
    value: unknown,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
): Readonly<InternalRoleMenuGrantDocument> {
    const raw = snapshotDocument(value, ROLE_MENU_GRANT_FIELDS, "role-menu-grant");
    const base = baseDocument(raw, expectedScope, expectedScopeKey, "role-menu-grant");
    const roleId = persistedId(raw.roleId, "role-menu-grant.roleId");
    const grantId = persistedId(raw.grantId, "role-menu-grant.grantId");
    if (raw.effect !== "allow" && raw.effect !== "deny") {
        persistedInvalid("role-menu-grant.effect is invalid");
    }
    let intent: ReturnType<typeof normalizeMenuGrantIntent>;
    let snapshot: ReturnType<typeof normalizePersistedMenuGrantSnapshot>;
    try {
        intent = normalizeMenuGrantIntent(raw.intent);
        snapshot = normalizePersistedMenuGrantSnapshot(raw.snapshot);
    } catch (error) {
        persistedInvalid("role-menu-grant intent or snapshot is invalid", error);
    }
    if (canonicalString(raw.intent) !== canonicalString(intent)) {
        persistedInvalid("role-menu-grant.intent is not canonical");
    }
    if (canonicalString(raw.snapshot) !== canonicalString(snapshot)) {
        persistedInvalid("role-menu-grant.snapshot is not canonical");
    }
    const document: InternalRoleMenuGrantDocument = {
        scopeKey: expectedScopeKey,
        scope: base.scope,
        roleId,
        grantId,
        effect: raw.effect,
        intent,
        snapshot,
        grantRevision: positiveInteger(raw.grantRevision, "role-menu-grant.grantRevision"),
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
    };
    assertRoleMenuGrantBudget(document);
    assertInternalDocumentBudget(document);
    return deepFreeze(document);
}

export function menuNodeView(document: Readonly<InternalMenuNodeDocument>): MenuNode {
    return deepFreeze({
        id: document.nodeId,
        parentId: document.parentId,
        type: document.type,
        title: document.title,
        ...(document.path === undefined ? {} : { path: document.path }),
        ...(document.name === undefined ? {} : { name: document.name }),
        ...(document.code === undefined ? {} : { code: document.code }),
        ...(document.component === undefined ? {} : { component: document.component }),
        ...(document.url === undefined ? {} : { url: document.url }),
        ...(document.icon === undefined ? {} : { icon: document.icon }),
        order: document.order,
        status: document.status,
        hidden: document.hidden,
        ...(document.i18nKey === undefined ? {} : { i18nKey: document.i18nKey }),
        ...(document.meta === undefined ? {} : { meta: document.meta }),
        ...(document.permission === undefined ? {} : { permission: document.permission }),
        ...(document.dataPermissions === undefined ? {} : { dataPermissions: document.dataPermissions as MenuNode["dataPermissions"] }),
        revision: document.revision,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
    });
}

export function apiBindingView(document: Readonly<InternalApiBindingDocument>): ApiBinding {
    return deepFreeze({
        id: document.bindingId,
        method: document.method,
        path: document.path,
        purpose: document.purpose,
        authorization: document.authorization,
        owners: document.owners,
        ...(document.canonicalOwner === undefined ? {} : { canonicalOwner: document.canonicalOwner }),
        status: document.status,
        ...(document.description === undefined ? {} : { description: document.description }),
        revision: document.revision,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
    });
}
