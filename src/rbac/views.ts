import type {
    BoundedDetails,
    PermissionRuleView,
    Role,
    RuleSourceView,
    UserRoleBindingSet,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { InternalRoleDocument, InternalRoleRuleDocument } from "../persistence/documents";
import type { InternalUserRoleSetView } from "./materialize";
import { createMenuSourceId, createSemanticKey, MAX_RULE_SOURCES } from "./materialize";
import { MAX_RULES_PER_ROLE } from "./store";
import { normalizeManualRuleInput } from "./inputs";
import { RESPONSE_DETAIL_LIMIT, type DetailBudgetAllocator } from "./result";
import {
    assertNonNegativeSafeInteger,
    assertPositiveSafeInteger,
    normalizeDescription,
    normalizeRbacId,
    normalizeRoleLabel,
} from "./validation";

function invalidReplay(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted mutation replay data is malformed.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function exactReplayRecord(value: unknown, allowed: readonly string[], field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        invalidReplay(`${field} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => !allowed.includes(key))) {
        invalidReplay(`${field} contains unexpected fields`);
    }
    return record;
}

function persistedReplayId(value: unknown, field: string) {
    try {
        const normalized = normalizeRbacId(value, field);
        if (normalized !== value) {
            invalidReplay(`${field} is not canonical`);
        }
        return normalized;
    } catch (error) {
        if (error instanceof PermissionCoreError && error.code === "PERSISTED_STATE_INVALID") {
            throw error;
        }
        invalidReplay(`${field} is invalid`);
    }
}

export function boundedDetails<T>(items: readonly T[], limit = 100): BoundedDetails<T> {
    const complete = [...items];
    return deepFreeze({
        total: complete.length,
        items: complete.slice(0, limit),
        truncated: complete.length > limit,
        digest: digestCanonical(complete),
    });
}

export function completeDetails<T>(items: readonly T[]): BoundedDetails<T> {
    const complete = [...items];
    return deepFreeze({
        total: complete.length,
        items: complete,
        truncated: false,
        digest: digestCanonical(complete),
    });
}

export function roleView(document: Readonly<InternalRoleDocument>): Role {
    return deepFreeze({
        id: document.roleId,
        label: document.label,
        ...(document.description === undefined ? {} : { description: document.description }),
        status: document.status,
        parentId: document.parentId,
        revision: document.revision,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
    });
}

export function userRoleBindingView(document: InternalUserRoleSetView): UserRoleBindingSet {
    return deepFreeze({
        userId: document.userId,
        roleIds: [...document.roleIds],
        revision: document.revision,
        persisted: document.persisted,
        ...(document.persisted ? { createdAt: document.createdAt!, updatedAt: document.updatedAt! } : {}),
    });
}

export function completePermissionRuleView(
    document: Readonly<InternalRoleRuleDocument>,
    menuSourceViews: ReadonlyMap<string, RuleSourceView> = new Map(),
): PermissionRuleView {
    const sources: RuleSourceView[] = document.sources.map((source) => {
        if (source.kind === "manual") {
            return deepFreeze({ kind: "manual", sourceId: source.sourceId, state: "active" });
        }
        const view = menuSourceViews.get(source.sourceId);
        if (view?.kind !== "menu") invalidReplay("A menu rule source was not resolved before public projection");
        return view;
    });
    sources.sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
    return deepFreeze({
        effect: document.effect,
        action: document.action,
        resource: document.resource,
        ...(document.where === undefined ? {} : { where: document.where }),
        semanticKey: document.semanticKey,
        sources: completeDetails(sources),
    });
}

export function permissionRuleView(
    document: Readonly<InternalRoleRuleDocument>,
    menuSourceViews: ReadonlyMap<string, RuleSourceView> = new Map(),
    detailBudget?: DetailBudgetAllocator,
): PermissionRuleView {
    const complete = completePermissionRuleView(document, menuSourceViews);
    return deepFreeze({
        ...complete,
        sources: detailBudget?.bounded(complete.sources.items) ?? boundedDetails(complete.sources.items),
    });
}

export function decodeRoleReplay(value: unknown): Role {
    const record = exactReplayRecord(
        value,
        ["id", "label", "description", "status", "parentId", "revision", "createdAt", "updatedAt"],
        "replay.role",
    );
    let id: string;
    let label: string;
    let description: string | undefined;
    let revision: number;
    let createdAt: number;
    let updatedAt: number;
    try {
        id = persistedReplayId(record.id, "replay.role.id");
        label = normalizeRoleLabel(record.label, "replay.role.label");
        if (label !== record.label) {
            invalidReplay("replay.role.label is not canonical");
        }
        description = record.description === undefined
            ? undefined
            : normalizeDescription(record.description, "replay.role.description");
        revision = assertPositiveSafeInteger(record.revision, "replay.role.revision");
        createdAt = assertNonNegativeSafeInteger(record.createdAt, "replay.role.createdAt");
        updatedAt = assertNonNegativeSafeInteger(record.updatedAt, "replay.role.updatedAt");
    } catch (error) {
        if (error instanceof PermissionCoreError && error.code === "PERSISTED_STATE_INVALID") {
            throw error;
        }
        invalidReplay("replay.role scalar fields are invalid");
    }
    if (
        (record.status !== "enabled" && record.status !== "disabled" && record.status !== "deprecated")
        || (record.parentId !== null && typeof record.parentId !== "string")
        || updatedAt < createdAt
    ) {
        invalidReplay("replay.role status, parent, or timestamps are invalid");
    }
    const parentId = record.parentId === null ? null : persistedReplayId(record.parentId, "replay.role.parentId");
    if (parentId === id) {
        invalidReplay("replay.role cannot be its own parent");
    }
    const result: Role = {
        id,
        label,
        ...(description === undefined ? {} : { description }),
        status: record.status,
        parentId,
        revision,
        createdAt,
        updatedAt,
    };
    if (canonicalString(result) !== canonicalString(record)) {
        invalidReplay("replay.role is not canonical");
    }
    return deepFreeze(result);
}

export function decodeUserRoleBindingReplay(value: unknown): UserRoleBindingSet {
    const record = exactReplayRecord(
        value,
        ["userId", "roleIds", "revision", "persisted", "createdAt", "updatedAt"],
        "replay.userRoles",
    );
    const userId = persistedReplayId(record.userId, "replay.userRoles.userId");
    if (!Array.isArray(record.roleIds) || record.roleIds.length > 128) {
        invalidReplay("replay.userRoles.roleIds is invalid");
    }
    const roleIds = record.roleIds.map((roleId) => persistedReplayId(roleId, "replay.userRoles.roleIds"));
    const canonicalRoleIds = [...new Set(roleIds)].sort(compareUtf8);
    if (canonicalString(roleIds) !== canonicalString(canonicalRoleIds)) {
        invalidReplay("replay.userRoles.roleIds is not sorted and unique");
    }
    let revision: number;
    try {
        revision = assertNonNegativeSafeInteger(record.revision, "replay.userRoles.revision");
    } catch {
        invalidReplay("replay.userRoles.revision is invalid");
    }
    if (typeof record.persisted !== "boolean" || (record.persisted && revision < 1) || (!record.persisted && revision !== 0)) {
        invalidReplay("replay.userRoles persisted/revision state is invalid");
    }
    let result: UserRoleBindingSet;
    if (record.persisted) {
        let createdAt: number;
        let updatedAt: number;
        try {
            createdAt = assertNonNegativeSafeInteger(record.createdAt, "replay.userRoles.createdAt");
            updatedAt = assertNonNegativeSafeInteger(record.updatedAt, "replay.userRoles.updatedAt");
        } catch {
            invalidReplay("replay.userRoles timestamps are invalid");
        }
        if (updatedAt < createdAt) {
            invalidReplay("replay.userRoles.updatedAt precedes createdAt");
        }
        result = { userId, roleIds, revision, persisted: true, createdAt, updatedAt };
    } else {
        if (roleIds.length !== 0 || Object.hasOwn(record, "createdAt") || Object.hasOwn(record, "updatedAt")) {
            invalidReplay("virtual replay.userRoles must be empty and cannot contain timestamps");
        }
        result = { userId, roleIds, revision, persisted: false };
    }
    if (canonicalString(result) !== canonicalString(record)) {
        invalidReplay("replay.userRoles is not canonical");
    }
    return deepFreeze(result);
}

export function decodeRemovedRoleReplay(value: unknown) {
    const record = exactReplayRecord(value, ["removedRoleId"], "replay.removedRole");
    const result = { removedRoleId: persistedReplayId(record.removedRoleId, "replay.removedRoleId") };
    if (canonicalString(result) !== canonicalString(record)) {
        invalidReplay("replay.removedRole is not canonical");
    }
    return deepFreeze(result);
}

export function decodeRuleRevokeReplay(value: unknown) {
    const record = exactReplayRecord(
        value,
        ["removed", "remainingCount", "remainingDigest"],
        "replay.ruleRevoke",
    );
    if (
        (record.removed !== 0 && record.removed !== 1)
        || !Number.isSafeInteger(record.remainingCount)
        || (record.remainingCount as number) < 0
        || (record.remainingCount as number) > MAX_RULES_PER_ROLE
        || typeof record.remainingDigest !== "string"
        || !/^[A-Za-z0-9_-]{43}$/u.test(record.remainingDigest)
    ) {
        invalidReplay("replay.ruleRevoke fields are invalid");
    }
    return deepFreeze({
        removed: record.removed as number,
        remainingCount: record.remainingCount as number,
        remainingDigest: record.remainingDigest,
    });
}

export function decodePermissionRuleReplay(
    value: unknown,
    resourceSchemes: ResourceSchemeRegistry,
): PermissionRuleView {
    const record = exactReplayRecord(
        value,
        ["effect", "action", "resource", "where", "semanticKey", "sources"],
        "replay.rule",
    );
    let normalized: ReturnType<typeof normalizeManualRuleInput>;
    try {
        normalized = normalizeManualRuleInput({
            effect: record.effect as never,
            action: record.action as never,
            resource: record.resource as string,
            ...(Object.hasOwn(record, "where") ? { where: record.where as never } : {}),
        }, resourceSchemes);
    } catch {
        invalidReplay("replay.rule policy fields are invalid");
    }
    const semanticKey = createSemanticKey(
        normalized.effect,
        normalized.action,
        normalized.resource,
        normalized.where,
    );
    if (record.semanticKey !== semanticKey) {
        invalidReplay("replay.rule semanticKey is invalid");
    }
    const sourceRecord = exactReplayRecord(
        record.sources,
        ["total", "items", "truncated", "digest"],
        "replay.rule.sources",
    );
    if (!Array.isArray(sourceRecord.items)) {
        invalidReplay("replay.rule.sources envelope is invalid");
    }
    const total = sourceRecord.total;
    const truncated = sourceRecord.truncated;
    if (
        !Number.isSafeInteger(total)
        || (total as number) < 1
        || (total as number) > MAX_RULE_SOURCES
        || typeof truncated !== "boolean"
        || sourceRecord.items.length > (total as number)
        || sourceRecord.items.length > RESPONSE_DETAIL_LIMIT
        || truncated !== (sourceRecord.items.length < (total as number))
        || typeof sourceRecord.digest !== "string"
        || !/^[A-Za-z0-9_-]{43}$/u.test(sourceRecord.digest)
    ) {
        invalidReplay("replay.rule.sources envelope is invalid");
    }
    const sources = sourceRecord.items.map((source, index) => {
        const field = `replay.rule.sources[${index}]`;
        const sourceView = exactReplayRecord(source, [
            "kind", "sourceId", "state", "grantId", "grantRevision", "effect", "contribution",
            "assetId", "apiBindingId", "dataResource", "stateReason",
        ], field);
        if (sourceView.kind === "manual") {
            const result = {
                kind: "manual" as const,
                sourceId: `manual:${semanticKey}`,
                state: "active" as const,
            };
            if (canonicalString(result) !== canonicalString(sourceView)) {
                invalidReplay("replay.rule contains a non-canonical manual source");
            }
            return deepFreeze(result);
        }
        if (sourceView.kind !== "menu") {
            invalidReplay("replay.rule source kind is invalid");
        }

        let grantId: string;
        let assetId: string;
        let apiBindingId: string | undefined;
        let grantRevision: number;
        try {
            grantId = persistedReplayId(sourceView.grantId, `${field}.grantId`);
            assetId = persistedReplayId(sourceView.assetId, `${field}.assetId`);
            apiBindingId = sourceView.apiBindingId === undefined
                ? undefined
                : persistedReplayId(sourceView.apiBindingId, `${field}.apiBindingId`);
            grantRevision = assertPositiveSafeInteger(sourceView.grantRevision, `${field}.grantRevision`);
        } catch (error) {
            if (error instanceof PermissionCoreError && error.code === "PERSISTED_STATE_INVALID") throw error;
            invalidReplay("replay.rule menu source identity fields are invalid");
        }
        if (
            sourceView.effect !== normalized.effect
            || (sourceView.contribution !== "node"
                && sourceView.contribution !== "api"
                && sourceView.contribution !== "data")
        ) {
            invalidReplay("replay.rule menu source policy fields are invalid");
        }
        const dataResource = sourceView.dataResource;
        if (
            (sourceView.contribution === "node" && (apiBindingId !== undefined || dataResource !== undefined))
            || (sourceView.contribution === "api" && (apiBindingId === undefined || dataResource !== undefined))
            || (sourceView.contribution === "data" && (apiBindingId !== undefined || typeof dataResource !== "string"))
        ) {
            invalidReplay("replay.rule menu source contribution fields are inconsistent");
        }
        if (typeof dataResource === "string") {
            try {
                resourceSchemes.validate(dataResource, "resource");
            } catch {
                invalidReplay("replay.rule menu source data resource is invalid");
            }
        }
        const expectedSourceId = createMenuSourceId({
            grantId,
            semanticKey,
            contribution: sourceView.contribution,
            assetId,
            ...(apiBindingId === undefined ? {} : { apiBindingId }),
            ...(typeof dataResource === "string" ? { dataResource } : {}),
        });
        if (sourceView.sourceId !== expectedSourceId) {
            invalidReplay("replay.rule menu source identity is invalid");
        }
        const stateRecord = exactReplayRecord(
            sourceView.state,
            ["integrity", "availability", "drift"],
            `${field}.state`,
        );
        if (
            (stateRecord.integrity !== "valid" && stateRecord.integrity !== "invalid")
            || (stateRecord.availability !== "active" && stateRecord.availability !== "inactive")
            || (stateRecord.drift !== "current" && stateRecord.drift !== "refresh-available")
        ) {
            invalidReplay("replay.rule menu source state is invalid");
        }
        const stateReason = sourceView.stateReason;
        if (
            stateReason !== undefined
            && ![
                "asset-disabled", "asset-deprecated", "binding-disabled", "binding-deprecated",
                "grant-missing", "grant-revision-mismatch", "reference-missing",
                "contribution-refresh-available",
            ].includes(stateReason as string)
        ) {
            invalidReplay("replay.rule menu source state reason is invalid");
        }
        const result: Extract<RuleSourceView, { kind: "menu" }> = {
            kind: "menu",
            grantId,
            grantRevision,
            sourceId: expectedSourceId,
            effect: normalized.effect,
            contribution: sourceView.contribution,
            assetId,
            ...(apiBindingId === undefined ? {} : { apiBindingId }),
            ...(typeof dataResource === "string" ? { dataResource } : {}),
            state: {
                integrity: stateRecord.integrity,
                availability: stateRecord.availability,
                drift: stateRecord.drift,
            },
            ...(stateReason === undefined ? {} : {
                stateReason: stateReason as NonNullable<Extract<RuleSourceView, { kind: "menu" }>["stateReason"]>,
            }),
        };
        if (canonicalString(result) !== canonicalString(sourceView)) {
            invalidReplay("replay.rule menu source is not canonical");
        }
        return deepFreeze(result);
    });
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) {
        invalidReplay("replay.rule source identities must be unique");
    }
    const sortedSources = [...sources].sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
    if (canonicalString(sortedSources) !== canonicalString(sources)) {
        invalidReplay("replay.rule sources are not canonically ordered");
    }
    if (!truncated && sourceRecord.digest !== digestCanonical(sources)) {
        invalidReplay("replay.rule.sources digest is invalid");
    }
    const result: PermissionRuleView = {
        effect: normalized.effect,
        action: normalized.action,
        resource: normalized.resource,
        ...(normalized.where === undefined ? {} : { where: normalized.where }),
        semanticKey,
        sources: deepFreeze({
            total: total as number,
            items: sources,
            truncated,
            digest: sourceRecord.digest as string,
        }),
    };
    if (canonicalString(result) !== canonicalString(record)) {
        invalidReplay("replay.rule is not canonical");
    }
    return deepFreeze(result);
}
