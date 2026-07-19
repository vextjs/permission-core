import { types as utilTypes } from "node:util";
import type { PermissionCoreErrorCode, PolicyValue } from "../types";
import { canonicalBytes } from "./canonical";
import { isWellFormedUnicode } from "./unicode";
import { validationError } from "../core/errors";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const POLICY_MAX_BYTES = 64 * 1024;
const POLICY_MAX_DEPTH = 12;
const POLICY_MAX_CONTAINER_ITEMS = 1024;

type PolicyValidationCode = Extract<PermissionCoreErrorCode, "INVALID_SUBJECT" | "INVALID_ARGUMENT">;

interface CanonicalByteBudget {
    used: number;
}

function fail(code: PolicyValidationCode, field: string, reason: string): never {
    throw validationError(code, field, reason);
}

function consumeBytes(
    budget: CanonicalByteBudget,
    bytes: number,
    code: PolicyValidationCode,
    field: string,
) {
    budget.used += bytes;
    if (budget.used > POLICY_MAX_BYTES) {
        fail(code, field, `canonical form exceeds ${POLICY_MAX_BYTES} bytes`);
    }
}

function assertDenseDataArray(value: unknown[], code: PolicyValidationCode, field: string) {
    if (utilTypes.isProxy(value)) {
        fail(code, field, "cannot be a Proxy");
    }
    const keys = Reflect.ownKeys(value);
    let indexCount = 0;
    for (const key of keys) {
        if (key === "length") {
            continue;
        }
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
            fail(code, field, "cannot contain non-index array properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            fail(code, `${field}[${key}]`, "must be an enumerable data property");
        }
        indexCount += 1;
    }
    if (indexCount !== value.length) {
        fail(code, field, "cannot be a sparse array");
    }
}

export function assertPlainRecord(
    value: unknown,
    code: PolicyValidationCode,
    field: string,
): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(code, field, "must be a plain object");
    }
    if (utilTypes.isProxy(value)) {
        fail(code, field, "cannot be a Proxy");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail(code, field, "must be a plain object");
    }

    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
            fail(code, field, "cannot contain symbol keys");
        }
        if (!isWellFormedUnicode(key)) {
            fail(code, field, "cannot contain an unpaired UTF-16 surrogate in an object key");
        }
        if (FORBIDDEN_KEYS.has(key)) {
            fail(code, field, `contains forbidden key ${key}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            fail(code, `${field}.${key}`, "must be an enumerable data property");
        }
    }
    return value as Record<string, unknown>;
}

export function assertOnlyKeys(
    value: Record<string, unknown>,
    allowedKeys: readonly string[],
    code: PolicyValidationCode,
    field: string,
) {
    const allowed = new Set(allowedKeys);
    const unexpected = Object.keys(value).find((key) => !allowed.has(key));
    if (unexpected) {
        fail(code, `${field}.${unexpected}`, "is not supported");
    }
}

function cloneValue(
    value: unknown,
    code: PolicyValidationCode,
    field: string,
    depth: number,
    ancestors: Set<object>,
    budget: CanonicalByteBudget,
): PolicyValue {
    if (depth > POLICY_MAX_DEPTH) {
        fail(code, field, `exceeds maximum depth ${POLICY_MAX_DEPTH}`);
    }
    if (value === null) {
        consumeBytes(budget, 4, code, field);
        return value;
    }
    if (typeof value === "boolean") {
        consumeBytes(budget, value ? 4 : 5, code, field);
        return value;
    }
    if (typeof value === "string") {
        if (!isWellFormedUnicode(value)) {
            fail(code, field, "cannot contain an unpaired UTF-16 surrogate");
        }
        consumeBytes(budget, Buffer.byteLength(JSON.stringify(value), "utf8"), code, field);
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            fail(code, field, "must be a finite number");
        }
        const normalized = Object.is(value, -0) ? 0 : value;
        consumeBytes(budget, Buffer.byteLength(JSON.stringify(normalized), "utf8"), code, field);
        return normalized;
    }
    if (typeof value !== "object") {
        fail(code, field, `contains unsupported ${typeof value}`);
    }
    if (ancestors.has(value)) {
        fail(code, field, "contains a cycle");
    }

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            if (value.length > POLICY_MAX_CONTAINER_ITEMS) {
                fail(code, field, `contains more than ${POLICY_MAX_CONTAINER_ITEMS} items`);
            }
            assertDenseDataArray(value, code, field);
            consumeBytes(budget, 2 + Math.max(0, value.length - 1), code, field);
            const copy = value.map((item, index) => cloneValue(item, code, `${field}[${index}]`, depth + 1, ancestors, budget));
            return Object.freeze(copy);
        }

        const record = assertPlainRecord(value, code, field);
        const keys = Object.keys(record);
        if (keys.length > POLICY_MAX_CONTAINER_ITEMS) {
            fail(code, field, `contains more than ${POLICY_MAX_CONTAINER_ITEMS} keys`);
        }
        consumeBytes(budget, 2 + Math.max(0, keys.length - 1), code, field);
        const copy: Record<string, PolicyValue> = {};
        for (const key of keys) {
            consumeBytes(budget, Buffer.byteLength(JSON.stringify(key), "utf8") + 1, code, `${field}.${key}`);
            copy[key] = cloneValue(record[key], code, `${field}.${key}`, depth + 1, ancestors, budget);
        }
        return Object.freeze(copy);
    } finally {
        ancestors.delete(value);
    }
}

export function clonePolicyRecord(
    value: unknown,
    code: PolicyValidationCode,
    field: string,
): Readonly<Record<string, PolicyValue>> {
    const record = assertPlainRecord(value, code, field);
    const cloned = cloneValue(record, code, field, 0, new Set(), { used: 0 }) as Readonly<Record<string, PolicyValue>>;
    const byteLength = canonicalBytes(cloned).byteLength;
    if (byteLength > POLICY_MAX_BYTES) {
        fail(code, field, `canonical form exceeds ${POLICY_MAX_BYTES} bytes`);
    }
    return cloned;
}

export function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }
        Object.freeze(value);
    }
    return value;
}
