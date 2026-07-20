import type {
    PermissionAction,
    PermissionScope,
    PolicyValue,
    RowCondition,
    MenuConfigSnapshot,
    MenuGrantIntent,
    MenuGrantSnapshotRef,
} from "../types";
import {
    CanonicalByteLimitError,
    CanonicalEncodingError,
    canonicalByteLength,
} from "../internal/canonical";
import {
    BsonByteLimitError,
    BsonEncodingError,
    bsonDocumentByteLengthUpperBound,
} from "../internal/bson-size";
import { PermissionCoreError } from "../core/errors";

export const PERSISTED_SCHEMA_VERSION = 3 as const;
export const MAX_INTERNAL_DOCUMENT_BYTES = 12 * 1024 * 1024;
export const INTERNAL_BSON_GENERATED_ID_BYTES = 17;
export const MAX_AUDIT_CHANGE_BYTES = 8 * 1024 * 1024;
export const MAX_PUBLIC_AUDIT_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_MENU_CONFIG_BYTES = 1024 * 1024;
export const MAX_ROLE_MENU_GRANT_BYTES = 1024 * 1024;

export const INTERNAL_COLLECTION_SUFFIXES = Object.freeze({
    roles: "_roles",
    roleRules: "_role_rules",
    userRoleSets: "_user_role_sets",
    roleMenuGrants: "_role_menu_grants",
    menuConfigs: "_menu_configs",
    menuNodes: "_menu_nodes",
    apiBindings: "_api_bindings",
    scopeState: "_scope_state",
    auditEntries: "_audit_entries",
} as const);

export type InternalCollectionKey = keyof typeof INTERNAL_COLLECTION_SUFFIXES;

export interface InternalBaseDocument {
    scopeKey: string;
    scope: Readonly<PermissionScope>;
    createdAt: number;
    updatedAt: number;
}

export interface InternalRoleDocument extends InternalBaseDocument {
    roleId: string;
    label: string;
    description?: string;
    status: "enabled" | "disabled" | "deprecated";
    parentId: string | null;
    revision: number;
    menuGrantCount: number;
    menuGrantDigest: string;
    menuSourceCount: number;
    menuSourceDigest: string;
}

export type InternalRoleRuleSource =
    | {
        sourceId: string;
        kind: "manual";
    }
    | {
        sourceId: string;
        kind: "menu";
        grantId: string;
        grantRevision: number;
        effect: "allow" | "deny";
        contribution: "node";
        assetId: string;
    }
    | {
        sourceId: string;
        kind: "menu";
        grantId: string;
        grantRevision: number;
        effect: "allow" | "deny";
        contribution: "api";
        assetId: string;
        apiBindingId: string;
    }
    | {
        sourceId: string;
        kind: "menu";
        grantId: string;
        grantRevision: number;
        effect: "allow" | "deny";
        contribution: "data";
        assetId: string;
        dataResource: string;
    };

export interface InternalRoleRuleDocument extends InternalBaseDocument {
    roleId: string;
    effect: "allow" | "deny";
    action: string;
    resource: string;
    where?: RowCondition;
    semanticKey: string;
    sources: readonly InternalRoleRuleSource[];
    revision: number;
}

export interface InternalUserRoleSetDocument extends InternalBaseDocument {
    userId: string;
    roleIds: readonly string[];
    revision: number;
}

export interface InternalRoleMenuGrantDocument extends InternalBaseDocument {
    roleId: string;
    grantId: string;
    effect: "allow" | "deny";
    intent: MenuGrantIntent;
    snapshot: MenuGrantSnapshotRef & {
        contributingAssetIds: readonly string[];
        contributingBindingIds: readonly string[];
    };
    grantRevision: number;
}

export interface InternalMenuConfigDocument extends InternalBaseDocument {
    configId: string;
    title?: string;
    config: MenuConfigSnapshot;
    configDigest: string;
    aggregateDigest: string;
    configRevision: number;
    menuCount: number;
    viewCount: number;
    actionCount: number;
    apiCount: number;
    responseFieldCount: number;
    responseFieldOwnerCount: number;
    configBytes: number;
    compiledMenuNodeCount: number;
    compiledApiBindingCount: number;
    compiledManifestBytes: number;
}

export interface InternalMenuPermission {
    action: PermissionAction;
    resource: string;
}

export interface InternalMenuDataPermission {
    action: "read" | "create" | "update" | "delete" | "write" | "*";
    resource: string;
    where?: RowCondition;
    label?: string;
}

export interface InternalMenuNodeDocument extends InternalBaseDocument {
    nodeId: string;
    parentId: string | null;
    type: "directory" | "menu" | "page" | "button" | "external" | "iframe";
    title: string;
    path?: string;
    name?: string;
    code?: string;
    component?: string;
    url?: string;
    icon?: string;
    order: number;
    status: "enabled" | "disabled" | "deprecated";
    hidden: boolean;
    i18nKey?: string;
    meta?: Readonly<Record<string, PolicyValue>>;
    permission?: InternalMenuPermission;
    dataPermissions?: readonly InternalMenuDataPermission[];
    revision: number;
    manifestItemBytes: number;
}

export interface InternalApiPermissionRequirement {
    action: PermissionAction;
    resource: string;
}

export interface InternalApiOwnerRelation {
    type: "menu" | "page" | "button";
    id: string;
    required: boolean;
    availabilityGroup?: string;
    availabilityMode?: "all" | "any";
}

export interface InternalApiBindingDocument extends InternalBaseDocument {
    bindingId: string;
    method: string;
    path: string;
    purpose: "entry" | "lookup" | "detail" | "operation" | "importExport" | "background";
    authorization: {
        mode: "all" | "any";
        permissions: readonly InternalApiPermissionRequirement[];
    };
    owners: readonly InternalApiOwnerRelation[];
    canonicalOwner?: { type: "menu" | "page" | "button"; id: string };
    status: "enabled" | "disabled" | "deprecated";
    description?: string;
    revision: number;
    manifestItemBytes: number;
}

export interface InternalScopeStateDocument extends InternalBaseDocument {
    schemaVersion: typeof PERSISTED_SCHEMA_VERSION;
    schemeContractDigest: string;
    schemaContractKey: string;
    revision: number;
    rbacRevision: number;
    menuRevision: number;
    auditRevision: number;
    menuConfigCount: number;
    menuConfigBytes: number;
    menuNodeCount: number;
    apiBindingCount: number;
    responseFieldCount: number;
    responseFieldOwnerCount: number;
    replaceManifestBytes: number;
}

export interface InternalScopeRevisionVector {
    global: number;
    rbac: number;
    menu: number;
    audit: number;
}

export type InternalEntityRevisionKind =
    | "role"
    | "user-role-set"
    | "role-menu-grant"
    | "menu-config"
    | "menu-node"
    | "api-binding"
    | "scope";

export interface InternalEntityRevisionRef {
    kind: InternalEntityRevisionKind;
    id: string;
    revision: number;
}

export interface InternalRevisionVector extends InternalScopeRevisionVector {
    entities: readonly InternalEntityRevisionRef[];
}

export type InternalManagementAuditAction =
    | "create"
    | "update"
    | "remove"
    | "allow"
    | "deny"
    | "grant"
    | "revoke"
    | "assign"
    | "set"
    | "clear"
    | "replace"
    | "move"
    | "reorder"
    | "import"
    | "repair"
    | "reconcile";

export type InternalManagementAuditOperation =
    | "roles.create"
    | "roles.update"
    | "roles.executeAccessUpdate"
    | "roles.remove"
    | "roles.allow"
    | "roles.deny"
    | "roles.revoke"
    | "roles.executeRuleChange"
    | "roles.replaceRules"
    | "userRoles.assign"
    | "userRoles.revoke"
    | "userRoles.set"
    | "userRoles.clear"
    | "menus.create"
    | "menus.update"
    | "menus.executeUpdate"
    | "menus.move"
    | "menus.reorder"
    | "menus.setStatus"
    | "menus.remove"
    | "menus.repairStaleReferences"
    | "menus.manifest.import"
    | "menus.config.save"
    | "menus.config.remove"
    | "menus.config.applyChanges"
    | "apiBindings.create"
    | "apiBindings.update"
    | "apiBindings.setStatus"
    | "apiBindings.executeUpdate"
    | "apiBindings.remove"
    | "apiBindings.replace"
    | "roles.menuPermissions.grant"
    | "roles.menuPermissions.deny"
    | "roles.menuPermissions.revoke"
    | "roles.menuPermissions.set"
    | "roles.menuPermissions.repairStale"
    | "audit.reconcileCacheOutcomes";

export type InternalCacheOutcome = "pending" | "not-needed" | "completed" | "bypassed" | "degraded";

export interface InternalAuditReconcileClaim {
    operationId: string;
    expiresAt: number;
}

export interface InternalAuditOperationalState {
    cacheOutcome: InternalCacheOutcome;
    cacheReconcileClaim?: InternalAuditReconcileClaim;
    reconcileOperation?: PolicyValue;
    updatedAt: number;
}

export interface InternalAuditEntryDocument extends InternalBaseDocument {
    auditId: string;
    operationId: string;
    actorId: string;
    operation: InternalManagementAuditOperation;
    action: InternalManagementAuditAction;
    resource?: string;
    requestId?: string;
    reason?: string;
    idempotencyKey?: string;
    idempotencyRequestHash: string;
    validatedPlanHash?: string;
    change: PolicyValue;
    capacity?: PolicyValue;
    revisionsBefore: InternalRevisionVector;
    revisionsAfter: InternalRevisionVector;
    cacheTargetCount: number;
    cacheTargetDigest: string;
    committed: true;
    changed: boolean;
    changeDigest: string;
    evidenceDigest: string;
    cacheTargets: readonly string[];
    replayResult: PolicyValue;
    resourceHash?: string;
    requestIdHash?: string;
    reconcileAvailableAt?: number;
    operationalState: InternalAuditOperationalState;
}

export interface InternalDocumentMap {
    roles: InternalRoleDocument;
    roleRules: InternalRoleRuleDocument;
    userRoleSets: InternalUserRoleSetDocument;
    roleMenuGrants: InternalRoleMenuGrantDocument;
    menuConfigs: InternalMenuConfigDocument;
    menuNodes: InternalMenuNodeDocument;
    apiBindings: InternalApiBindingDocument;
    scopeState: InternalScopeStateDocument;
    auditEntries: InternalAuditEntryDocument;
}

export function assertCanonicalBudget(
    value: unknown,
    limitName: string,
    max: number,
    origin: "caller-input" | "preview-budget" | "persisted-authorization-state" | "persisted-data-state" = "persisted-authorization-state",
) {
    try {
        return canonicalByteLength(value, max);
    } catch (error) {
        if (error instanceof CanonicalByteLimitError) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", `${limitName} exceeds ${max} canonical bytes.`, {
                details: {
                    kind: "limit-exceeded",
                    origin,
                    limitName,
                    current: error.current,
                    max,
                    unit: "bytes",
                },
            });
        }
        if (error instanceof CanonicalEncodingError) {
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", `${limitName} is not canonically persistable.`, {
                details: {
                    kind: "persisted-state-invalid",
                    stage: "post-image",
                    reason: error.message,
                },
                cause: error,
            });
        }
        throw error;
    }
}

export function assertInternalDocumentBudget(value: unknown) {
    const canonicalBytes = assertCanonicalBudget(value, "internal-document", MAX_INTERNAL_DOCUMENT_BYTES);
    try {
        bsonDocumentByteLengthUpperBound(
            value,
            MAX_INTERNAL_DOCUMENT_BYTES - INTERNAL_BSON_GENERATED_ID_BYTES,
        );
    } catch (error) {
        if (error instanceof BsonByteLimitError) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", `internal-document exceeds ${MAX_INTERNAL_DOCUMENT_BYTES} BSON bytes.`, {
                details: {
                    kind: "limit-exceeded",
                    origin: "persisted-authorization-state",
                    limitName: "internal-document-bson",
                    current: error.current + INTERNAL_BSON_GENERATED_ID_BYTES,
                    max: MAX_INTERNAL_DOCUMENT_BYTES,
                    unit: "bytes",
                },
            });
        }
        if (error instanceof BsonEncodingError) {
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", "internal-document is not BSON-persistable.", {
                details: {
                    kind: "persisted-state-invalid",
                    stage: "post-image",
                    reason: error.message,
                },
                cause: error,
            });
        }
        throw error;
    }
    return canonicalBytes;
}

export function assertAuditChangeBudget(value: unknown) {
    return assertCanonicalBudget(value, "audit-change", MAX_AUDIT_CHANGE_BYTES);
}

export function assertMenuConfigBudget(value: unknown) {
    return assertCanonicalBudget(value, "menu-config", MAX_MENU_CONFIG_BYTES);
}

export function assertRoleMenuGrantBudget(value: unknown) {
    return assertCanonicalBudget(value, "role-menu-grant", MAX_ROLE_MENU_GRANT_BYTES);
}
