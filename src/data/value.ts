import { types as utilTypes } from "node:util";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalByteLength } from "../internal/canonical";
import { isWellFormedUnicode } from "../internal/unicode";

const MAX_VALUE_DEPTH = 12;
const MAX_CONTAINER_ITEMS = 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface NormalizedMongoValue<T = unknown> {
    readonly value: T;
    readonly canonical: unknown;
}

type ValueOrigin = "caller-input" | "persisted-data-state";

interface NormalizationState {
    readonly origin: ValueOrigin;
    readonly ancestors: Set<object>;
    readonly maxDepth: number;
}

function unsupported(origin: ValueOrigin, path: string, valueType: string): never {
    if (origin === "caller-input") {
        throw validationError("INVALID_ARGUMENT", path, `contains unsupported ${valueType}`);
    }
    throw new PermissionCoreError("DATA_VALUE_UNSUPPORTED", "The persisted data contains an unsupported value.", {
        details: { kind: "data-value-unsupported", origin, path, valueType },
    });
}

function limit(origin: ValueOrigin, name: string, current: number, max: number, unit: "items" | "bytes" | "depth"): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", `${name} exceeds the data value limit.`, {
        details: { kind: "limit-exceeded", origin, limitName: name, current, max, unit },
    });
}

function ownDataKeys(value: object, path: string, origin: ValueOrigin) {
    if (utilTypes.isProxy(value)) {
        unsupported(origin, path, "Proxy");
    }
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
            unsupported(origin, path, "symbol key");
        }
        if (!isWellFormedUnicode(key) || FORBIDDEN_KEYS.has(key)) {
            unsupported(origin, `${path}.${key}`, "object key");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            unsupported(origin, `${path}.${key}`, "accessor or non-enumerable property");
        }
        keys.push(key);
    }
    return keys;
}

function denseArrayValues(value: unknown[], path: string, origin: ValueOrigin) {
    if (value.length > MAX_CONTAINER_ITEMS) {
        limit(origin, "mongo-value-container-items", value.length, MAX_CONTAINER_ITEMS, "items");
    }
    const values = new Array<unknown>(value.length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
            unsupported(origin, path, "array property");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            unsupported(origin, `${path}[${key}]`, "sparse or accessor array item");
        }
        values[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== value.length) {
        unsupported(origin, path, "sparse array");
    }
    return values;
}

function bsonType(value: object) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "_bsontype");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
        return descriptor.value;
    }
    const inherited = (value as { _bsontype?: unknown })._bsontype;
    return typeof inherited === "string" ? inherited : undefined;
}

function normalizeObjectId(value: object, path: string, origin: ValueOrigin): NormalizedMongoValue<string> | undefined {
    if (bsonType(value) !== "ObjectId") return undefined;
    const toHexString = (value as { toHexString?: unknown }).toHexString;
    if (typeof toHexString !== "function") {
        unsupported(origin, path, "ObjectId");
    }
    const hex = toHexString.call(value);
    if (typeof hex !== "string" || !/^[a-fA-F0-9]{24}$/u.test(hex)) {
        unsupported(origin, path, "ObjectId");
    }
    const normalized = hex.toLowerCase();
    return { value: normalized, canonical: { tag: "object-id", hex: normalized } };
}

function normalizeBinary(value: object, path: string, origin: ValueOrigin): NormalizedMongoValue<Uint8Array> | undefined {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const copy = new Uint8Array(value as Uint8Array);
        return { value: copy, canonical: { tag: "bytes", base64: Buffer.from(copy).toString("base64") } };
    }
    if (origin === "caller-input") return undefined;
    if (bsonType(value) !== "Binary") return undefined;
    const candidate = (value as { buffer?: unknown }).buffer;
    let bytes = candidate;
    if (!(bytes instanceof Uint8Array) && typeof (value as { value?: unknown }).value === "function") {
        bytes = (value as { value(): unknown }).value();
    }
    if (!(bytes instanceof Uint8Array)) {
        unsupported(origin, path, "Binary");
    }
    const copy = new Uint8Array(bytes as Uint8Array);
    return { value: copy, canonical: { tag: "bytes", base64: Buffer.from(copy).toString("base64") } };
}

function normalizeNode(value: unknown, path: string, depth: number, state: NormalizationState): NormalizedMongoValue {
    if (depth > state.maxDepth) {
        limit(state.origin, "mongo-value-depth", depth, state.maxDepth, "depth");
    }
    if (value === null) return { value: null, canonical: { tag: "null" } };
    if (typeof value === "boolean") return { value, canonical: { tag: "boolean", value } };
    if (typeof value === "number") {
        if (!Number.isFinite(value)) unsupported(state.origin, path, "number");
        const normalized = Object.is(value, -0) ? 0 : value;
        return { value: normalized, canonical: { tag: "number", value: normalized } };
    }
    if (typeof value === "string") {
        if (!isWellFormedUnicode(value)) unsupported(state.origin, path, "string");
        return { value, canonical: { tag: "string", value } };
    }
    if (typeof value !== "object") {
        unsupported(state.origin, path, typeof value);
    }
    if (utilTypes.isProxy(value)) {
        unsupported(state.origin, path, "Proxy");
    }
    if (state.ancestors.has(value as object)) {
        unsupported(state.origin, path, "cyclic value");
    }

    if (value instanceof Date) {
        const epochMs = value.getTime();
        if (!Number.isFinite(epochMs)) unsupported(state.origin, path, "Date");
        return { value: new Date(epochMs), canonical: { tag: "date", epochMs } };
    }
    const binary = normalizeBinary(value as object, path, state.origin);
    if (binary) return binary;
    const prototype = Object.getPrototypeOf(value);
    if (
        state.origin === "caller-input"
        && !Array.isArray(value)
        && prototype !== Object.prototype
        && prototype !== null
    ) {
        unsupported(state.origin, path, value.constructor?.name ?? "class instance");
    }
    if (state.origin === "persisted-data-state") {
        const objectId = normalizeObjectId(value as object, path, state.origin);
        if (objectId) return objectId;
        const explicitBsonType = bsonType(value as object);
        if (explicitBsonType) {
            unsupported(state.origin, path, explicitBsonType);
        }
    }

    state.ancestors.add(value as object);
    try {
        if (Array.isArray(value)) {
            const values = denseArrayValues(value, path, state.origin);
            const normalized = values.map((item, index) => normalizeNode(item, `${path}[${index}]`, depth + 1, state));
            return {
                value: normalized.map((entry) => entry.value),
                canonical: { tag: "array", items: normalized.map((entry) => entry.canonical) },
            };
        }
        if (prototype !== Object.prototype && prototype !== null) {
            unsupported(state.origin, path, value.constructor?.name ?? "class instance");
        }
        const keys = ownDataKeys(value, path, state.origin);
        if (keys.length > MAX_CONTAINER_ITEMS) {
            limit(state.origin, "mongo-value-container-items", keys.length, MAX_CONTAINER_ITEMS, "items");
        }
        const output: Record<string, unknown> = {};
        const canonical: Record<string, unknown> = {};
        for (const key of keys) {
            const child = normalizeNode((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, state);
            output[key] = child.value;
            canonical[key] = child.canonical;
        }
        return { value: output, canonical: { tag: "document", value: canonical } };
    } finally {
        state.ancestors.delete(value as object);
    }
}

export function normalizeMongoValue(
    value: unknown,
    origin: ValueOrigin,
    path: string,
    enforceRootByteLimit = true,
    maxDepth = MAX_VALUE_DEPTH,
): NormalizedMongoValue {
    const result = normalizeNode(value, path, 0, { origin, ancestors: new Set(), maxDepth });
    const bytes = canonicalByteLength(result.canonical);
    if (enforceRootByteLimit && bytes > MAX_VALUE_BYTES) {
        limit(origin, "mongo-value-bytes", bytes, MAX_VALUE_BYTES, "bytes");
    }
    return result;
}

export function normalizeCallerDocument(value: unknown, field: string) {
    const normalized = normalizeMongoValue(value, "caller-input", field, false);
    if (normalized.value === null || typeof normalized.value !== "object" || Array.isArray(normalized.value) || normalized.value instanceof Date || normalized.value instanceof Uint8Array) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain document");
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        normalizeMongoValue(child, "caller-input", `${field}.${key}`);
    }
    const bytes = canonicalByteLength(normalized.canonical);
    if (bytes > MAX_DOCUMENT_BYTES) {
        limit("caller-input", "mongo-document-bytes", bytes, MAX_DOCUMENT_BYTES, "bytes");
    }
    return normalized as NormalizedMongoValue<Record<string, unknown>>;
}

export function normalizePersistedDocument(value: unknown, field = "document") {
    const normalized = normalizeMongoValue(value, "persisted-data-state", field, false);
    if (normalized.value === null || typeof normalized.value !== "object" || Array.isArray(normalized.value) || normalized.value instanceof Date || normalized.value instanceof Uint8Array) {
        unsupported("persisted-data-state", field, "document");
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        normalizeMongoValue(child, "persisted-data-state", `${field}.${key}`);
    }
    const bytes = canonicalByteLength(normalized.canonical);
    if (bytes > MAX_DOCUMENT_BYTES) {
        limit("persisted-data-state", "mongo-document-bytes", bytes, MAX_DOCUMENT_BYTES, "bytes");
    }
    return normalized as NormalizedMongoValue<Record<string, unknown>>;
}
