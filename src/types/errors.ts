import type { PolicyValue } from "./foundation";

export type PermissionCoreErrorCode =
    | "NOT_INITIALIZED" | "CORE_CLOSED" | "CORE_CLOSE_TIMEOUT" | "INVALID_CONFIGURATION"
    | "MONSQLIZE_CONTRACT_UNSUPPORTED" | "SCHEMA_VERSION_MISMATCH" | "SCHEMA_CONTRACT_MISMATCH" | "PERSISTED_STATE_INVALID" | "DATABASE_UNAVAILABLE"
    | "INVALID_SUBJECT" | "SCOPE_CONFLICT" | "PERMISSION_DENIED"
    | "INVALID_ARGUMENT" | "INVALID_ACTION" | "INVALID_RESOURCE" | "INVALID_FILTER"
    | "INVALID_POLICY" | "POLICY_CONTEXT_MISSING" | "INVALID_CURSOR" | "CURSOR_STALE" | "LIMIT_EXCEEDED"
    | "REVISION_CONFLICT" | "READ_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "PREVIEW_REQUIRED" | "PREVIEW_STALE" | "MENU_MANAGEMENT_PREVIEW_CONFLICT"
    | "ROLE_NOT_FOUND" | "ROLE_ALREADY_EXISTS" | "ROLE_IN_USE" | "CIRCULAR_INHERITANCE"
    | "MENU_NOT_FOUND" | "MENU_ALREADY_EXISTS" | "MENU_HIERARCHY_INVALID" | "DEPENDENCY_EXISTS"
    | "API_BINDING_NOT_FOUND" | "API_BINDING_ALREADY_EXISTS" | "AUDIT_ENTRY_NOT_FOUND" | "STALE_REFERENCE"
    | "DATA_OPERATION_UNSUPPORTED" | "DATA_VALUE_UNSUPPORTED" | "FIELD_PERMISSION_DENIED" | "SCOPE_FIELD_MAPPING_REQUIRED" | "DATA_BULK_SCOPE_MUTATION_UNSAFE"
    | "VEXT_MONSQLIZE_REQUIRED" | "VEXT_MONSQLIZE_INCOMPATIBLE" | "VEXT_AUTH_REQUIRED"
    | "VEXT_APP_EXTENSION_CONFLICT" | "VEXT_AUTH_EXTENSION_CONFLICT" | "VEXT_ROUTE_PERMISSION_INVALID" | "VEXT_ROUTE_RESTART_REQUIRED"
    | "DATABASE_ERROR" | "TRANSACTION_FAILED" | "INDEX_CONFLICT";

export interface LimitExceededDetails {
    kind: "limit-exceeded";
    origin: "caller-input" | "preview-budget" | "persisted-authorization-state" | "persisted-data-state";
    limitName: string;
    current: number;
    max: number;
    unit: "items" | "bytes" | "depth";
}

export interface DataValueUnsupportedDetails {
    kind: "data-value-unsupported";
    origin: "caller-input" | "persisted-data-state";
    path?: string;
    valueType: string;
}

export interface CoreCloseTimeoutDetails {
    kind: "close-timeout";
    timeoutMs: number;
    activeOperationLeases: number;
    activeBorrowedTransactions: number;
}

export interface ValidationErrorDetails {
    kind: "validation";
    field?: string;
    reason: string;
    stage?: "query" | "pre-image" | "post-image";
}

export interface RevisionConflictDetails {
    kind: "revision-conflict" | "read-conflict" | "preview-stale" | "cursor-stale";
    owner: string;
    expected?: number | string;
    current?: number | string;
}

export interface PreviewRequiredDetails {
    kind: "preview-required";
    reason: "capacity-risk" | "high-impact-deny-removal";
    previewMethod: "roles.previewRuleChange";
    affectedTotal: number;
    affectedDigest: string;
}

export interface CapacityRiskAckRequiredDetails {
    kind: "capacity-risk-ack-required";
    assessmentDigest: string;
}

export interface PersistedStateInvalidDetails {
    kind: "persisted-state-invalid" | "unexpected-post-image-field";
    stage?: "load" | "pre-image" | "post-image" | "post-image-invariant" | "aggregate-counter";
    reason: string;
    pathCount?: number;
    pathDigest?: string;
}

export interface SchemaMismatchDetails {
    kind: "schema-version-mismatch" | "schema-contract-mismatch";
    expected: string | number;
    current: string | number;
    scopeHash: string;
}

export interface DatabaseFailureDetails {
    kind: "database-failure";
    stage: "health" | "read" | "write" | "transaction-start" | "transaction-callback" | "transaction-commit" | "transaction-abort" | "index";
}

export interface AuditLookupDetails {
    kind: "audit-lookup";
    by: "auditId" | "operationId";
}

export interface MenuManagementPreviewConflictDetails {
    kind: "menu-management-preview-conflict";
    configId: string;
    changeDigest: string;
    conflicts: {
        total: number;
        items: readonly {
            id: string;
            code: string;
            message: string;
            currentRevision?: number;
        }[];
        truncated: boolean;
        digest: string;
    };
    warnings: {
        total: number;
        items: readonly {
            code: string;
            message: string;
            details?: Readonly<Record<string, PolicyValue>>;
        }[];
        truncated: boolean;
        digest: string;
    };
    operations: {
        total: number;
        items: readonly {
            operation: string;
            targetId: string;
            outcome: "created" | "updated" | "removed" | "unchanged";
        }[];
        truncated: boolean;
        digest: string;
    };
}

export interface ReconcileSupersededDetails {
    kind: "reconcile-superseded";
    operationId: string;
    supersededByOperationId: string;
}

export type PermissionCoreErrorDetails =
    | LimitExceededDetails
    | DataValueUnsupportedDetails
    | CoreCloseTimeoutDetails
    | ValidationErrorDetails
    | RevisionConflictDetails
    | PreviewRequiredDetails
    | CapacityRiskAckRequiredDetails
    | PersistedStateInvalidDetails
    | SchemaMismatchDetails
    | DatabaseFailureDetails
    | AuditLookupDetails
    | MenuManagementPreviewConflictDetails
    | ReconcileSupersededDetails;
