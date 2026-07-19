import type {
    PermissionCoreErrorCode,
    PermissionCoreErrorDetails,
} from "../types";

export interface PermissionCoreErrorOptions {
    details?: PermissionCoreErrorDetails;
    retryable?: boolean;
    committed?: boolean;
    operationId?: string;
    cause?: unknown;
}

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

const DEFAULT_RETRYABLE_CODES = new Set<PermissionCoreErrorCode>([
    "CORE_CLOSE_TIMEOUT",
    "DATABASE_UNAVAILABLE",
    "READ_CONFLICT",
    "REVISION_CONFLICT",
    "PREVIEW_STALE",
    "CURSOR_STALE",
]);

const PERMISSION_CORE_ERROR_BRAND = Symbol.for("permission-core.error.v2");

function readDetailsKind(details: PermissionCoreErrorDetails | undefined) {
    return details?.kind;
}

function validateErrorDetails(code: PermissionCoreErrorCode, details: PermissionCoreErrorDetails | undefined) {
    const requiredKinds = REQUIRED_DETAIL_KINDS[code];
    const kind = readDetailsKind(details);

    if (requiredKinds && (!kind || !requiredKinds.includes(kind))) {
        throw new TypeError(`${code} requires details.kind to be one of: ${requiredKinds.join(", ")}.`);
    }

    if (!details) {
        return;
    }

    if (code === "INVALID_ARGUMENT" && (kind === "validation" || kind === "capacity-risk-ack-required")) {
        return;
    }

    if (!requiredKinds && kind !== "validation") {
        throw new TypeError(`${code} does not accept details.kind ${kind}.`);
    }
}

export class PermissionCoreError extends Error {
    readonly name = "PermissionCoreError" as const;
    readonly code: PermissionCoreErrorCode;
    readonly details?: PermissionCoreErrorDetails;
    readonly retryable: boolean;
    readonly committed?: boolean;
    readonly operationId?: string;

    constructor(code: PermissionCoreErrorCode, message: string, options: PermissionCoreErrorOptions = {}) {
        validateErrorDetails(code, options.details);
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.code = code;
        this.details = options.details
            ? Object.freeze({ ...options.details }) as PermissionCoreErrorDetails
            : undefined;
        this.retryable = options.retryable ?? DEFAULT_RETRYABLE_CODES.has(code);
        this.committed = options.committed;
        this.operationId = options.operationId;
        Object.defineProperty(this, PERMISSION_CORE_ERROR_BRAND, {
            value: true,
            enumerable: false,
            writable: false,
            configurable: false,
        });
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export function isPermissionCoreError(value: unknown): value is PermissionCoreError {
    if (!(value instanceof Error)) return false;
    const brand = Object.getOwnPropertyDescriptor(value, PERMISSION_CORE_ERROR_BRAND);
    return brand?.value === true
        && brand.enumerable === false
        && typeof (value as { code?: unknown }).code === "string";
}

export function validationError(
    code: Extract<PermissionCoreErrorCode, "INVALID_CONFIGURATION" | "INVALID_SUBJECT" | "INVALID_ARGUMENT" | "INVALID_ACTION" | "INVALID_RESOURCE" | "INVALID_FILTER" | "INVALID_POLICY">,
    field: string,
    reason: string,
) {
    return new PermissionCoreError(code, `Invalid ${field}: ${reason}.`, {
        details: { kind: "validation", field, reason },
    });
}
