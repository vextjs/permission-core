import { types as utilTypes } from "node:util";
import type { SafeMongoFilter } from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalByteLength, canonicalString } from "../internal/canonical";
import { collectDocumentPaths, normalizeDataPath } from "./path";
import { normalizeMongoValue } from "./value";

const MAX_FILTER_DEPTH = 12;
const MAX_FILTER_NODES = 256;
const MAX_DOCUMENT_KEYS = 64;
const MAX_LOGICAL_CHILDREN = 32;
const MAX_SET_ITEMS = 100;
const MAX_FILTER_BYTES = 128 * 1024;
const MAX_REGEX_CHARACTERS = 128;
const MAX_FILTER_CANONICAL_DEPTH = 32;
const LOGICAL_OPERATORS = new Set(["$and", "$or", "$nor"]);
const FIELD_OPERATORS = new Set([
    "$eq", "$ne", "$in", "$nin", "$gt", "$gte", "$lt", "$lte",
    "$exists", "$type", "$regex", "$options", "$not", "$elemMatch", "$all", "$size",
]);
const BSON_TYPES = new Set(["null", "bool", "number", "string", "date", "binData", "objectId", "array", "object"]);

interface FilterState {
    nodes: number;
    readonly paths: Set<string>;
}

export interface NormalizedSafeMongoFilter {
    readonly filter: Readonly<Record<string, unknown>>;
    readonly referencedPaths: readonly string[];
    readonly canonical: unknown;
}

function invalid(field: string, reason: string): never {
    throw validationError("INVALID_FILTER", field, reason);
}

function limit(name: string, current: number, max: number, unit: "items" | "bytes" | "depth"): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", `${name} exceeds the safe filter limit.`, {
        details: { kind: "limit-exceeded", origin: "caller-input", limitName: name, current, max, unit },
    });
}

function consumeNode(state: FilterState) {
    state.nodes += 1;
    if (state.nodes > MAX_FILTER_NODES) {
        limit("safe-filter-nodes", state.nodes, MAX_FILTER_NODES, "items");
    }
}

function exactRecord(value: unknown, field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
        invalid(field, "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        invalid(field, "must be a plain object");
    }
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor") {
            invalid(field, `contains forbidden key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            invalid(`${field}.${key}`, "must be an enumerable data property");
        }
        output[key] = descriptor.value;
    }
    return output;
}

function exactArray(value: unknown, field: string, maximum: number) {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        invalid(field, "must be an array");
    }
    if (value.length < 1 || value.length > maximum) {
        invalid(field, `must contain 1..${maximum} items`);
    }
    const result = new Array<unknown>(value.length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
            invalid(field, "cannot contain non-index array properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            invalid(`${field}[${key}]`, "must be a dense data item");
        }
        result[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== value.length) invalid(field, "cannot be sparse");
    return result;
}

function escapedLiteralRegex(value: unknown, field: string) {
    if (typeof value !== "string" || value.length === 0 || [...value].length > MAX_REGEX_CHARACTERS) {
        invalid(field, `must be a non-empty literal string of at most ${MAX_REGEX_CHARACTERS} characters`);
    }
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasOperatorKey(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.keys(value).some((key) => key.startsWith("$"));
}

function normalizeLiteral(value: unknown, field: string) {
    if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
        invalid(field, "cannot contain a Proxy value");
    }
    if (hasOperatorKey(value)) {
        invalid(field, "cannot contain an operator document where a literal is required");
    }
    return normalizeMongoValue(value, "caller-input", field).value;
}

function normalizeSet(value: unknown, field: string) {
    const output: unknown[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of exactArray(value, field, MAX_SET_ITEMS).entries()) {
        const normalized = normalizeMongoValue(entry, "caller-input", `${field}[${index}]`);
        if (hasOperatorKey(normalized.value)) {
            invalid(`${field}[${index}]`, "cannot contain an operator document where a literal is required");
        }
        const key = canonicalString(normalized.canonical);
        if (!seen.has(key)) {
            seen.add(key);
            output.push(normalized.value);
        }
    }
    if (output.length === 0) invalid(field, "must contain at least one canonical value");
    return output;
}

function addNestedReferencedPaths(value: unknown, path: string, state: FilterState) {
    for (const child of collectDocumentPaths(value)) {
        state.paths.add(`${path}.${child}`);
    }
}

function normalizeElemMatch(
    value: unknown,
    field: string,
    depth: number,
    state: FilterState,
    prefix: string,
) {
    const record = exactRecord(value, field);
    const keys = Object.keys(record);
    if (keys.length < 1 || keys.length > 32 || keys.some((key) => key.startsWith("$"))) {
        invalid(field, "must contain 1..32 field predicates and no logical operators");
    }
    consumeNode(state);
    const output: Record<string, unknown> = {};
    for (const key of keys) {
        const nested = normalizeDataPath(key, `${field}.${key}`, "INVALID_FILTER");
        const complete = `${prefix}.${nested}`;
        state.paths.add(complete);
        output[nested] = normalizeFieldPredicate(record[key], `${field}.${key}`, depth + 1, state, complete);
    }
    return output;
}

function normalizeOperatorDocument(
    value: unknown,
    field: string,
    depth: number,
    state: FilterState,
    path: string,
    nestedNot = false,
) {
    if (depth > MAX_FILTER_DEPTH) limit("safe-filter-depth", depth, MAX_FILTER_DEPTH, "depth");
    consumeNode(state);
    const record = exactRecord(value, field);
    const keys = Object.keys(record);
    if (keys.length === 0 || keys.some((key) => !FIELD_OPERATORS.has(key))) {
        invalid(field, "contains an empty or unsupported field operator document");
    }
    if (keys.some((key) => !key.startsWith("$"))) {
        invalid(field, "cannot mix literal and operator keys");
    }
    if (nestedNot && (keys.includes("$not") || keys.includes("$options"))) {
        invalid(field, "nested $not cannot contain $not or $options");
    }
    if (keys.includes("$options") && !keys.includes("$regex")) {
        invalid(`${field}.$options`, "requires $regex in the same operator document");
    }

    const output: Record<string, unknown> = {};
    for (const operator of keys) {
        const operand = record[operator];
        const operandField = `${field}.${operator}`;
        if (operator === "$in" || operator === "$nin" || operator === "$all") {
            const normalized = normalizeSet(operand, operandField);
            addNestedReferencedPaths(normalized, path, state);
            output[operator] = normalized;
        } else if (operator === "$exists") {
            if (typeof operand !== "boolean") invalid(operandField, "must be a boolean");
            output[operator] = operand;
        } else if (operator === "$type") {
            if (typeof operand !== "string" || !BSON_TYPES.has(operand)) {
                invalid(operandField, "must be one supported BSON type name");
            }
            output[operator] = operand;
        } else if (operator === "$regex") {
            output[operator] = escapedLiteralRegex(operand, operandField);
        } else if (operator === "$options") {
            if (operand !== "i") invalid(operandField, "must be exactly i");
            output[operator] = operand;
        } else if (operator === "$not") {
            output[operator] = normalizeOperatorDocument(operand, operandField, depth + 1, state, path, true);
        } else if (operator === "$elemMatch") {
            output[operator] = normalizeElemMatch(operand, operandField, depth + 1, state, path);
        } else if (operator === "$size") {
            if (!Number.isSafeInteger(operand) || (operand as number) < 0 || (operand as number) > 1000) {
                invalid(operandField, "must be a safe integer from 0 to 1000");
            }
            output[operator] = operand;
        } else {
            const normalized = normalizeLiteral(operand, operandField);
            addNestedReferencedPaths(normalized, path, state);
            output[operator] = normalized;
        }
    }
    return output;
}

function normalizeFieldPredicate(
    value: unknown,
    field: string,
    depth: number,
    state: FilterState,
    path: string,
) {
    if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
        invalid(field, "cannot contain a Proxy value");
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Uint8Array)) {
        const keys = Object.keys(value);
        const operatorKeys = keys.filter((key) => key.startsWith("$"));
        if (operatorKeys.length > 0) {
            if (operatorKeys.length !== keys.length) invalid(field, "cannot mix literal and operator keys");
            return normalizeOperatorDocument(value, field, depth, state, path);
        }
    }
    const normalized = normalizeLiteral(value, field);
    addNestedReferencedPaths(normalized, path, state);
    return normalized;
}

function normalizeFilterDocument(
    value: unknown,
    field: string,
    depth: number,
    state: FilterState,
    allowEmpty: boolean,
) {
    if (depth > MAX_FILTER_DEPTH) limit("safe-filter-depth", depth, MAX_FILTER_DEPTH, "depth");
    consumeNode(state);
    const record = exactRecord(value, field);
    const keys = Object.keys(record);
    if ((!allowEmpty && keys.length === 0) || keys.length > MAX_DOCUMENT_KEYS) {
        invalid(field, `must contain ${allowEmpty ? "0" : "1"}..${MAX_DOCUMENT_KEYS} keys`);
    }
    const output: Record<string, unknown> = {};
    for (const key of keys) {
        if (key.startsWith("$") && !LOGICAL_OPERATORS.has(key)) {
            invalid(`${field}.${key}`, "is not a supported root logical operator");
        }
        if (LOGICAL_OPERATORS.has(key)) {
            const children = exactArray(record[key], `${field}.${key}`, MAX_LOGICAL_CHILDREN);
            output[key] = children.map((child, index) => normalizeFilterDocument(
                child,
                `${field}.${key}[${index}]`,
                depth + 1,
                state,
                false,
            ));
            continue;
        }
        const path = normalizeDataPath(key, `${field}.${key}`, "INVALID_FILTER");
        state.paths.add(path);
        output[path] = normalizeFieldPredicate(record[key], `${field}.${key}`, depth + 1, state, path);
    }
    return output;
}

export function normalizeSafeMongoFilter(value: SafeMongoFilter | undefined): NormalizedSafeMongoFilter {
    const state: FilterState = { nodes: 0, paths: new Set() };
    const filter = normalizeFilterDocument(value ?? {}, "filter", 1, state, true);
    const canonical = normalizeMongoValue(filter, "caller-input", "filter", false, MAX_FILTER_CANONICAL_DEPTH).canonical;
    const bytes = canonicalByteLength(canonical);
    if (bytes > MAX_FILTER_BYTES) {
        limit("safe-filter-bytes", bytes, MAX_FILTER_BYTES, "bytes");
    }
    return Object.freeze({
        filter: Object.freeze(filter),
        referencedPaths: Object.freeze([...state.paths]),
        canonical,
    });
}
