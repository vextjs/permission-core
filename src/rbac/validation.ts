import { PermissionCoreError, validationError } from "../core/errors";
import { isWellFormedUnicode } from "../internal/unicode";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const FORBIDDEN_IDS = new Set(["__proto__", "prototype", "constructor"]);

function characterCount(value: string) {
    return [...value].length;
}

export function normalizeRbacId(value: unknown, field: string) {
    if (typeof value !== "string" || !isWellFormedUnicode(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a well-formed string");
    }
    const normalized = value.trim();
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (bytes < 1) {
        throw validationError("INVALID_ARGUMENT", field, "cannot be empty");
    }
    if (bytes > 128) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds the identifier limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: `${field}-bytes`,
                current: bytes,
                max: 128,
                unit: "bytes",
            },
        });
    }
    if (CONTROL_CHARACTER.test(normalized) || FORBIDDEN_IDS.has(normalized)) {
        throw validationError("INVALID_ARGUMENT", field, "contains a forbidden identifier value");
    }
    return normalized;
}

export function normalizeRoleLabel(value: unknown, field = "label") {
    if (typeof value !== "string" || !isWellFormedUnicode(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a well-formed string");
    }
    const normalized = value.trim();
    const count = characterCount(normalized);
    if (count < 1) {
        throw validationError("INVALID_ARGUMENT", field, "cannot be empty");
    }
    if (count > 256) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds the label limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: `${field}-characters`,
                current: count,
                max: 256,
                unit: "items",
            },
        });
    }
    return normalized;
}

export function normalizeDescription(value: unknown, field = "description") {
    if (typeof value !== "string" || !isWellFormedUnicode(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a well-formed string");
    }
    const count = characterCount(value);
    if (count > 4096) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds the description limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: `${field}-characters`,
                current: count,
                max: 4096,
                unit: "items",
            },
        });
    }
    return value;
}

export function assertNonNegativeSafeInteger(value: unknown, field: string) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw validationError("INVALID_ARGUMENT", field, "must be a non-negative safe integer");
    }
    return value as number;
}

export function assertPositiveSafeInteger(value: unknown, field: string) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw validationError("INVALID_ARGUMENT", field, "must be a positive safe integer");
    }
    return value as number;
}
