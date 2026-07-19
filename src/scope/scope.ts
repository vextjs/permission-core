import type {
    PermissionScope,
    PermissionSubject,
    PolicyContext,
} from "../types";
import { digestCanonical } from "../internal/canonical";
import { isWellFormedUnicode } from "../internal/unicode";
import {
    assertOnlyKeys,
    assertPlainRecord,
    clonePolicyRecord,
} from "../internal/plain-data";
import { validationError } from "../core/errors";

const SCOPE_KEYS = ["tenantId", "appId", "moduleId", "namespace"] as const;
const SUBJECT_KEYS = ["userId", "scope", "claims"] as const;
const ID_MAX_BYTES = 128;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const FORBIDDEN_IDS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeId(value: unknown, field: string, errorCode: "INVALID_SUBJECT" | "INVALID_ARGUMENT") {
    if (typeof value !== "string") {
        throw validationError(errorCode, field, "must be a string");
    }
    const normalized = value.trim();
    if (!normalized) {
        throw validationError(errorCode, field, "cannot be empty");
    }
    if (Buffer.byteLength(normalized, "utf8") > ID_MAX_BYTES) {
        throw validationError(errorCode, field, `exceeds ${ID_MAX_BYTES} UTF-8 bytes`);
    }
    if (CONTROL_CHARACTERS.test(normalized)) {
        throw validationError(errorCode, field, "cannot contain control characters");
    }
    if (!isWellFormedUnicode(normalized)) {
        throw validationError(errorCode, field, "cannot contain an unpaired UTF-16 surrogate");
    }
    if (FORBIDDEN_IDS.has(normalized)) {
        throw validationError(errorCode, field, "uses a reserved identifier");
    }
    return normalized;
}

export function normalizeScope(scope: PermissionScope): Readonly<PermissionScope> {
    const record = assertPlainRecord(scope, "INVALID_SUBJECT", "scope");
    assertOnlyKeys(record, SCOPE_KEYS, "INVALID_SUBJECT", "scope");

    const normalized: PermissionScope = {
        tenantId: normalizeId(record.tenantId, "scope.tenantId", "INVALID_SUBJECT"),
    };
    for (const key of SCOPE_KEYS.slice(1)) {
        if (Object.hasOwn(record, key)) {
            normalized[key] = normalizeId(record[key], `scope.${key}`, "INVALID_SUBJECT");
        }
    }
    return Object.freeze(normalized);
}

export function createScopeKey(scope: PermissionScope) {
    return digestCanonical(normalizeScope(scope));
}

export function normalizeSubject(subject: PermissionSubject): Readonly<PermissionSubject> {
    const record = assertPlainRecord(subject, "INVALID_SUBJECT", "subject");
    assertOnlyKeys(record, SUBJECT_KEYS, "INVALID_SUBJECT", "subject");

    const normalized: PermissionSubject = {
        userId: normalizeId(record.userId, "subject.userId", "INVALID_SUBJECT"),
        scope: normalizeScope(record.scope as PermissionScope),
    };
    if (Object.hasOwn(record, "claims")) {
        normalized.claims = clonePolicyRecord(record.claims, "INVALID_SUBJECT", "subject.claims");
    }
    return Object.freeze(normalized);
}

export function normalizePolicyContext(context?: PolicyContext): PolicyContext {
    return clonePolicyRecord(context ?? {}, "INVALID_ARGUMENT", "context");
}

export function createClaimsFingerprint(subject: PermissionSubject) {
    return digestCanonical(normalizeSubject(subject).claims ?? {});
}

export function createContextFingerprint(context?: PolicyContext) {
    return digestCanonical(normalizePolicyContext(context));
}
