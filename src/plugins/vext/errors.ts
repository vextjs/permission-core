import type {
    PermissionCoreErrorCode,
} from "../../types";
import {
    isPermissionCoreError,
    type PermissionCoreError,
} from "../../core/errors";
import type {
    VextHookHandler,
    VextPluginContext,
} from "vextjs";

const permissionHttpErrors = new WeakMap<object, PermissionCoreError>();

type HttpStatusInput = Pick<PermissionCoreError, "code" | "details" | "retryable">;

const REQUIRED_DETAIL_KINDS: Partial<Record<PermissionCoreErrorCode, readonly string[]>> = {
    CORE_CLOSE_TIMEOUT: ["close-timeout"],
    LIMIT_EXCEEDED: ["limit-exceeded"],
    DATA_VALUE_UNSUPPORTED: ["data-value-unsupported"],
    PREVIEW_REQUIRED: ["preview-required"],
    SCHEMA_VERSION_MISMATCH: ["schema-version-mismatch"],
    SCHEMA_CONTRACT_MISMATCH: ["schema-contract-mismatch"],
    PERSISTED_STATE_INVALID: ["persisted-state-invalid", "unexpected-post-image-field"],
    REVISION_CONFLICT: ["revision-conflict", "reconcile-superseded"],
    READ_CONFLICT: ["read-conflict"],
    PREVIEW_STALE: ["preview-stale"],
    CURSOR_STALE: ["cursor-stale"],
    DATABASE_UNAVAILABLE: ["database-failure"],
    DATABASE_ERROR: ["database-failure"],
    TRANSACTION_FAILED: ["database-failure"],
    INDEX_CONFLICT: ["database-failure"],
    AUDIT_ENTRY_NOT_FOUND: ["audit-lookup"],
};

function hasValidStatusDiscriminator(error: HttpStatusInput) {
    const required = REQUIRED_DETAIL_KINDS[error.code];
    if (required && (!error.details?.kind || !required.includes(error.details.kind))) {
        return false;
    }
    if (error.code === "LIMIT_EXCEEDED") {
        return error.details?.kind === "limit-exceeded"
            && ["caller-input", "preview-budget", "persisted-authorization-state", "persisted-data-state"]
                .includes(error.details.origin);
    }
    if (error.code === "DATA_VALUE_UNSUPPORTED") {
        return error.details?.kind === "data-value-unsupported"
            && ["caller-input", "persisted-data-state"].includes(error.details.origin);
    }
    return true;
}

export function vextPermissionHttpStatus(input: PermissionCoreErrorCode | HttpStatusInput) {
    const error: HttpStatusInput = typeof input === "string"
        ? { code: input, details: undefined, retryable: false }
        : input;
    if (!hasValidStatusDiscriminator(error)) return 500;

    switch (error.code) {
        case "INVALID_ARGUMENT":
        case "INVALID_ACTION":
        case "INVALID_RESOURCE":
        case "INVALID_FILTER":
        case "INVALID_POLICY":
        case "POLICY_CONTEXT_MISSING":
        case "INVALID_CURSOR":
        case "MENU_HIERARCHY_INVALID":
        case "DATA_OPERATION_UNSUPPORTED":
        case "DATA_BULK_SCOPE_MUTATION_UNSAFE":
            return 400;
        case "LIMIT_EXCEEDED":
            return error.details?.kind === "limit-exceeded"
                && (error.details.origin === "caller-input" || error.details.origin === "preview-budget")
                ? 400
                : 503;
        case "DATA_VALUE_UNSUPPORTED":
            return error.details?.kind === "data-value-unsupported" && error.details.origin === "caller-input"
                ? 400
                : 503;
        case "VEXT_AUTH_REQUIRED":
        case "INVALID_SUBJECT":
        case "SCOPE_CONFLICT":
            return 401;
        case "PERMISSION_DENIED":
        case "FIELD_PERMISSION_DENIED":
            return 403;
        case "ROLE_NOT_FOUND":
        case "MENU_NOT_FOUND":
        case "API_BINDING_NOT_FOUND":
        case "AUDIT_ENTRY_NOT_FOUND":
            return 404;
        case "REVISION_CONFLICT":
        case "CURSOR_STALE":
        case "IDEMPOTENCY_CONFLICT":
        case "PREVIEW_REQUIRED":
        case "PREVIEW_STALE":
        case "ROLE_ALREADY_EXISTS":
        case "ROLE_IN_USE":
        case "CIRCULAR_INHERITANCE":
        case "MENU_ALREADY_EXISTS":
        case "DEPENDENCY_EXISTS":
        case "API_BINDING_ALREADY_EXISTS":
        case "STALE_REFERENCE":
            return 409;
        case "NOT_INITIALIZED":
        case "CORE_CLOSED":
        case "CORE_CLOSE_TIMEOUT":
        case "SCHEMA_VERSION_MISMATCH":
        case "SCHEMA_CONTRACT_MISMATCH":
        case "PERSISTED_STATE_INVALID":
        case "DATABASE_UNAVAILABLE":
        case "READ_CONFLICT":
        case "VEXT_ROUTE_RESTART_REQUIRED":
            return 503;
        case "DATABASE_ERROR":
        case "TRANSACTION_FAILED":
            return error.retryable ? 503 : 500;
        case "INVALID_CONFIGURATION":
        case "MONSQLIZE_CONTRACT_UNSUPPORTED":
        case "SCOPE_FIELD_MAPPING_REQUIRED":
        case "VEXT_MONSQLIZE_REQUIRED":
        case "VEXT_MONSQLIZE_INCOMPATIBLE":
        case "VEXT_APP_EXTENSION_CONFLICT":
        case "VEXT_AUTH_EXTENSION_CONFLICT":
        case "VEXT_ROUTE_PERMISSION_INVALID":
        case "INDEX_CONFLICT":
            return 500;
        default: {
            const unsupported: never = error.code;
            void unsupported;
            return 500;
        }
    }
}

function publicMessage(error: PermissionCoreError, status: number) {
    return status === 500 ? "Internal Server Error" : error.message;
}

function responseBody(error: PermissionCoreError, status: number, requestId: string) {
    return {
        code: error.code,
        message: publicMessage(error, status),
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.committed === undefined ? {} : { committed: error.committed }),
        ...(error.operationId === undefined ? {} : { operationId: error.operationId }),
        requestId,
    };
}

export function throwVextPermissionError(
    app: Pick<VextPluginContext, "throw">,
    error: unknown,
): never {
    if (!isPermissionCoreError(error)) {
        throw error;
    }
    const status = vextPermissionHttpStatus(error);
    try {
        app.throw({
            status,
            message: publicMessage(error, status),
            code: error.code,
            details: {
                retryable: error.retryable,
                ...(error.details === undefined ? {} : { details: error.details }),
                ...(error.committed === undefined ? {} : { committed: error.committed }),
                ...(error.operationId === undefined ? {} : { operationId: error.operationId }),
            },
        });
    } catch (vextError) {
        if (vextError !== null && (typeof vextError === "object" || typeof vextError === "function")) {
            permissionHttpErrors.set(vextError, error);
        }
        throw vextError;
    }
    throw new TypeError("Vext app.throw() returned instead of throwing");
}

export const mapVextPermissionError: VextHookHandler<"error:beforeResponse"> = ({
    error,
    requestId,
}) => {
    const permissionError = isPermissionCoreError(error)
        ? error
        : error !== null && (typeof error === "object" || typeof error === "function")
            ? permissionHttpErrors.get(error)
            : undefined;
    if (!permissionError) return;
    const status = vextPermissionHttpStatus(permissionError);
    return {
        status,
        body: responseBody(permissionError, status, requestId),
    };
};
