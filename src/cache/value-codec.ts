import { types as utilTypes } from "node:util";
import type {
    BoundedDetails,
    ButtonPermissionState,
    MenuRuntimeApiRisk,
    MenuRuleSourceState,
    PermissionSubject,
    PolicyContext,
    ResponseDetailBudget,
    RoutePermissionState,
    RuleSourceView,
    SubjectRuntimeResult,
    VisibleMenuTreeNode,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import {
    canonicalByteLength,
    canonicalString,
    compareUtf8,
    digestCanonical,
} from "../internal/canonical";
import { clonePolicyRecord, deepFreeze } from "../internal/plain-data";
import { isWellFormedUnicode } from "../internal/unicode";
import type {
    InternalRoleDocument,
    InternalRoleRuleDocument,
} from "../persistence/documents";
import { normalizePermissionAction } from "../policy/action";
import {
    loadEffectiveAuthorization,
    type EffectiveAuthorizationState,
    type EffectiveAuthorizationReader,
} from "../rbac/effective";
import {
    createVirtualUserRoleSet,
    materializeRoleDocument,
    materializeRoleRuleDocument,
    materializeUserRoleSetDocument,
    type InternalUserRoleSetView,
} from "../rbac/materialize";
import { assertAuthorizationResponseBudget } from "../rbac/result";
import {
    MAX_EFFECTIVE_ROLES,
    MAX_EFFECTIVE_RULES,
    MAX_EFFECTIVE_SNAPSHOT_BYTES,
    MAX_EFFECTIVE_SOURCES,
} from "../rbac/store";
import { normalizeRbacId } from "../rbac/validation";
import { normalizeDeclaredPath } from "../menu/validation";

export const MAX_SEMANTIC_CACHE_VALUE_BYTES = 4 * 1024 * 1024;
export const SEMANTIC_CACHE_ENVELOPE_VERSION = 1 as const;

export type SemanticCacheFamily = "permissions" | "menu-tree" | "button-map" | "route-state";

export interface SemanticCacheRevisions {
    readonly rbacRevision: number;
    readonly menuRevision: number;
}

export interface SemanticCacheEnvelope {
    readonly version: typeof SEMANTIC_CACHE_ENVELOPE_VERSION;
    readonly family: SemanticCacheFamily;
    readonly rbacRevision: number;
    readonly menuRevision: number;
    readonly cachedAt: number;
    readonly expiresAt: number;
    readonly digest: string;
    readonly snapshot: unknown;
}

export interface SemanticSnapshotCodec<T> {
    encode(value: T): unknown;
    decode(value: unknown): T | Promise<T>;
}

const DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const BUTTON_CODE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MENU_NODE_TYPES = new Set(["directory", "menu", "page", "external", "iframe"]);
const BUTTON_REASONS = new Set(["allowed", "permission-denied", "api-unavailable", "hidden", "disabled"]);
const ROUTE_REASONS = new Set(["allowed", "not-found", "permission-denied", "api-unavailable", "disabled"]);
const NAVIGATION_REASONS = new Set([
    "reachable",
    "self-hidden",
    "hidden-ancestor",
    "disabled-ancestor",
    "denied-ancestor",
    "self-unavailable",
    "not-found",
]);
const SOURCE_REASONS = new Set([
    "asset-disabled",
    "asset-deprecated",
    "binding-disabled",
    "binding-deprecated",
    "grant-missing",
    "grant-revision-mismatch",
    "reference-missing",
    "contribution-refresh-available",
]);

function invalid(field: string, reason: string): never {
    throw new Error(`Invalid semantic cache value at ${field}: ${reason}`);
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return invalid(field, "must be a plain object");
    }
    if (utilTypes.isProxy(value)) {
        return invalid(field, "cannot be a Proxy");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return invalid(field, "must be a plain object");
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !isWellFormedUnicode(key) || FORBIDDEN_KEYS.has(key)) {
            invalid(field, `contains invalid key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            invalid(`${field}.${key}`, "must be an enumerable data property");
        }
    }
    return value as Record<string, unknown>;
}

function exactRecord(
    value: unknown,
    allowed: readonly string[],
    field: string,
    required: readonly string[] = allowed,
) {
    const record = plainRecord(value, field);
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(record)) {
        if (!allowedSet.has(key)) invalid(`${field}.${key}`, "is not supported");
    }
    for (const key of required) {
        if (!Object.hasOwn(record, key)) invalid(`${field}.${key}`, "is required");
    }
    return record;
}

function denseArray(value: unknown, field: string, maxItems: number): unknown[] {
    if (!Array.isArray(value)) invalid(field, "must be an array");
    if (utilTypes.isProxy(value)) invalid(field, "cannot be a Proxy");
    if (value.length > maxItems) invalid(field, `cannot contain more than ${maxItems} items`);
    let indexes = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
            invalid(field, "contains a non-index property");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            invalid(`${field}[${key}]`, "must be an enumerable data property");
        }
        indexes += 1;
    }
    if (indexes !== value.length) invalid(field, "cannot be sparse");
    return value;
}

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || !isWellFormedUnicode(value)) {
        return invalid(field, "must be a well-formed string");
    }
    return value;
}

function digest(value: unknown, field: string): string {
    const result = text(value, field);
    if (!DIGEST.test(result)) invalid(field, "must be a 43-character SHA-256 base64url digest");
    return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        return invalid(field, "must be a non-negative safe integer");
    }
    return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") return invalid(field, "must be a boolean");
    return value;
}

function optionalText(record: Record<string, unknown>, key: string, field: string) {
    return Object.hasOwn(record, key) ? text(record[key], `${field}.${key}`) : undefined;
}

function copyWithout(record: Record<string, unknown>, excludedKey: string) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        if (key !== excludedKey) result[key] = record[key];
    }
    return result;
}

function decodeDirectUserRoles(
    value: unknown,
    subject: Readonly<PermissionSubject>,
    scopeKey: string,
): InternalUserRoleSetView {
    const record = exactRecord(
        value,
        ["roleIds", "revision", "createdAt", "updatedAt", "persisted"],
        "snapshot.direct",
        ["roleIds", "revision", "persisted"],
    );
    const persisted = booleanValue(record.persisted, "snapshot.direct.persisted");
    if (persisted) {
        if (!Object.hasOwn(record, "createdAt") || !Object.hasOwn(record, "updatedAt")) {
            invalid("snapshot.direct", "persisted role bindings require timestamps");
        }
        return materializeUserRoleSetDocument({
            scopeKey,
            scope: subject.scope,
            userId: subject.userId,
            ...copyWithout(record, "persisted"),
        }, subject.scope, scopeKey);
    }
    if (Object.hasOwn(record, "createdAt") || Object.hasOwn(record, "updatedAt")) {
        invalid("snapshot.direct", "virtual role bindings cannot contain timestamps");
    }
    const roleIds = denseArray(record.roleIds, "snapshot.direct.roleIds", 0);
    if (roleIds.length !== 0 || record.revision !== 0) {
        invalid("snapshot.direct", "virtual role bindings must have revision zero and no roles");
    }
    return createVirtualUserRoleSet(subject.scope, scopeKey, subject.userId);
}

function decodeMenuSourceState(value: unknown): MenuRuleSourceState {
    const record = exactRecord(value, ["integrity", "availability", "drift"], "sourceView.state");
    if (record.integrity !== "valid" && record.integrity !== "invalid") {
        invalid("sourceView.state.integrity", "is invalid");
    }
    if (record.availability !== "active" && record.availability !== "inactive") {
        invalid("sourceView.state.availability", "is invalid");
    }
    if (record.drift !== "current" && record.drift !== "refresh-available") {
        invalid("sourceView.state.drift", "is invalid");
    }
    return deepFreeze({
        integrity: record.integrity as MenuRuleSourceState["integrity"],
        availability: record.availability as MenuRuleSourceState["availability"],
        drift: record.drift as MenuRuleSourceState["drift"],
    });
}

function decodeSourceView(value: unknown, schemes: ResourceSchemeRegistry): RuleSourceView {
    const record = plainRecord(value, "sourceView");
    if (record.kind === "manual") {
        exactRecord(value, ["kind", "sourceId", "state"], "sourceView");
        const sourceId = normalizeRbacId(record.sourceId, "sourceView.sourceId");
        if (record.state !== "active") invalid("sourceView.state", "manual sources must be active");
        return deepFreeze({ kind: "manual", sourceId, state: "active" as const });
    }
    exactRecord(
        value,
        [
            "kind",
            "grantId",
            "grantRevision",
            "sourceId",
            "effect",
            "contribution",
            "assetId",
            "apiBindingId",
            "dataResource",
            "state",
            "stateReason",
        ],
        "sourceView",
        ["kind", "grantId", "grantRevision", "sourceId", "effect", "contribution", "assetId", "state"],
    );
    if (record.kind !== "menu") invalid("sourceView.kind", "is invalid");
    const grantId = normalizeRbacId(record.grantId, "sourceView.grantId");
    const sourceId = normalizeRbacId(record.sourceId, "sourceView.sourceId");
    const assetId = normalizeRbacId(record.assetId, "sourceView.assetId");
    const grantRevision = nonNegativeInteger(record.grantRevision, "sourceView.grantRevision");
    if (grantRevision < 1) invalid("sourceView.grantRevision", "must be positive");
    if (record.effect !== "allow" && record.effect !== "deny") invalid("sourceView.effect", "is invalid");
    if (record.contribution !== "node" && record.contribution !== "api" && record.contribution !== "data") {
        invalid("sourceView.contribution", "is invalid");
    }
    const stateReason = Object.hasOwn(record, "stateReason")
        ? text(record.stateReason, "sourceView.stateReason")
        : undefined;
    if (stateReason !== undefined && !SOURCE_REASONS.has(stateReason)) {
        invalid("sourceView.stateReason", "is invalid");
    }
    const apiBindingId = Object.hasOwn(record, "apiBindingId")
        ? normalizeRbacId(record.apiBindingId, "sourceView.apiBindingId")
        : undefined;
    const dataResource = optionalText(record, "dataResource", "sourceView");
    if ((record.contribution === "api") !== (apiBindingId !== undefined)) {
        invalid("sourceView.apiBindingId", "must exist only for API contributions");
    }
    if ((record.contribution === "data") !== (dataResource !== undefined)) {
        invalid("sourceView.dataResource", "must exist only for data contributions");
    }
    if (dataResource !== undefined) schemes.validate(dataResource, "resource");
    return deepFreeze({
        kind: "menu" as const,
        grantId,
        grantRevision,
        sourceId,
        effect: record.effect,
        contribution: record.contribution,
        assetId,
        ...(apiBindingId === undefined ? {} : { apiBindingId }),
        ...(dataResource === undefined ? {} : { dataResource }),
        state: decodeMenuSourceState(record.state),
        ...(stateReason === undefined ? {} : { stateReason: stateReason as Extract<RuleSourceView, { kind: "menu" }>["stateReason"] }),
    });
}

function encodePermissionSnapshot(state: EffectiveAuthorizationState) {
    const direct = {
        roleIds: state.direct.roleIds,
        revision: state.direct.revision,
        ...(state.direct.createdAt === undefined ? {} : { createdAt: state.direct.createdAt }),
        ...(state.direct.updatedAt === undefined ? {} : { updatedAt: state.direct.updatedAt }),
        persisted: state.direct.persisted,
    };
    const roles = state.roles.map((role) => {
        const { scopeKey: _scopeKey, scope: _scope, ...snapshot } = role.document;
        return snapshot;
    });
    const rules = state.rules.map((rule) => {
        const { scopeKey: _scopeKey, scope: _scope, ...snapshot } = rule.document;
        return snapshot;
    });
    return {
        direct,
        roles,
        rules,
        sourceViews: [...state.sourceViews.entries()]
            .sort(([left], [right]) => compareUtf8(left, right)),
    };
}

function assertPermissionSnapshotBudget(snapshot: unknown) {
    const current = canonicalByteLength(snapshot);
    if (current > MAX_EFFECTIVE_SNAPSHOT_BYTES) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The effective authorization cache snapshot exceeds its byte limit.", {
            details: {
                kind: "limit-exceeded",
                origin: "persisted-authorization-state",
                limitName: "effective-snapshot-bytes",
                current,
                max: MAX_EFFECTIVE_SNAPSHOT_BYTES,
                unit: "bytes",
            },
        });
    }
}

async function decodePermissionSnapshot(
    value: unknown,
    subject: Readonly<PermissionSubject>,
    scopeKey: string,
    schemes: ResourceSchemeRegistry,
) {
    const record = exactRecord(value, ["direct", "roles", "rules", "sourceViews"], "snapshot");
    const direct = decodeDirectUserRoles(record.direct, subject, scopeKey);
    const roleValues = denseArray(record.roles, "snapshot.roles", MAX_EFFECTIVE_ROLES);
    const roles = roleValues.map((role, index) => {
        const snapshot = exactRecord(
            role,
            [
                "roleId", "label", "description", "status", "parentId", "revision", "menuGrantCount",
                "menuGrantDigest", "menuSourceCount", "menuSourceDigest", "createdAt", "updatedAt",
            ],
            `snapshot.roles[${index}]`,
            [
                "roleId", "label", "status", "parentId", "revision", "menuGrantCount", "menuGrantDigest",
                "menuSourceCount", "menuSourceDigest", "createdAt", "updatedAt",
            ],
        );
        return materializeRoleDocument({ scopeKey, scope: subject.scope, ...snapshot }, subject.scope, scopeKey);
    });
    const roleMap = new Map<string, Readonly<InternalRoleDocument>>();
    for (const role of roles) {
        if (roleMap.has(role.roleId)) invalid("snapshot.roles", "contains duplicate role identities");
        roleMap.set(role.roleId, role);
    }
    const ruleValues = denseArray(record.rules, "snapshot.rules", MAX_EFFECTIVE_RULES);
    const rules = ruleValues.map((rule, index) => {
        const snapshot = exactRecord(
            rule,
            ["roleId", "effect", "action", "resource", "where", "semanticKey", "sources", "revision", "createdAt", "updatedAt"],
            `snapshot.rules[${index}]`,
            ["roleId", "effect", "action", "resource", "semanticKey", "sources", "revision", "createdAt", "updatedAt"],
        );
        return materializeRoleRuleDocument(
            { scopeKey, scope: subject.scope, ...snapshot },
            subject.scope,
            scopeKey,
            schemes,
        );
    });
    const ruleKeys = new Set<string>();
    for (const rule of rules) {
        const key = canonicalString({ roleId: rule.roleId, semanticKey: rule.semanticKey });
        if (ruleKeys.has(key)) invalid("snapshot.rules", "contains duplicate role rule identities");
        ruleKeys.add(key);
    }
    const sourceValues = denseArray(record.sourceViews, "snapshot.sourceViews", MAX_EFFECTIVE_SOURCES);
    const sourceViews = new Map<string, RuleSourceView>();
    for (const [index, entryValue] of sourceValues.entries()) {
        const entry = denseArray(entryValue, `snapshot.sourceViews[${index}]`, 2);
        if (entry.length !== 2) invalid(`snapshot.sourceViews[${index}]`, "must be a two-item tuple");
        const sourceId = normalizeRbacId(entry[0], `snapshot.sourceViews[${index}][0]`);
        const view = decodeSourceView(entry[1], schemes);
        if (view.sourceId !== sourceId || sourceViews.has(sourceId)) {
            invalid(`snapshot.sourceViews[${index}]`, "contains a mismatched or duplicate source identity");
        }
        sourceViews.set(sourceId, view);
    }
    const reader: EffectiveAuthorizationReader = {
        async readRoles(roleIds) {
            return new Map(roleIds.flatMap((roleId) => {
                const role = roleMap.get(roleId);
                return role === undefined ? [] : [[roleId, role] as const];
            }));
        },
        async readRulesForRoles(roleIds) {
            const allowed = new Set(roleIds);
            return Object.freeze(rules.filter((rule) => allowed.has(rule.roleId)));
        },
        async resolveRulesForAuthorization(roleIds) {
            const allowed = new Set(roleIds);
            return Object.freeze({
                rules: Object.freeze(rules.filter((rule) => allowed.has(rule.roleId))),
                sourceViews,
            });
        },
    };
    const state = await loadEffectiveAuthorization(reader, direct);
    const normalized = encodePermissionSnapshot(state);
    if (state.roles.length !== roles.length || state.rules.length !== rules.length) {
        invalid("snapshot", "contains unreachable roles or rules");
    }
    if (canonicalString(normalized) !== canonicalString(record)) {
        invalid("snapshot", "is not in canonical effective authorization order");
    }
    assertPermissionSnapshotBudget(normalized);
    return state;
}

export function permissionSnapshotCodec(
    subject: Readonly<PermissionSubject>,
    scopeKey: string,
    schemes: ResourceSchemeRegistry,
): SemanticSnapshotCodec<EffectiveAuthorizationState> {
    return {
        encode(value) {
            const snapshot = encodePermissionSnapshot(value);
            assertPermissionSnapshotBudget(snapshot);
            return snapshot;
        },
        decode(value) {
            return decodePermissionSnapshot(value, subject, scopeKey, schemes);
        },
    };
}

function decodeDetailBudget(value: unknown): ResponseDetailBudget {
    const record = exactRecord(value, ["limit", "returned", "truncated", "digest"], "detailBudget");
    if (record.limit !== 100) invalid("detailBudget.limit", "must be 100");
    const returned = nonNegativeInteger(record.returned, "detailBudget.returned");
    if (returned > 100) invalid("detailBudget.returned", "cannot exceed 100");
    return deepFreeze({
        limit: 100 as const,
        returned,
        truncated: booleanValue(record.truncated, "detailBudget.truncated"),
        digest: digest(record.digest, "detailBudget.digest"),
    });
}

function decodeApiRisk(value: unknown): MenuRuntimeApiRisk {
    const record = exactRecord(value, ["bindingId", "required", "allowed"], "apiRisk");
    return deepFreeze({
        bindingId: normalizeRbacId(record.bindingId, "apiRisk.bindingId"),
        required: booleanValue(record.required, "apiRisk.required"),
        allowed: booleanValue(record.allowed, "apiRisk.allowed"),
    });
}

function decodeRiskDetails(value: unknown): BoundedDetails<MenuRuntimeApiRisk> {
    const record = exactRecord(value, ["total", "items", "truncated", "digest"], "apiRisks");
    const total = nonNegativeInteger(record.total, "apiRisks.total");
    const itemValues = denseArray(record.items, "apiRisks.items", 100);
    const items = itemValues.map(decodeApiRisk);
    if (total < items.length) invalid("apiRisks.total", "cannot be smaller than returned items");
    const truncated = booleanValue(record.truncated, "apiRisks.truncated");
    if (truncated !== (total > items.length)) invalid("apiRisks.truncated", "does not match total and returned items");
    const completeDigest = digest(record.digest, "apiRisks.digest");
    if (!truncated && completeDigest !== digestCanonical(items)) {
        invalid("apiRisks.digest", "does not match complete items");
    }
    return deepFreeze({ total, items, truncated, digest: completeDigest });
}

function decodePermissionRequirement(value: unknown, schemes: ResourceSchemeRegistry) {
    const record = exactRecord(value, ["action", "resource"], "permission");
    const action = normalizePermissionAction(record.action);
    const resource = text(record.resource, "permission.resource");
    schemes.validate(resource, "resource");
    return deepFreeze({ action, resource });
}

function decodeVisibleNode(
    value: unknown,
    schemes: ResourceSchemeRegistry,
    state: { count: number; ids: Set<string> },
    depth: number,
    expectedParentId?: string,
): VisibleMenuTreeNode {
    if (depth > 64) invalid("tree", "exceeds maximum menu depth 64");
    state.count += 1;
    if (state.count > 5_000) invalid("tree", "exceeds maximum visible node count 5000");
    const record = exactRecord(
        value,
        [
            "id", "parentId", "type", "title", "path", "name", "component", "url", "icon", "order",
            "i18nKey", "meta", "permission", "visible", "enabled", "reason", "apiRisks", "children",
        ],
        "tree.node",
        ["id", "parentId", "type", "title", "order", "visible", "enabled", "reason", "apiRisks", "children"],
    );
    const id = normalizeRbacId(record.id, "tree.node.id");
    if (state.ids.has(id)) invalid("tree.node.id", "is duplicated");
    state.ids.add(id);
    const parentId = record.parentId === null ? null : normalizeRbacId(record.parentId, "tree.node.parentId");
    if (expectedParentId !== undefined && parentId !== expectedParentId) {
        invalid("tree.node.parentId", "does not match the containing parent");
    }
    if (typeof record.type !== "string" || !MENU_NODE_TYPES.has(record.type)) invalid("tree.node.type", "is invalid");
    const title = text(record.title, "tree.node.title");
    const order = nonNegativeInteger(record.order, "tree.node.order");
    if (record.visible !== true) invalid("tree.node.visible", "must be true");
    const enabled = booleanValue(record.enabled, "tree.node.enabled");
    if (record.reason !== "allowed" && record.reason !== "api-unavailable") invalid("tree.node.reason", "is invalid");
    if (enabled !== (record.reason === "allowed")) invalid("tree.node.enabled", "does not match its reason");
    const path = optionalText(record, "path", "tree.node");
    if (path !== undefined && normalizeDeclaredPath(path, "tree.node.path") !== path) {
        invalid("tree.node.path", "must be canonical");
    }
    const childValues = denseArray(record.children, "tree.node.children", 5_000);
    const children = childValues.map((child) => decodeVisibleNode(child, schemes, state, depth + 1, id));
    return deepFreeze({
        id,
        parentId,
        type: record.type as VisibleMenuTreeNode["type"],
        title,
        ...(path === undefined ? {} : { path }),
        ...(optionalText(record, "name", "tree.node") === undefined ? {} : { name: optionalText(record, "name", "tree.node")! }),
        ...(optionalText(record, "component", "tree.node") === undefined ? {} : { component: optionalText(record, "component", "tree.node")! }),
        ...(optionalText(record, "url", "tree.node") === undefined ? {} : { url: optionalText(record, "url", "tree.node")! }),
        ...(optionalText(record, "icon", "tree.node") === undefined ? {} : { icon: optionalText(record, "icon", "tree.node")! }),
        order,
        ...(optionalText(record, "i18nKey", "tree.node") === undefined ? {} : { i18nKey: optionalText(record, "i18nKey", "tree.node")! }),
        ...(Object.hasOwn(record, "meta") ? { meta: clonePolicyRecord(record.meta, "INVALID_ARGUMENT", "tree.node.meta") } : {}),
        ...(Object.hasOwn(record, "permission") ? { permission: decodePermissionRequirement(record.permission, schemes) } : {}),
        visible: true as const,
        enabled,
        reason: record.reason,
        apiRisks: decodeRiskDetails(record.apiRisks),
        children,
    });
}

function decodeSubjectResult<T>(value: unknown, decodeData: (data: unknown) => T): SubjectRuntimeResult<T> {
    const record = exactRecord(value, ["data", "detailBudget"], "snapshot");
    const result = deepFreeze({
        data: decodeData(record.data),
        detailBudget: decodeDetailBudget(record.detailBudget),
    });
    assertAuthorizationResponseBudget(result);
    return result;
}

export function menuTreeSnapshotCodec(
    schemes: ResourceSchemeRegistry,
): SemanticSnapshotCodec<SubjectRuntimeResult<VisibleMenuTreeNode[]>> {
    return {
        encode: (value) => value,
        decode: (value) => decodeSubjectResult(value, (data) => {
            const roots = denseArray(data, "snapshot.data", 5_000);
            const state = { count: 0, ids: new Set<string>() };
            return deepFreeze(roots.map((root) => decodeVisibleNode(root, schemes, state, 0)));
        }),
    };
}

function decodeButtonState(value: unknown, schemes: ResourceSchemeRegistry): ButtonPermissionState {
    const record = exactRecord(value, ["visible", "enabled", "reason", "action", "resource", "apiRisks"], "buttonState");
    const visible = booleanValue(record.visible, "buttonState.visible");
    const enabled = booleanValue(record.enabled, "buttonState.enabled");
    if (typeof record.reason !== "string" || !BUTTON_REASONS.has(record.reason)) invalid("buttonState.reason", "is invalid");
    const expectedVisible = record.reason === "allowed" || record.reason === "api-unavailable";
    if (visible !== expectedVisible || enabled !== (record.reason === "allowed")) {
        invalid("buttonState", "visibility or enabled state does not match its reason");
    }
    const action = normalizePermissionAction(record.action);
    const resource = text(record.resource, "buttonState.resource");
    schemes.validate(resource, "resource");
    return deepFreeze({
        visible,
        enabled,
        reason: record.reason as ButtonPermissionState["reason"],
        action,
        resource,
        apiRisks: decodeRiskDetails(record.apiRisks),
    });
}

export function buttonMapSnapshotCodec(
    schemes: ResourceSchemeRegistry,
): SemanticSnapshotCodec<SubjectRuntimeResult<Readonly<Record<string, ButtonPermissionState>>>> {
    return {
        encode: (value) => value,
        decode: (value) => decodeSubjectResult(value, (data) => {
            const record = plainRecord(data, "snapshot.data");
            const codes = Object.keys(record).sort(compareUtf8);
            if (codes.length > 1_000) invalid("snapshot.data", "contains more than 1000 buttons");
            const result: Record<string, ButtonPermissionState> = {};
            for (const code of codes) {
                if (!BUTTON_CODE.test(code) || FORBIDDEN_KEYS.has(code)) invalid(`snapshot.data.${code}`, "is not a safe button code");
                result[code] = decodeButtonState(record[code], schemes);
            }
            return deepFreeze(result);
        }),
    };
}

function decodeRouteState(value: unknown, schemes: ResourceSchemeRegistry): RoutePermissionState {
    const record = exactRecord(
        value,
        ["allowed", "reason", "nodeId", "action", "resource", "matchedPath", "apiRisks", "navigationReachable", "navigationReason"],
        "routeState",
        ["allowed", "reason", "apiRisks", "navigationReachable", "navigationReason"],
    );
    const allowed = booleanValue(record.allowed, "routeState.allowed");
    if (typeof record.reason !== "string" || !ROUTE_REASONS.has(record.reason)) invalid("routeState.reason", "is invalid");
    if (allowed !== (record.reason === "allowed")) invalid("routeState.allowed", "does not match its reason");
    if (typeof record.navigationReason !== "string" || !NAVIGATION_REASONS.has(record.navigationReason)) {
        invalid("routeState.navigationReason", "is invalid");
    }
    const navigationReachable = booleanValue(record.navigationReachable, "routeState.navigationReachable");
    if (navigationReachable !== (record.navigationReason === "reachable")) {
        invalid("routeState.navigationReachable", "does not match its reason");
    }
    const notFound = record.reason === "not-found";
    for (const field of ["nodeId", "action", "resource", "matchedPath"] as const) {
        if (notFound === Object.hasOwn(record, field)) {
            invalid(`routeState.${field}`, notFound ? "must be omitted for not-found" : "is required for a matched route");
        }
    }
    if (notFound && (record.navigationReason !== "not-found" || navigationReachable)) {
        invalid("routeState", "not-found route state is inconsistent");
    }
    if (!notFound && record.reason !== "allowed" && record.navigationReason !== "self-unavailable") {
        invalid("routeState.navigationReason", "unavailable routes must report self-unavailable");
    }
    const nodeId = notFound ? undefined : normalizeRbacId(record.nodeId, "routeState.nodeId");
    const action = notFound ? undefined : normalizePermissionAction(record.action);
    const resource = notFound ? undefined : text(record.resource, "routeState.resource");
    if (resource !== undefined) schemes.validate(resource, "resource");
    const matchedPath = notFound ? undefined : text(record.matchedPath, "routeState.matchedPath");
    if (matchedPath !== undefined && normalizeDeclaredPath(matchedPath, "routeState.matchedPath") !== matchedPath) {
        invalid("routeState.matchedPath", "must be canonical");
    }
    return deepFreeze({
        allowed,
        reason: record.reason as RoutePermissionState["reason"],
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(action === undefined ? {} : { action }),
        ...(resource === undefined ? {} : { resource }),
        ...(matchedPath === undefined ? {} : { matchedPath }),
        apiRisks: decodeRiskDetails(record.apiRisks),
        navigationReachable,
        navigationReason: record.navigationReason as RoutePermissionState["navigationReason"],
    });
}

export function routeStateSnapshotCodec(
    schemes: ResourceSchemeRegistry,
): SemanticSnapshotCodec<SubjectRuntimeResult<RoutePermissionState>> {
    return {
        encode: (value) => value,
        decode: (value) => decodeSubjectResult(value, (data) => decodeRouteState(data, schemes)),
    };
}

function envelopeDigest(
    key: string,
    envelope: Omit<SemanticCacheEnvelope, "digest">,
) {
    return digestCanonical({ key, ...envelope });
}

export async function createSemanticCacheEnvelope<T>(input: {
    readonly key: string;
    readonly family: SemanticCacheFamily;
    readonly revisions: SemanticCacheRevisions;
    readonly ttlMs: number;
    readonly value: T;
    readonly codec: SemanticSnapshotCodec<T>;
    readonly now?: number;
}) {
    const cachedAt = input.now ?? Date.now();
    const snapshot = structuredClone(input.codec.encode(input.value));
    const base = {
        version: SEMANTIC_CACHE_ENVELOPE_VERSION,
        family: input.family,
        rbacRevision: input.revisions.rbacRevision,
        menuRevision: input.revisions.menuRevision,
        cachedAt,
        expiresAt: cachedAt + input.ttlMs,
        snapshot,
    } as const;
    const envelope: SemanticCacheEnvelope = deepFreeze({
        ...base,
        digest: envelopeDigest(input.key, base),
    });
    return Object.freeze({
        envelope,
        bytes: canonicalByteLength(envelope),
    });
}

export async function decodeSemanticCacheEnvelope<T>(input: {
    readonly key: string;
    readonly family: SemanticCacheFamily;
    readonly ttlMs: number;
    readonly value: unknown;
    readonly codec: SemanticSnapshotCodec<T>;
    readonly now?: number;
}) {
    const now = input.now ?? Date.now();
    const record = exactRecord(
        input.value,
        ["version", "family", "rbacRevision", "menuRevision", "cachedAt", "expiresAt", "digest", "snapshot"],
        "envelope",
    );
    if (record.version !== SEMANTIC_CACHE_ENVELOPE_VERSION) invalid("envelope.version", "is unsupported");
    if (record.family !== input.family) invalid("envelope.family", "does not match the cache key family");
    const rbacRevision = nonNegativeInteger(record.rbacRevision, "envelope.rbacRevision");
    const menuRevision = nonNegativeInteger(record.menuRevision, "envelope.menuRevision");
    const cachedAt = nonNegativeInteger(record.cachedAt, "envelope.cachedAt");
    const expiresAt = nonNegativeInteger(record.expiresAt, "envelope.expiresAt");
    if (expiresAt - cachedAt !== input.ttlMs) invalid("envelope.expiresAt", "does not match the configured TTL");
    if (cachedAt > now) invalid("envelope.cachedAt", "cannot be in the future");
    const firstDecoded = await input.codec.decode(record.snapshot);
    const normalizedSnapshot = input.codec.encode(firstDecoded);
    if (canonicalString(normalizedSnapshot) !== canonicalString(record.snapshot)) {
        invalid("envelope.snapshot", "is not canonical");
    }
    const base = {
        version: SEMANTIC_CACHE_ENVELOPE_VERSION,
        family: input.family,
        rbacRevision,
        menuRevision,
        cachedAt,
        expiresAt,
        snapshot: normalizedSnapshot,
    } as const;
    const expectedDigest = envelopeDigest(input.key, base);
    if (digest(record.digest, "envelope.digest") !== expectedDigest) invalid("envelope.digest", "does not match the bound key and payload");
    if (canonicalByteLength({ ...base, digest: expectedDigest }) > MAX_SEMANTIC_CACHE_VALUE_BYTES) {
        invalid("envelope", "exceeds the semantic cache value budget");
    }
    const clonedSnapshot = structuredClone(normalizedSnapshot);
    const value = await input.codec.decode(clonedSnapshot);
    return Object.freeze({
        expired: expiresAt <= now,
        revisions: Object.freeze({ rbacRevision, menuRevision }),
        value,
    });
}

export function sameRevisions(left: SemanticCacheRevisions, right: SemanticCacheRevisions) {
    return left.rbacRevision === right.rbacRevision && left.menuRevision === right.menuRevision;
}
