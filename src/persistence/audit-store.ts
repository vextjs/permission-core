import type { MongoSession } from "monsqlize";
import type { PermissionScope, PolicyValue } from "../types";
import {
    CanonicalEncodingError,
    canonicalString,
    compareUtf8,
    digestCanonical,
    sha256Base64Url,
} from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { createScopeKey, normalizeScope } from "../scope/scope";
import { PermissionCoreError } from "../core/errors";
import {
    assertAuditChangeBudget,
    assertCanonicalBudget,
    assertInternalDocumentBudget,
    MAX_INTERNAL_DOCUMENT_BYTES,
    MAX_PUBLIC_AUDIT_ENTRY_BYTES,
    type InternalAuditEntryDocument,
    type InternalAuditOperationalState,
    type InternalCacheOutcome,
    type InternalEntityRevisionRef,
    type InternalEntityRevisionKind,
    type InternalManagementAuditAction,
    type InternalManagementAuditOperation,
    type InternalRevisionVector,
} from "./documents";
import { SIMPLE_COLLATION } from "./indexes";
import type { InternalPermissionCollection } from "./native-collection";

export interface AuditAppendInput {
    readonly auditId: string;
    readonly operationId: string;
    readonly scope: PermissionScope;
    readonly actorId: string;
    readonly operation: InternalManagementAuditOperation;
    readonly action: InternalManagementAuditAction;
    readonly resource?: string;
    readonly requestId?: string;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly idempotencyRequestHash: string;
    readonly validatedPlanHash?: string;
    readonly change: PolicyValue;
    readonly capacity?: PolicyValue;
    readonly revisionsBefore: InternalRevisionVector;
    readonly revisionsAfter: InternalRevisionVector;
    readonly changed: boolean;
    readonly cacheTargets: readonly string[];
    readonly replayResult: PolicyValue;
    readonly cacheOutcome: InternalCacheOutcome;
    readonly now: number;
}

const CACHE_OUTCOMES = new Set<InternalCacheOutcome>([
    "pending",
    "not-needed",
    "completed",
    "bypassed",
    "degraded",
]);

const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PLACEHOLDER = "A".repeat(43);
const RECONCILE_OPERATION: InternalManagementAuditOperation = "audit.reconcileCacheOutcomes";

const ACTIONS_BY_OPERATION = Object.freeze({
    "roles.create": ["create"],
    "roles.update": ["update"],
    "roles.executeAccessUpdate": ["update"],
    "roles.remove": ["remove"],
    "roles.allow": ["allow"],
    "roles.deny": ["deny"],
    "roles.revoke": ["revoke"],
    "roles.executeRuleChange": ["allow", "deny", "revoke"],
    "roles.replaceRules": ["replace"],
    "userRoles.assign": ["assign"],
    "userRoles.revoke": ["revoke"],
    "userRoles.set": ["set"],
    "userRoles.clear": ["clear"],
    "menus.create": ["create"],
    "menus.update": ["update"],
    "menus.executeUpdate": ["update"],
    "menus.move": ["move"],
    "menus.reorder": ["reorder"],
    "menus.setStatus": ["update"],
    "menus.remove": ["remove"],
    "menus.repairStaleReferences": ["repair"],
    "menus.manifest.import": ["import"],
    "apiBindings.create": ["create"],
    "apiBindings.update": ["update"],
    "apiBindings.setStatus": ["update"],
    "apiBindings.executeUpdate": ["update"],
    "apiBindings.remove": ["remove"],
    "apiBindings.replace": ["replace"],
    "roles.menuPermissions.grant": ["grant"],
    "roles.menuPermissions.deny": ["deny"],
    "roles.menuPermissions.revoke": ["revoke"],
    "roles.menuPermissions.set": ["set"],
    "roles.menuPermissions.repairStale": ["repair"],
    "audit.reconcileCacheOutcomes": ["reconcile"],
} satisfies Readonly<Record<InternalManagementAuditOperation, readonly InternalManagementAuditAction[]>>);

type OperationDomainOwner = "rbac" | "menu" | "audit";

const DOMAIN_OWNER_BY_OPERATION = Object.freeze({
    "roles.create": "rbac",
    "roles.update": "rbac",
    "roles.executeAccessUpdate": "rbac",
    "roles.remove": "rbac",
    "roles.allow": "rbac",
    "roles.deny": "rbac",
    "roles.revoke": "rbac",
    "roles.executeRuleChange": "rbac",
    "roles.replaceRules": "rbac",
    "userRoles.assign": "rbac",
    "userRoles.revoke": "rbac",
    "userRoles.set": "rbac",
    "userRoles.clear": "rbac",
    "menus.create": "menu",
    "menus.update": "menu",
    "menus.executeUpdate": "menu",
    "menus.move": "menu",
    "menus.reorder": "menu",
    "menus.setStatus": "menu",
    "menus.remove": "menu",
    "menus.repairStaleReferences": "menu",
    "menus.manifest.import": "menu",
    "apiBindings.create": "menu",
    "apiBindings.update": "menu",
    "apiBindings.setStatus": "menu",
    "apiBindings.executeUpdate": "menu",
    "apiBindings.remove": "menu",
    "apiBindings.replace": "menu",
    "roles.menuPermissions.grant": "rbac",
    "roles.menuPermissions.deny": "rbac",
    "roles.menuPermissions.revoke": "rbac",
    "roles.menuPermissions.set": "rbac",
    "roles.menuPermissions.repairStale": "rbac",
    "audit.reconcileCacheOutcomes": "audit",
} satisfies Readonly<Record<InternalManagementAuditOperation, OperationDomainOwner>>);

// Entity vectors contain bounded CAS anchors, not every rewritten source owner.
// Keep the cross-domain exception closed to operations whose public contract can rewrite menu-derived RBAC state.
const MENU_RBAC_REWRITE_OPERATIONS = new Set<InternalManagementAuditOperation>([
    "menus.executeUpdate",
    "menus.remove",
    "menus.manifest.import",
    "apiBindings.executeUpdate",
    "apiBindings.remove",
    "apiBindings.replace",
]);
const RBAC_SCOPE_OWNER_OPERATIONS = new Set<InternalManagementAuditOperation>([
    "roles.menuPermissions.repairStale",
]);
const MENU_RBAC_REWRITE_ENTITY_KINDS = new Set<InternalEntityRevisionKind>([
    "role",
    "role-menu-grant",
]);

const ENTITY_REVISION_KINDS = new Set<InternalEntityRevisionKind>([
    "role",
    "user-role-set",
    "role-menu-grant",
    "menu-node",
    "api-binding",
    "scope",
]);
const RBAC_ENTITY_REVISION_KINDS = new Set<InternalEntityRevisionKind>([
    "role",
    "user-role-set",
    "role-menu-grant",
]);
const MENU_ENTITY_REVISION_KINDS = new Set<InternalEntityRevisionKind>([
    "menu-node",
    "api-binding",
]);
const REVISION_FIELDS = ["global", "rbac", "menu", "audit", "entities"] as const;
const ENTITY_REVISION_FIELDS = ["kind", "id", "revision"] as const;

type ReconciledCacheOutcome = Exclude<InternalCacheOutcome, "pending" | "not-needed">;

function isReconciledCacheOutcome(value: unknown): value is ReconciledCacheOutcome {
    return value === "completed" || value === "bypassed" || value === "degraded";
}

function isAuditOperationAction(
    operation: unknown,
    action: unknown,
): operation is InternalManagementAuditOperation {
    return typeof operation === "string"
        && typeof action === "string"
        && Object.hasOwn(ACTIONS_BY_OPERATION, operation)
        && (ACTIONS_BY_OPERATION[operation as InternalManagementAuditOperation] as readonly InternalManagementAuditAction[]).includes(
            action as InternalManagementAuditAction,
        );
}

function cacheTargetsIssue(value: unknown, requireSorted: boolean) {
    if (!Array.isArray(value)) {
        return "must be an array";
    }
    if (value.length > 1000) {
        return "contains more than 1000 items";
    }
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const target of value) {
        if (typeof target !== "string" || !target) {
            return "must contain only non-empty strings";
        }
        try {
            compareUtf8(target, target);
            if (requireSorted && previous !== undefined && compareUtf8(previous, target) >= 0) {
                return "must be sorted and unique";
            }
        } catch {
            return "must contain only well-formed Unicode strings";
        }
        if (seen.has(target)) {
            return "cannot contain duplicates";
        }
        seen.add(target);
        previous = target;
    }
    return undefined;
}

const AUDIT_FIELDS = new Set([
    "scopeKey",
    "scope",
    "createdAt",
    "updatedAt",
    "auditId",
    "operationId",
    "actorId",
    "operation",
    "action",
    "resource",
    "requestId",
    "reason",
    "idempotencyKey",
    "idempotencyRequestHash",
    "validatedPlanHash",
    "change",
    "capacity",
    "revisionsBefore",
    "revisionsAfter",
    "cacheTargetCount",
    "cacheTargetDigest",
    "committed",
    "changed",
    "changeDigest",
    "evidenceDigest",
    "cacheTargets",
    "replayResult",
    "resourceHash",
    "requestIdHash",
    "reconcileAvailableAt",
    "operationalState",
]);

function auditLookupError(by: "auditId" | "operationId") {
    return new PermissionCoreError("AUDIT_ENTRY_NOT_FOUND", `Audit entry was not found by ${by}.`, {
        details: { kind: "audit-lookup", by },
    });
}

function invalidAudit(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The persisted audit entry is malformed.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function assertNonEmpty(value: string, field: string) {
    if (typeof value !== "string" || !value) {
        throw new PermissionCoreError("INVALID_ARGUMENT", `${field} must be a non-empty string.`, {
            details: { kind: "validation", field, reason: "must be a non-empty string" },
        });
    }
}

function assertEpochMilliseconds(value: number, field: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new PermissionCoreError("INVALID_ARGUMENT", `${field} must be a non-negative epoch millisecond value.`, {
            details: { kind: "validation", field, reason: "must be a non-negative safe integer" },
        });
    }
}

function revisionVectorIssue(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return "must be an object";
    }
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).length !== REVISION_FIELDS.length
        || Object.keys(record).some((field) => !REVISION_FIELDS.includes(field as typeof REVISION_FIELDS[number]))
    ) {
        return "must contain only global/rbac/menu/audit/entities";
    }
    for (const name of ["global", "rbac", "menu", "audit"] as const) {
        if (!Number.isSafeInteger(record[name]) || (record[name] as number) < 0) {
            return `${name} must be a non-negative safe integer`;
        }
    }
    if (!Array.isArray(record.entities) || record.entities.length > 65) {
        return "entities must be an array with at most 65 items";
    }

    let previous: InternalEntityRevisionRef | undefined;
    for (const candidate of record.entities) {
        if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
            return "entity revision entries must be objects";
        }
        const entity = candidate as unknown as InternalEntityRevisionRef;
        const keys = Object.keys(candidate);
        if (
            keys.length !== ENTITY_REVISION_FIELDS.length
            || keys.some((field) => !ENTITY_REVISION_FIELDS.includes(field as typeof ENTITY_REVISION_FIELDS[number]))
            || !ENTITY_REVISION_KINDS.has(entity.kind)
            || typeof entity.id !== "string"
            || !entity.id
            || !Number.isSafeInteger(entity.revision)
            || entity.revision < 0
        ) {
            return "entity revision entries are malformed";
        }
        try {
            compareUtf8(entity.id, entity.id);
        } catch {
            return "entity revision identifiers must be well-formed Unicode";
        }
        if (previous) {
            let order: number;
            try {
                order = previous.kind === entity.kind
                    ? compareUtf8(previous.id, entity.id)
                    : compareUtf8(previous.kind, entity.kind);
            } catch {
                return "entity revision identifiers must be well-formed Unicode";
            }
            if (order >= 0) {
                return "entity revision entries must be sorted and unique by kind/id";
            }
        }
        previous = entity;
    }
    return undefined;
}

function assertRevisionVector(value: InternalRevisionVector, field: string) {
    const issue = revisionVectorIssue(value);
    if (issue) {
        throw new PermissionCoreError("INVALID_ARGUMENT", `${field} is invalid.`, {
            details: { kind: "validation", field, reason: issue },
        });
    }
}

function revisionTransitionIssue(
    before: InternalRevisionVector,
    after: InternalRevisionVector,
    changed: boolean,
    operation: InternalManagementAuditOperation,
    auditOnlyChange: boolean,
) {
    const globalDelta = after.global - before.global;
    const rbacDelta = after.rbac - before.rbac;
    const menuDelta = after.menu - before.menu;
    const auditDelta = after.audit - before.audit;
    const authorizationTransitionValid = [globalDelta, rbacDelta, menuDelta].every((delta) => delta === 0 || delta === 1)
        && globalDelta === Math.max(rbacDelta, menuDelta);
    const beforeEntities = before.entities;
    const afterEntities = after.entities;
    const changedEntityKinds: InternalEntityRevisionKind[] = [];
    const entityTransitionValid = beforeEntities.length === afterEntities.length
        && beforeEntities.every((beforeEntity, index) => {
            const afterEntity = afterEntities[index];
            const delta = afterEntity.revision - beforeEntity.revision;
            if (delta === 1) {
                changedEntityKinds.push(beforeEntity.kind);
            }
            return beforeEntity.kind === afterEntity.kind
                && beforeEntity.id === afterEntity.id
                && (delta === 0 || delta === 1)
                && (changed || delta === 0);
        });
    const domainOwner = DOMAIN_OWNER_BY_OPERATION[operation];
    const rbacOperationCanUseScopeOwner = RBAC_SCOPE_OWNER_OPERATIONS.has(operation);
    const changedRbacOwner = changedEntityKinds.some((kind) =>
        RBAC_ENTITY_REVISION_KINDS.has(kind) || (rbacOperationCanUseScopeOwner && kind === "scope"));
    const changedMenuOwner = changedEntityKinds.some((kind) => MENU_ENTITY_REVISION_KINDS.has(kind) || kind === "scope");
    const menuOperationCanRewriteRbac = MENU_RBAC_REWRITE_OPERATIONS.has(operation);
    const changedEntitiesBelongToMenuOperation = changedEntityKinds.every((kind) =>
        MENU_ENTITY_REVISION_KINDS.has(kind)
        || kind === "scope"
        || (menuOperationCanRewriteRbac && MENU_RBAC_REWRITE_ENTITY_KINDS.has(kind)));
    const operationOwnershipValid = !changed
        ? changedEntityKinds.length === 0
        : domainOwner === "audit"
            ? globalDelta === 0 && rbacDelta === 0 && menuDelta === 0 && changedEntityKinds.length === 0
            : domainOwner === "rbac"
                ? rbacDelta === 1
                    && menuDelta === 0
                    && changedRbacOwner
                    && changedEntityKinds.every((kind) =>
                        RBAC_ENTITY_REVISION_KINDS.has(kind) || (rbacOperationCanUseScopeOwner && kind === "scope"))
                : menuDelta === 1
                    && changedMenuOwner
                    && changedEntitiesBelongToMenuOperation
                    && (rbacDelta === 0 ? !changedRbacOwner : menuOperationCanRewriteRbac);
    if (
        !authorizationTransitionValid
        || !entityTransitionValid
        || !operationOwnershipValid
        || auditDelta !== 1
        || (!changed && globalDelta !== 0)
        || (auditOnlyChange && (globalDelta !== 0 || rbacDelta !== 0 || menuDelta !== 0))
        || (auditOnlyChange && (beforeEntities.length !== 0 || afterEntities.length !== 0))
        || (changed && !auditOnlyChange && globalDelta !== 1)
        || (changedEntityKinds.some((kind) => RBAC_ENTITY_REVISION_KINDS.has(kind)) && rbacDelta !== 1)
        || (changedEntityKinds.some((kind) => MENU_ENTITY_REVISION_KINDS.has(kind)) && menuDelta !== 1)
        || (changedEntityKinds.includes("scope") && globalDelta !== 1)
    ) {
        return "authorization/entity deltas violate domain ownership or audit sequencing";
    }
    return undefined;
}

function assertRevisionTransition(input: AuditAppendInput) {
    assertRevisionVector(input.revisionsBefore, "revisionsBefore");
    assertRevisionVector(input.revisionsAfter, "revisionsAfter");
    const issue = revisionTransitionIssue(
        input.revisionsBefore,
        input.revisionsAfter,
        input.changed,
        input.operation,
        input.operation === RECONCILE_OPERATION,
    );
    if (issue) {
        throw new PermissionCoreError("INVALID_ARGUMENT", "Audit revisions violate the v2 mutation contract.", {
            details: {
                kind: "validation",
                field: "revisionsAfter",
                reason: issue,
            },
        });
    }
}

function cloneRevisionVector(value: InternalRevisionVector): InternalRevisionVector {
    return {
        global: value.global,
        rbac: value.rbac,
        menu: value.menu,
        audit: value.audit,
        entities: value.entities.map((entity) => ({ ...entity })),
    };
}

function clonePolicyValue(value: PolicyValue): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

function snapshotPolicyValue(value: PolicyValue) {
    const canonical = canonicalString(value);
    return {
        value: JSON.parse(canonical) as PolicyValue,
        digest: sha256Base64Url(Buffer.from(canonical, "utf8")),
    };
}

function readOptions(session?: MongoSession) {
    return {
        cache: 0,
        collation: SIMPLE_COLLATION,
        ...(session ? { session } : {}),
    };
}

function writeOptions(session: MongoSession) {
    return {
        session,
        collation: SIMPLE_COLLATION,
        cache: { invalidate: false as const },
    };
}

function insertOptions(session: MongoSession) {
    return {
        session,
        cache: { invalidate: false as const },
    };
}

function immutableEvidence(document: Omit<InternalAuditEntryDocument, "evidenceDigest" | "operationalState" | "reconcileAvailableAt">) {
    return {
        scopeKey: document.scopeKey,
        scope: document.scope,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        auditId: document.auditId,
        operationId: document.operationId,
        actorId: document.actorId,
        operation: document.operation,
        action: document.action,
        ...(document.resource === undefined ? {} : { resource: document.resource }),
        ...(document.requestId === undefined ? {} : { requestId: document.requestId }),
        ...(document.reason === undefined ? {} : { reason: document.reason }),
        ...(document.idempotencyKey === undefined ? {} : { idempotencyKey: document.idempotencyKey }),
        idempotencyRequestHash: document.idempotencyRequestHash,
        ...(document.validatedPlanHash === undefined ? {} : { validatedPlanHash: document.validatedPlanHash }),
        change: document.change,
        ...(document.capacity === undefined ? {} : { capacity: document.capacity }),
        revisionsBefore: document.revisionsBefore,
        revisionsAfter: document.revisionsAfter,
        cacheTargetCount: document.cacheTargetCount,
        cacheTargetDigest: document.cacheTargetDigest,
        committed: document.committed,
        changed: document.changed,
        changeDigest: document.changeDigest,
        cacheTargets: document.cacheTargets,
        replayResult: document.replayResult,
        ...(document.resourceHash === undefined ? {} : { resourceHash: document.resourceHash }),
        ...(document.requestIdHash === undefined ? {} : { requestIdHash: document.requestIdHash }),
    };
}

function evidenceDigest(document: InternalAuditEntryDocument) {
    const { evidenceDigest: _digest, operationalState: _state, reconcileAvailableAt: _available, ...rest } = document;
    return digestCanonical(immutableEvidence(rest));
}

function publicAuditEntry(document: InternalAuditEntryDocument) {
    return {
        auditId: document.auditId,
        operationId: document.operationId,
        scope: document.scope,
        actorId: document.actorId,
        operation: document.operation,
        action: document.action,
        ...(document.resource === undefined ? {} : { resource: document.resource }),
        ...(document.requestId === undefined ? {} : { requestId: document.requestId }),
        ...(document.reason === undefined ? {} : { reason: document.reason }),
        ...(document.idempotencyKey === undefined ? {} : { idempotencyKey: document.idempotencyKey }),
        idempotencyRequestHash: document.idempotencyRequestHash,
        ...(document.validatedPlanHash === undefined ? {} : { validatedPlanHash: document.validatedPlanHash }),
        change: document.change,
        ...(document.capacity === undefined ? {} : { capacity: document.capacity }),
        revisionsBefore: document.revisionsBefore,
        revisionsAfter: document.revisionsAfter,
        cacheTargetCount: document.cacheTargetCount,
        cacheTargetDigest: document.cacheTargetDigest,
        committed: document.committed,
        createdAt: document.createdAt,
        operationalState: document.operationalState,
    };
}

function assertAuditDocumentBudgets(
    document: InternalAuditEntryDocument,
    changeAlreadyValidated = false,
) {
    if (!changeAlreadyValidated) {
        assertAuditChangeBudget(document.change);
    }
    assertCanonicalBudget(
        publicAuditEntry(document),
        "audit-public-entry",
        MAX_PUBLIC_AUDIT_ENTRY_BYTES,
    );
    assertInternalDocumentBudget(document);
}

function withOperationalState(
    current: InternalAuditEntryDocument,
    operationalState: InternalAuditOperationalState,
    reconcileAvailableAt?: number,
): InternalAuditEntryDocument {
    const { reconcileAvailableAt: _previousAvailability, ...immutable } = current;
    return {
        ...immutable,
        operationalState,
        ...(reconcileAvailableAt === undefined ? {} : { reconcileAvailableAt }),
    };
}

function assertOperationalState(value: unknown): asserts value is InternalAuditOperationalState {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        invalidAudit("operationalState must be an object");
    }
    const record = value as Record<string, unknown>;
    const unexpected = Object.keys(record).find((key) => ![
        "cacheOutcome",
        "cacheReconcileClaim",
        "reconcileOperation",
        "updatedAt",
    ].includes(key));
    if (unexpected) {
        invalidAudit(`operationalState.${unexpected} is not mutable state`);
    }
    if (!CACHE_OUTCOMES.has(record.cacheOutcome as InternalCacheOutcome)) {
        invalidAudit("operationalState.cacheOutcome is invalid");
    }
    if (!Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < 0) {
        invalidAudit("operationalState.updatedAt is invalid");
    }
    if (record.cacheReconcileClaim !== undefined) {
        const claim = record.cacheReconcileClaim;
        if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
            invalidAudit("operationalState.cacheReconcileClaim is invalid");
        }
        const claimRecord = claim as Record<string, unknown>;
        if (
            Object.keys(claimRecord).some((key) => !["operationId", "expiresAt"].includes(key))
            || typeof claimRecord.operationId !== "string"
            || !claimRecord.operationId
            || !Number.isSafeInteger(claimRecord.expiresAt)
            || (claimRecord.expiresAt as number) < 0
        ) {
            invalidAudit("operationalState.cacheReconcileClaim is invalid");
        }
    }
    if (record.reconcileOperation !== undefined) {
        try {
            assertCanonicalBudget(
                record.reconcileOperation,
                "audit-reconcile-operation",
                MAX_INTERNAL_DOCUMENT_BYTES,
            );
        } catch {
            invalidAudit("operationalState.reconcileOperation is invalid");
        }
    }
}

function materialize(raw: Record<string, unknown>, expectedScopeKey: string): InternalAuditEntryDocument {
    const unknownField = Object.keys(raw).find((key) => key !== "_id" && !AUDIT_FIELDS.has(key));
    if (unknownField) {
        invalidAudit(`unexpected field ${unknownField}`);
    }
    const { _id: _ignored, ...plain } = raw;
    const document = plain as unknown as InternalAuditEntryDocument;
    let normalizedScope: Readonly<PermissionScope>;
    let persistedScopeKey: string;
    try {
        normalizedScope = normalizeScope(document.scope);
        persistedScopeKey = createScopeKey(normalizedScope);
    } catch {
        invalidAudit("scope identity is malformed");
    }
    if (
        document.scopeKey !== expectedScopeKey
        || persistedScopeKey !== expectedScopeKey
        || canonicalString(document.scope) !== canonicalString(normalizedScope)
    ) {
        invalidAudit("scope identity is inconsistent");
    }
    for (const field of [
        "auditId",
        "operationId",
        "actorId",
        "operation",
        "action",
        "idempotencyRequestHash",
        "changeDigest",
        "cacheTargetDigest",
        "evidenceDigest",
    ] as const) {
        if (typeof document[field] !== "string" || !document[field]) {
            invalidAudit(`${field} must be a non-empty string`);
        }
    }
    if (
        !DIGEST_PATTERN.test(document.idempotencyRequestHash)
        || !DIGEST_PATTERN.test(document.changeDigest)
        || !DIGEST_PATTERN.test(document.cacheTargetDigest)
        || !DIGEST_PATTERN.test(document.evidenceDigest)
    ) {
        invalidAudit("audit digest metadata is invalid");
    }
    if (!isAuditOperationAction(document.operation, document.action)) {
        invalidAudit("operation/action taxonomy is invalid");
    }
    if (
        document.committed !== true
        || typeof document.changed !== "boolean"
        || !Number.isSafeInteger(document.createdAt)
        || !Number.isSafeInteger(document.updatedAt)
        || document.createdAt < 0
        || document.updatedAt !== document.createdAt
    ) {
        invalidAudit("committed evidence metadata is invalid");
    }
    if (
        cacheTargetsIssue(document.cacheTargets, true)
        || !Number.isSafeInteger(document.cacheTargetCount)
        || document.cacheTargetCount !== document.cacheTargets.length
    ) {
        invalidAudit("cache target evidence is invalid");
    }
    for (const vector of [document.revisionsBefore, document.revisionsAfter]) {
        const issue = revisionVectorIssue(vector);
        if (issue) {
            invalidAudit(`revision evidence is invalid: ${issue}`);
        }
    }
    const transitionIssue = revisionTransitionIssue(
        document.revisionsBefore,
        document.revisionsAfter,
        document.changed,
        document.operation,
        document.operation === RECONCILE_OPERATION,
    );
    if (transitionIssue) {
        invalidAudit(`revision transition is inconsistent: ${transitionIssue}`);
    }
    if (
        (document.idempotencyKey !== undefined && (typeof document.idempotencyKey !== "string" || !document.idempotencyKey))
        || (document.validatedPlanHash !== undefined
            && (typeof document.validatedPlanHash !== "string" || !DIGEST_PATTERN.test(document.validatedPlanHash)))
        || (document.resource !== undefined && (typeof document.resource !== "string" || !document.resource))
        || (document.requestId !== undefined && (typeof document.requestId !== "string" || !document.requestId))
        || (document.reason !== undefined && typeof document.reason !== "string")
        || (document.resource === undefined) !== (document.resourceHash === undefined)
        || (document.requestId === undefined) !== (document.requestIdHash === undefined)
        || (document.resourceHash !== undefined
            && (typeof document.resourceHash !== "string" || !DIGEST_PATTERN.test(document.resourceHash)))
        || (document.requestIdHash !== undefined
            && (typeof document.requestIdHash !== "string" || !DIGEST_PATTERN.test(document.requestIdHash)))
    ) {
        invalidAudit("optional identity/hash evidence is inconsistent");
    }
    assertOperationalState(document.operationalState);
    if (document.operationalState.updatedAt < document.createdAt) {
        invalidAudit("operational state predates immutable evidence");
    }
    const isReconcileAudit = document.operation === RECONCILE_OPERATION;
    const claim = document.operationalState.cacheReconcileClaim;
    if (
        (document.reconcileAvailableAt !== undefined
            && (!Number.isSafeInteger(document.reconcileAvailableAt) || document.reconcileAvailableAt < 0))
        || (document.operationalState.cacheOutcome === "pending" && document.reconcileAvailableAt === undefined)
        || (document.operationalState.cacheOutcome !== "pending" && document.reconcileAvailableAt !== undefined)
        || (claim !== undefined && claim.expiresAt !== document.reconcileAvailableAt)
        || (document.operationalState.cacheOutcome === "pending" && claim === undefined && document.reconcileAvailableAt !== 0)
        || (!document.changed && document.operationalState.cacheOutcome !== "not-needed")
        || (document.changed && !isReconcileAudit && document.operationalState.cacheOutcome === "not-needed")
        || (isReconcileAudit && document.operationalState.cacheOutcome !== "not-needed")
        || (isReconcileAudit && claim !== undefined)
        || (isReconcileAudit && document.reconcileAvailableAt !== undefined)
        || (!isReconcileAudit && document.operationalState.reconcileOperation !== undefined)
        || (!document.changed && document.cacheTargets.length !== 0)
    ) {
        invalidAudit("reconcile availability is inconsistent with operational state");
    }
    try {
        assertAuditDocumentBudgets(document);
        if (digestCanonical(document.change) !== document.changeDigest) {
            invalidAudit("change digest does not match");
        }
        if (digestCanonical(document.cacheTargets) !== document.cacheTargetDigest) {
            invalidAudit("cache target digest does not match");
        }
        if (document.resource !== undefined && digestCanonical(document.resource) !== document.resourceHash) {
            invalidAudit("resource hash does not match");
        }
        if (document.requestId !== undefined && digestCanonical(document.requestId) !== document.requestIdHash) {
            invalidAudit("request hash does not match");
        }
        if (evidenceDigest(document) !== document.evidenceDigest) {
            invalidAudit("immutable evidence digest does not match");
        }
    } catch (error) {
        if (error instanceof PermissionCoreError && error.code === "PERSISTED_STATE_INVALID") {
            throw error;
        }
        invalidAudit(error instanceof CanonicalEncodingError || error instanceof PermissionCoreError
            ? "document evidence validation failed"
            : "persisted evidence validation failed");
    }
    return deepFreeze(document);
}

export class AuditStore {
    constructor(
        private readonly collection: InternalPermissionCollection,
        private readonly findMaxLimit: number,
    ) {}

    async append(input: AuditAppendInput, session: MongoSession) {
        for (const [field, value] of Object.entries({
            auditId: input.auditId,
            operationId: input.operationId,
            actorId: input.actorId,
            operation: input.operation,
            action: input.action,
            idempotencyRequestHash: input.idempotencyRequestHash,
        })) {
            assertNonEmpty(value, field);
        }
        if (!isAuditOperationAction(input.operation, input.action)) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Audit operation/action taxonomy is invalid.", {
                details: {
                    kind: "validation",
                    field: "action",
                    reason: "must be the action declared for the management operation",
                },
            });
        }
        if (typeof input.changed !== "boolean") {
            throw new PermissionCoreError("INVALID_ARGUMENT", "changed must be a boolean.", {
                details: { kind: "validation", field: "changed", reason: "must be a boolean" },
            });
        }
        if (input.resource !== undefined) {
            assertNonEmpty(input.resource, "resource");
        }
        if (input.requestId !== undefined) {
            assertNonEmpty(input.requestId, "requestId");
        }
        if (input.reason !== undefined && typeof input.reason !== "string") {
            throw new PermissionCoreError("INVALID_ARGUMENT", "reason must be a string.", {
                details: { kind: "validation", field: "reason", reason: "must be a string" },
            });
        }
        if (input.idempotencyKey !== undefined) {
            assertNonEmpty(input.idempotencyKey, "idempotencyKey");
        }
        for (const [field, value] of Object.entries({
            idempotencyRequestHash: input.idempotencyRequestHash,
            ...(input.validatedPlanHash === undefined ? {} : { validatedPlanHash: input.validatedPlanHash }),
        })) {
            if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
                throw new PermissionCoreError("INVALID_ARGUMENT", `${field} must be a canonical digest.`, {
                    details: { kind: "validation", field, reason: "must be a 43-character SHA-256 base64url digest" },
                });
            }
        }
        if (!CACHE_OUTCOMES.has(input.cacheOutcome)) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "cacheOutcome is invalid.", {
                details: { kind: "validation", field: "cacheOutcome", reason: "is not a supported cache outcome" },
            });
        }
        if (!Array.isArray(input.cacheTargets)) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Audit cache targets are invalid.", {
                details: { kind: "validation", field: "cacheTargets", reason: "must be an array" },
            });
        }
        if (input.cacheTargets.length > 1000) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "Audit cache targets exceed 1000 items.", {
                details: {
                    kind: "limit-exceeded",
                    origin: "persisted-authorization-state",
                    limitName: "audit-cache-targets",
                    current: input.cacheTargets.length,
                    max: 1000,
                    unit: "items",
                },
            });
        }
        const targetIssue = cacheTargetsIssue(input.cacheTargets, false);
        if (targetIssue) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Audit cache targets are invalid.", {
                details: { kind: "validation", field: "cacheTargets", reason: targetIssue },
            });
        }
        const isReconcileAudit = input.operation === RECONCILE_OPERATION;
        const initialStateValid = isReconcileAudit
            ? input.cacheOutcome === "not-needed" && (input.changed || input.cacheTargets.length === 0)
            : input.changed
                ? input.cacheOutcome === "pending"
                : input.cacheOutcome === "not-needed" && input.cacheTargets.length === 0;
        if (!initialStateValid) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Initial audit cache state is inconsistent with the mutation result.", {
                details: {
                    kind: "validation",
                    field: "cacheOutcome",
                    reason: "ordinary changed writes start pending; reconcile audits are not-needed; unchanged writes have no cache targets",
                },
            });
        }
        assertEpochMilliseconds(input.now, "now");
        assertRevisionTransition(input);
        assertAuditChangeBudget(input.change);
        assertCanonicalBudget(
            {
                ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
                replayResult: input.replayResult,
            },
            "audit-result-state",
            MAX_INTERNAL_DOCUMENT_BYTES,
        );

        const scope = normalizeScope(input.scope);
        const scopeKey = createScopeKey(scope);
        const cacheTargets = Object.freeze([...input.cacheTargets].sort(compareUtf8));
        const changeSnapshot = snapshotPolicyValue(input.change);
        const change = changeSnapshot.value;
        const capacity = input.capacity === undefined ? undefined : clonePolicyValue(input.capacity);
        const replayResult = clonePolicyValue(input.replayResult);
        assertCanonicalBudget(
            cacheTargets,
            "audit-cache-targets",
            MAX_INTERNAL_DOCUMENT_BYTES,
        );
        const cacheTargetDigest = digestCanonical(cacheTargets);
        const changeDigest = changeSnapshot.digest;

        const withoutDigest = {
            scopeKey,
            scope,
            createdAt: input.now,
            updatedAt: input.now,
            auditId: input.auditId,
            operationId: input.operationId,
            actorId: input.actorId,
            operation: input.operation,
            action: input.action,
            ...(input.resource === undefined ? {} : { resource: input.resource, resourceHash: digestCanonical(input.resource) }),
            ...(input.requestId === undefined ? {} : { requestId: input.requestId, requestIdHash: digestCanonical(input.requestId) }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            idempotencyRequestHash: input.idempotencyRequestHash,
            ...(input.validatedPlanHash === undefined ? {} : { validatedPlanHash: input.validatedPlanHash }),
            change,
            ...(capacity === undefined ? {} : { capacity }),
            revisionsBefore: cloneRevisionVector(input.revisionsBefore),
            revisionsAfter: cloneRevisionVector(input.revisionsAfter),
            cacheTargetCount: cacheTargets.length,
            cacheTargetDigest,
            committed: true as const,
            changed: input.changed,
            changeDigest,
            cacheTargets,
            replayResult,
        };
        const operationalState: InternalAuditOperationalState = {
            cacheOutcome: input.cacheOutcome,
            updatedAt: input.now,
        };
        const provisionalDocument = {
            ...withoutDigest,
            evidenceDigest: DIGEST_PLACEHOLDER,
            ...(input.cacheOutcome === "pending" ? { reconcileAvailableAt: 0 } : {}),
            operationalState,
        } satisfies InternalAuditEntryDocument;

        assertAuditDocumentBudgets(provisionalDocument, true);
        const document = {
            ...provisionalDocument,
            evidenceDigest: digestCanonical(immutableEvidence(withoutDigest)),
        } satisfies InternalAuditEntryDocument;
        await this.collection.insertOne({ ...document }, insertOptions(session));
        return deepFreeze(document);
    }

    async getByAuditId(scopeInput: PermissionScope, auditId: string, session?: MongoSession) {
        assertNonEmpty(auditId, "auditId");
        const scopeKey = createScopeKey(normalizeScope(scopeInput));
        const raw = await this.collection.findOne({ scopeKey, auditId }, readOptions(session));
        if (raw === null) {
            throw auditLookupError("auditId");
        }
        return materialize(raw, scopeKey);
    }

    async getByOperationId(scopeInput: PermissionScope, operationId: string, session?: MongoSession) {
        assertNonEmpty(operationId, "operationId");
        const scopeKey = createScopeKey(normalizeScope(scopeInput));
        const raw = await this.collection.findOne({ scopeKey, operationId }, readOptions(session));
        if (raw === null) {
            throw auditLookupError("operationId");
        }
        return materialize(raw, scopeKey);
    }

    async findIdempotentReplay(
        scopeInput: PermissionScope,
        actorId: string,
        operation: InternalManagementAuditOperation,
        idempotencyKey: string,
        requestHash: string,
        session?: MongoSession,
    ) {
        assertNonEmpty(actorId, "actorId");
        assertNonEmpty(operation, "operation");
        assertNonEmpty(idempotencyKey, "idempotencyKey");
        assertNonEmpty(requestHash, "requestHash");
        if (!Object.hasOwn(ACTIONS_BY_OPERATION, operation)) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "operation is not a management audit operation.", {
                details: { kind: "validation", field: "operation", reason: "is not supported" },
            });
        }
        if (!DIGEST_PATTERN.test(requestHash)) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "requestHash must be a canonical digest.", {
                details: {
                    kind: "validation",
                    field: "requestHash",
                    reason: "must be a 43-character SHA-256 base64url digest",
                },
            });
        }
        const scopeKey = createScopeKey(normalizeScope(scopeInput));
        const raw = await this.collection.findOne({
            scopeKey,
            actorId,
            operation,
            idempotencyKey,
        }, readOptions(session));
        if (raw === null) {
            return null;
        }
        const document = materialize(raw, scopeKey);
        if (document.idempotencyRequestHash !== requestHash) {
            throw new PermissionCoreError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for different input.", {
                details: { kind: "validation", field: "idempotencyKey", reason: "request hash differs" },
            });
        }
        return document;
    }

    async recordCacheOutcome(
        scopeInput: PermissionScope,
        operationId: string,
        expected: "pending",
        outcome: ReconciledCacheOutcome,
        now: number,
        session: MongoSession,
    ) {
        assertEpochMilliseconds(now, "now");
        assertNonEmpty(operationId, "operationId");
        if (expected !== "pending" || !isReconciledCacheOutcome(outcome)) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Cache outcome transition is invalid.", {
                details: { kind: "validation", field: "outcome", reason: "must transition from a known outcome to a terminal outcome" },
            });
        }
        const current = await this.getByOperationId(scopeInput, operationId, session);
        if (now < current.operationalState.updatedAt) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Cache outcome time cannot move backwards.", {
                details: { kind: "validation", field: "now", reason: "precedes the current operational update" },
            });
        }
        const {
            cacheReconcileClaim: _claim,
            ...retainedOperationalState
        } = current.operationalState;
        const nextDocument = withOperationalState(current, {
            ...retainedOperationalState,
            cacheOutcome: outcome,
            updatedAt: now,
        });
        assertAuditDocumentBudgets(nextDocument, true);
        const result = await this.collection.updateOne({
            scopeKey: current.scopeKey,
            operationId,
            evidenceDigest: current.evidenceDigest,
            "operationalState.cacheOutcome": expected,
        }, {
            $set: {
                "operationalState.cacheOutcome": outcome,
                "operationalState.updatedAt": now,
            },
            $unset: {
                "operationalState.cacheReconcileClaim": "",
                reconcileAvailableAt: "",
            },
        }, writeOptions(session));
        if (result.matchedCount !== 1) {
            return null;
        }
        return this.getByOperationId(scopeInput, operationId, session);
    }

    async claimCacheOutcome(
        scopeInput: PermissionScope,
        targetOperationId: string,
        reconcileOperationId: string,
        now: number,
        expiresAt: number,
        session: MongoSession,
    ) {
        assertEpochMilliseconds(now, "now");
        assertEpochMilliseconds(expiresAt, "expiresAt");
        assertNonEmpty(targetOperationId, "targetOperationId");
        assertNonEmpty(reconcileOperationId, "reconcileOperationId");
        if (expiresAt <= now) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "expiresAt must be later than now.", {
                details: { kind: "validation", field: "expiresAt", reason: "must be later than now" },
            });
        }
        const current = await this.getByOperationId(scopeInput, targetOperationId, session);
        if (now < current.operationalState.updatedAt) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Claim time cannot move backwards.", {
                details: { kind: "validation", field: "now", reason: "precedes the current operational update" },
            });
        }
        const nextDocument = withOperationalState(current, {
            ...current.operationalState,
            cacheReconcileClaim: {
                operationId: reconcileOperationId,
                expiresAt,
            },
            updatedAt: now,
        }, expiresAt);
        assertAuditDocumentBudgets(nextDocument, true);
        const result = await this.collection.updateOne({
            scopeKey: current.scopeKey,
            operationId: targetOperationId,
            evidenceDigest: current.evidenceDigest,
            "operationalState.cacheOutcome": "pending",
            $or: [
                { "operationalState.cacheReconcileClaim": { $exists: false } },
                { "operationalState.cacheReconcileClaim.expiresAt": { $lte: now } },
            ],
        }, {
            $set: {
                "operationalState.cacheReconcileClaim": {
                    operationId: reconcileOperationId,
                    expiresAt,
                },
                "operationalState.updatedAt": now,
                reconcileAvailableAt: expiresAt,
            },
        }, writeOptions(session));
        if (result.matchedCount !== 1) {
            return null;
        }
        return this.getByOperationId(scopeInput, targetOperationId, session);
    }

    async completeClaim(
        scopeInput: PermissionScope,
        targetOperationId: string,
        reconcileOperationId: string,
        outcome: ReconciledCacheOutcome,
        now: number,
        session: MongoSession,
    ) {
        assertEpochMilliseconds(now, "now");
        assertNonEmpty(targetOperationId, "targetOperationId");
        assertNonEmpty(reconcileOperationId, "reconcileOperationId");
        if (!isReconciledCacheOutcome(outcome)) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Claim completion requires a terminal cache outcome.", {
                details: { kind: "validation", field: "outcome", reason: "must be a terminal cache outcome" },
            });
        }
        const current = await this.getByOperationId(scopeInput, targetOperationId, session);
        if (now < current.operationalState.updatedAt) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Completion time cannot move backwards.", {
                details: { kind: "validation", field: "now", reason: "precedes the current operational update" },
            });
        }
        const {
            cacheReconcileClaim: _claim,
            ...retainedOperationalState
        } = current.operationalState;
        const nextDocument = withOperationalState(current, {
            ...retainedOperationalState,
            cacheOutcome: outcome,
            updatedAt: now,
        });
        assertAuditDocumentBudgets(nextDocument, true);
        const result = await this.collection.updateOne({
            scopeKey: current.scopeKey,
            operationId: targetOperationId,
            evidenceDigest: current.evidenceDigest,
            "operationalState.cacheOutcome": "pending",
            "operationalState.cacheReconcileClaim.operationId": reconcileOperationId,
        }, {
            $set: {
                "operationalState.cacheOutcome": outcome,
                "operationalState.updatedAt": now,
            },
            $unset: {
                "operationalState.cacheReconcileClaim": "",
                reconcileAvailableAt: "",
            },
        }, writeOptions(session));
        if (result.matchedCount !== 1) {
            return null;
        }
        return this.getByOperationId(scopeInput, targetOperationId, session);
    }

    async recordReconcileOperation(
        scopeInput: PermissionScope,
        operationId: string,
        reconcileOperation: PolicyValue,
        now: number,
        session: MongoSession,
    ) {
        assertEpochMilliseconds(now, "now");
        assertNonEmpty(operationId, "operationId");
        assertCanonicalBudget(
            reconcileOperation,
            "audit-reconcile-operation",
            MAX_INTERNAL_DOCUMENT_BYTES,
        );
        const normalizedOperation = clonePolicyValue(reconcileOperation);
        const current = await this.getByOperationId(scopeInput, operationId, session);
        if (current.operation !== "audit.reconcileCacheOutcomes") {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Only a reconcile audit may store reconcile operation state.", {
                details: { kind: "validation", field: "operationId", reason: "does not identify a reconcile audit" },
            });
        }
        if (now < current.operationalState.updatedAt) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Reconcile operation time cannot move backwards.", {
                details: { kind: "validation", field: "now", reason: "precedes the current operational update" },
            });
        }
        const nextDocument = withOperationalState(current, {
            ...current.operationalState,
            reconcileOperation: normalizedOperation,
            updatedAt: now,
        });
        assertAuditDocumentBudgets(nextDocument, true);
        const result = await this.collection.updateOne({
            scopeKey: current.scopeKey,
            operationId,
            evidenceDigest: current.evidenceDigest,
            "operationalState.updatedAt": current.operationalState.updatedAt,
            ...(current.operationalState.reconcileOperation === undefined
                ? { "operationalState.reconcileOperation": { $exists: false } }
                : { "operationalState.reconcileOperation": current.operationalState.reconcileOperation }),
        }, {
            $set: {
                "operationalState.reconcileOperation": normalizedOperation,
                "operationalState.updatedAt": now,
            },
        }, writeOptions(session));
        if (result.matchedCount !== 1) {
            return null;
        }
        return this.getByOperationId(scopeInput, operationId, session);
    }

    async listAvailablePending(scopeInput: PermissionScope, now: number, limit: number) {
        assertEpochMilliseconds(now, "now");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "Reconcile limit must be between 1 and 1000.", {
                details: { kind: "validation", field: "limit", reason: "must be a safe integer between 1 and 1000" },
            });
        }
        const scopeKey = createScopeKey(normalizeScope(scopeInput));
        const documents: InternalAuditEntryDocument[] = [];
        let after: { reconcileAvailableAt: number; createdAt: number; auditId: string } | undefined;
        while (documents.length < limit) {
            const base = {
                scopeKey,
                "operationalState.cacheOutcome": "pending",
                reconcileAvailableAt: { $lte: now },
            };
            const filter = after === undefined
                ? base
                : {
                    $and: [
                        base,
                        {
                            $or: [
                                { reconcileAvailableAt: { $gt: after.reconcileAvailableAt } },
                                {
                                    reconcileAvailableAt: after.reconcileAvailableAt,
                                    createdAt: { $gt: after.createdAt },
                                },
                                {
                                    reconcileAvailableAt: after.reconcileAvailableAt,
                                    createdAt: after.createdAt,
                                    auditId: { $gt: after.auditId },
                                },
                            ],
                        },
                    ],
                };
            const pageSize = Math.min(this.findMaxLimit, limit - documents.length);
            const rows = await this.collection.find(filter, {
                cache: 0,
                collation: SIMPLE_COLLATION,
                hint: "pc_audit_reconcile_queue",
            })
                .sort({ reconcileAvailableAt: 1, createdAt: 1, auditId: 1 })
                .limit(pageSize)
                .toArray();
            if (rows.length === 0) {
                break;
            }
            for (const row of rows) {
                const document = materialize(row, scopeKey);
                const availableAt = document.reconcileAvailableAt;
                if (availableAt === undefined) {
                    invalidAudit("pending reconcile row is missing reconcileAvailableAt");
                }
                if (
                    after !== undefined
                    && (
                        availableAt < after.reconcileAvailableAt
                        || (
                            availableAt === after.reconcileAvailableAt
                            && document.createdAt < after.createdAt
                        )
                        || (
                            availableAt === after.reconcileAvailableAt
                            && document.createdAt === after.createdAt
                            && compareUtf8(document.auditId, after.auditId) <= 0
                        )
                    )
                ) {
                    invalidAudit("pending reconcile keyset did not advance");
                }
                after = {
                    reconcileAvailableAt: availableAt,
                    createdAt: document.createdAt,
                    auditId: document.auditId,
                };
                documents.push(document);
            }
            if (rows.length < pageSize) {
                break;
            }
        }
        return Object.freeze(documents);
    }
}
