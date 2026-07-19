import { types as utilTypes } from "node:util";
import type { PermissionScope } from "../types";
import { PermissionCoreError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { digestCanonical, canonicalString, compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { normalizeScope, createScopeKey } from "../scope/scope";
import {
    assertInternalDocumentBudget,
    type InternalRoleDocument,
    type InternalRoleRuleDocument,
    type InternalRoleRuleSource,
    type InternalUserRoleSetDocument,
} from "../persistence/documents";
import { normalizePermissionRuleAction } from "../policy/action";
import { normalizeRowCondition } from "../policy/condition";
import {
    assertNonNegativeSafeInteger,
    assertPositiveSafeInteger,
    normalizeDescription,
    normalizeRbacId,
    normalizeRoleLabel,
} from "./validation";

const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const MAX_RULE_SOURCES = 1024;
export const MAX_ROLE_MENU_AGGREGATE_COUNT = 20_000;
const ROLE_FIELDS = new Set([
    "scopeKey", "scope", "roleId", "label", "description", "status", "parentId", "revision",
    "menuGrantCount", "menuGrantDigest", "menuSourceCount", "menuSourceDigest", "createdAt", "updatedAt",
]);
const RULE_FIELDS = new Set([
    "scopeKey", "scope", "roleId", "effect", "action", "resource", "where", "semanticKey", "sources",
    "revision", "createdAt", "updatedAt",
]);
const USER_ROLE_FIELDS = new Set([
    "scopeKey", "scope", "userId", "roleIds", "revision", "createdAt", "updatedAt",
]);

export interface InternalUserRoleSetView {
    readonly scopeKey: string;
    readonly scope: Readonly<PermissionScope>;
    readonly userId: string;
    readonly roleIds: readonly string[];
    readonly revision: number;
    readonly persisted: boolean;
    readonly createdAt?: number;
    readonly updatedAt?: number;
}

function persistedInvalid(reason: string, cause?: unknown): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted RBAC state is malformed.", {
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
        if (typeof key !== "string") {
            persistedInvalid(`${kind} cannot contain symbol keys`);
        }
        if (key !== "_id" && !allowed.has(key)) {
            persistedInvalid(`${kind} contains unexpected field ${key}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            persistedInvalid(`${kind}.${key} must be an enumerable data property`);
        }
        if (key !== "_id") {
            snapshot[key] = descriptor.value;
        }
    }
    return snapshot;
}

function validateBase(
    raw: Record<string, unknown>,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
    kind: string,
) {
    if (raw.scopeKey !== expectedScopeKey) {
        persistedInvalid(`${kind}.scopeKey does not match the requested scope`);
    }
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
    if (updatedAt < createdAt) {
        persistedInvalid(`${kind}.updatedAt precedes createdAt`);
    }
    return { scope, createdAt, updatedAt };
}

function persistedId(value: unknown, field: string) {
    try {
        const normalized = normalizeRbacId(value, field);
        if (normalized !== value) {
            persistedInvalid(`${field} is not canonical`);
        }
        return normalized;
    } catch (error) {
        if (error instanceof PermissionCoreError && error.code === "PERSISTED_STATE_INVALID") {
            throw error;
        }
        persistedInvalid(`${field} is invalid`, error);
    }
}

function persistedPositiveInteger(value: unknown, field: string) {
    try {
        return assertPositiveSafeInteger(value, field);
    } catch (error) {
        persistedInvalid(`${field} is invalid`, error);
    }
}

function persistedNonNegativeInteger(value: unknown, field: string) {
    try {
        return assertNonNegativeSafeInteger(value, field);
    } catch (error) {
        persistedInvalid(`${field} is invalid`, error);
    }
}

function persistedDigest(value: unknown, field: string) {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
        persistedInvalid(`${field} must be a canonical digest`);
    }
    return value;
}

function denseArray(value: unknown, field: string, max: number) {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        persistedInvalid(`${field} must be a dense array`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value as number : -1;
    if (!Number.isSafeInteger(length) || length < 0 || length > max) {
        persistedInvalid(`${field} exceeds its persisted item limit`);
    }
    const snapshot = new Array<unknown>(length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") {
            continue;
        }
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            persistedInvalid(`${field} contains a non-index property`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            persistedInvalid(`${field}[${key}] is not an enumerable data property`);
        }
        snapshot[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== length) {
        persistedInvalid(`${field} cannot be sparse`);
    }
    return snapshot;
}

function materializeSource(raw: unknown, semanticKey: string, ruleEffect: "allow" | "deny") {
    const record = snapshotDocument(raw, new Set([
        "sourceId", "kind", "grantId", "grantRevision", "effect", "contribution", "assetId",
        "apiBindingId", "dataResource",
    ]), "role-rule-source");
    if (record.kind === "manual") {
        const keys = Object.keys(record).sort(compareUtf8);
        if (canonicalString(keys) !== canonicalString(["kind", "sourceId"])) {
            persistedInvalid("manual role-rule source contains provenance fields");
        }
        if (record.sourceId !== `manual:${semanticKey}`) {
            persistedInvalid("manual role-rule source identity is invalid");
        }
        return deepFreeze({ sourceId: record.sourceId, kind: "manual" }) as InternalRoleRuleSource;
    }
    if (record.kind !== "menu") {
        persistedInvalid("role-rule source kind is invalid");
    }

    const grantId = persistedId(record.grantId, "role-rule-source.grantId");
    const assetId = persistedId(record.assetId, "role-rule-source.assetId");
    const grantRevision = persistedPositiveInteger(record.grantRevision, "role-rule-source.grantRevision");
    if (record.effect !== ruleEffect || (record.effect !== "allow" && record.effect !== "deny")) {
        persistedInvalid("menu role-rule source effect does not match its semantic rule");
    }
    if (record.contribution !== "node" && record.contribution !== "api" && record.contribution !== "data") {
        persistedInvalid("menu role-rule source contribution is invalid");
    }
    const apiBindingId = record.apiBindingId === undefined
        ? undefined
        : persistedId(record.apiBindingId, "role-rule-source.apiBindingId");
    const dataResource = record.dataResource;
    if (
        (record.contribution === "node" && (apiBindingId !== undefined || dataResource !== undefined))
        || (record.contribution === "api" && (apiBindingId === undefined || dataResource !== undefined))
        || (record.contribution === "data" && (apiBindingId !== undefined || typeof dataResource !== "string"))
    ) {
        persistedInvalid("menu role-rule source contribution fields are inconsistent");
    }
    const normalizedDataResource = typeof dataResource === "string" ? dataResource : undefined;
    const expectedSourceId = createMenuSourceId({
        grantId,
        semanticKey,
        contribution: record.contribution,
        assetId,
        ...(apiBindingId === undefined ? {} : { apiBindingId }),
        ...(normalizedDataResource === undefined ? {} : { dataResource: normalizedDataResource }),
    });
    if (record.sourceId !== expectedSourceId) {
        persistedInvalid("menu role-rule source identity is invalid");
    }
    return deepFreeze({
        sourceId: expectedSourceId,
        kind: "menu",
        grantId,
        grantRevision,
        effect: ruleEffect,
        contribution: record.contribution,
        assetId,
        ...(apiBindingId === undefined ? {} : { apiBindingId }),
        ...(normalizedDataResource === undefined ? {} : { dataResource: normalizedDataResource }),
    }) as InternalRoleRuleSource;
}

export function createMenuSourceId(input: {
    readonly grantId: string;
    readonly semanticKey: string;
    readonly contribution: "node" | "api" | "data";
    readonly assetId: string;
    readonly apiBindingId?: string;
    readonly dataResource?: string;
}) {
    return `source_${digestCanonical(input)}`;
}

export function materializeRoleDocument(
    value: unknown,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
): Readonly<InternalRoleDocument> {
    const raw = snapshotDocument(value, ROLE_FIELDS, "role");
    const base = validateBase(raw, expectedScope, expectedScopeKey, "role");
    const roleId = persistedId(raw.roleId, "role.roleId");
    let label: string;
    let description: string | undefined;
    try {
        label = normalizeRoleLabel(raw.label, "role.label");
        if (label !== raw.label) {
            persistedInvalid("role.label is not canonical");
        }
        if (Object.hasOwn(raw, "description") && raw.description === undefined) {
            persistedInvalid("role.description cannot be persisted as undefined");
        }
        description = raw.description === undefined ? undefined : normalizeDescription(raw.description, "role.description");
    } catch (error) {
        if (error instanceof PermissionCoreError && error.code === "PERSISTED_STATE_INVALID") {
            throw error;
        }
        persistedInvalid("role label or description is invalid", error);
    }
    if (raw.status !== "enabled" && raw.status !== "disabled" && raw.status !== "deprecated") {
        persistedInvalid("role.status is invalid");
    }
    const parentId = raw.parentId === null ? null : persistedId(raw.parentId, "role.parentId");
    if (parentId === roleId) {
        persistedInvalid("role cannot be its own parent");
    }
    const menuGrantCount = persistedNonNegativeInteger(raw.menuGrantCount, "role.menuGrantCount");
    const menuGrantDigest = persistedDigest(raw.menuGrantDigest, "role.menuGrantDigest");
    const menuSourceCount = persistedNonNegativeInteger(raw.menuSourceCount, "role.menuSourceCount");
    const menuSourceDigest = persistedDigest(raw.menuSourceDigest, "role.menuSourceDigest");
    const emptyAggregateDigest = digestCanonical([]);
    if (
        menuGrantCount > MAX_ROLE_MENU_AGGREGATE_COUNT
        || menuSourceCount > MAX_ROLE_MENU_AGGREGATE_COUNT
        || (menuGrantCount === 0) !== (menuGrantDigest === emptyAggregateDigest)
        || (menuSourceCount === 0) !== (menuSourceDigest === emptyAggregateDigest)
    ) {
        persistedInvalid("role menu aggregates violate their count/digest contract");
    }
    const role: InternalRoleDocument = {
        scopeKey: expectedScopeKey,
        scope: base.scope,
        roleId,
        label,
        ...(description === undefined ? {} : { description }),
        status: raw.status,
        parentId,
        revision: persistedPositiveInteger(raw.revision, "role.revision"),
        menuGrantCount,
        menuGrantDigest,
        menuSourceCount,
        menuSourceDigest,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
    };
    try {
        assertInternalDocumentBudget(role);
    } catch (error) {
        persistedInvalid("role document budget is invalid", error);
    }
    return deepFreeze(role);
}

export function materializeRoleRuleDocument(
    value: unknown,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
    resourceSchemes: ResourceSchemeRegistry,
): Readonly<InternalRoleRuleDocument> {
    const raw = snapshotDocument(value, RULE_FIELDS, "role-rule");
    const base = validateBase(raw, expectedScope, expectedScopeKey, "role-rule");
    const roleId = persistedId(raw.roleId, "role-rule.roleId");
    if (raw.effect !== "allow" && raw.effect !== "deny") {
        persistedInvalid("role-rule.effect is invalid");
    }
    const effect = raw.effect;
    let action: string;
    let resource: string;
    let where: ReturnType<typeof normalizeRowCondition> | undefined;
    try {
        action = normalizePermissionRuleAction(raw.action);
        resourceSchemes.validate(raw.resource as string, "pattern");
        resource = raw.resource as string;
        if (Object.hasOwn(raw, "where") && raw.where === undefined) {
            persistedInvalid("role-rule.where cannot be persisted as undefined");
        }
        where = raw.where === undefined ? undefined : normalizeRowCondition(raw.where);
    } catch (error) {
        persistedInvalid("role-rule action, resource, or condition is invalid", error);
    }
    const semanticKey = digestCanonical({
        effect,
        action,
        resource,
        ...(where === undefined ? {} : { where }),
    });
    if (raw.semanticKey !== semanticKey) {
        persistedInvalid("role-rule semanticKey does not match its canonical rule");
    }
    const sourceValues = denseArray(raw.sources, "role-rule.sources", MAX_RULE_SOURCES);
    if (sourceValues.length < 1) {
        persistedInvalid("role-rule must retain at least one source");
    }
    const sources = sourceValues.map((source) => materializeSource(source, semanticKey, effect));
    const sourceIds = new Set<string>();
    for (const source of sources) {
        if (sourceIds.has(source.sourceId)) {
            persistedInvalid("role-rule contains duplicate sourceId values");
        }
        sourceIds.add(source.sourceId);
    }
    const rule: InternalRoleRuleDocument = {
        scopeKey: expectedScopeKey,
        scope: base.scope,
        roleId,
        effect,
        action,
        resource,
        ...(where === undefined ? {} : { where }),
        semanticKey,
        sources: Object.freeze(sources),
        revision: persistedPositiveInteger(raw.revision, "role-rule.revision"),
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
    };
    try {
        assertInternalDocumentBudget(rule);
    } catch (error) {
        persistedInvalid("role-rule document budget is invalid", error);
    }
    return deepFreeze(rule);
}

export function materializeUserRoleSetDocument(
    value: unknown,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
): InternalUserRoleSetView {
    const raw = snapshotDocument(value, USER_ROLE_FIELDS, "user-role-set");
    const base = validateBase(raw, expectedScope, expectedScopeKey, "user-role-set");
    const userId = persistedId(raw.userId, "user-role-set.userId");
    const values = denseArray(raw.roleIds, "user-role-set.roleIds", 128);
    const roleIds = values.map((value) => persistedId(value, "user-role-set.roleIds"));
    const canonicalRoleIds = [...new Set(roleIds)].sort(compareUtf8);
    if (canonicalString(roleIds) !== canonicalString(canonicalRoleIds)) {
        persistedInvalid("user-role-set.roleIds must be sorted and unique");
    }
    const document: InternalUserRoleSetDocument = {
        scopeKey: expectedScopeKey,
        scope: base.scope,
        userId,
        roleIds: Object.freeze(roleIds),
        revision: persistedPositiveInteger(raw.revision, "user-role-set.revision"),
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
    };
    try {
        assertInternalDocumentBudget(document);
    } catch (error) {
        persistedInvalid("user-role-set document budget is invalid", error);
    }
    return deepFreeze({ ...document, persisted: true });
}

export function createVirtualUserRoleSet(
    scope: Readonly<PermissionScope>,
    scopeKey: string,
    userId: string,
): InternalUserRoleSetView {
    return deepFreeze({
        scopeKey,
        scope,
        userId,
        roleIds: Object.freeze([]),
        revision: 0,
        persisted: false,
    });
}

export function createSemanticKey(
    effect: "allow" | "deny",
    action: string,
    resource: string,
    where?: ReturnType<typeof normalizeRowCondition>,
) {
    return digestCanonical({ effect, action, resource, ...(where === undefined ? {} : { where }) });
}
