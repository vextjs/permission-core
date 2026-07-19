import { types as utilTypes } from "node:util";
import type { SafeMongoFilter, SafeMongoUpdate } from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalByteLength } from "../internal/canonical";
import { collectDocumentPaths, normalizeDataPath, pathsOverlap } from "./path";
import { normalizeSafeMongoFilter } from "./filter";
import { normalizeMongoValue } from "./value";

const UPDATE_OPERATORS = new Set([
    "$set", "$unset", "$inc", "$mul", "$min", "$max", "$addToSet", "$push", "$pull",
]);
const MAX_OPERATORS = 9;
const MAX_TOUCHED_PATHS = 128;
const MAX_UPDATE_BYTES = 64 * 1024;
const MAX_UPDATE_CANONICAL_DEPTH = 16;

export interface NormalizedSafeMongoUpdate {
    readonly update: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly touchedPaths: readonly string[];
    readonly authorizationPaths: readonly string[];
}

function invalid(field: string, reason: string): never {
    throw validationError("INVALID_ARGUMENT", field, reason);
}

function exactRecord(value: unknown, field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
        invalid(field, "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(field, "must be a plain object");
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) {
            invalid(field, `contains forbidden key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) invalid(`${field}.${key}`, "must be a data property");
        output[key] = descriptor.value;
    }
    return output;
}

function normalizeEach(value: unknown, field: string) {
    if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
        invalid(field, "cannot contain a Proxy value");
    }
    if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || value instanceof Date
        || value instanceof Uint8Array
    ) {
        return normalizeMongoValue(value, "caller-input", field).value;
    }
    const record = exactRecord(value, field);
    const keys = Object.keys(record);
    const modifierKeys = keys.filter((key) => key.startsWith("$"));
    if (modifierKeys.length === 0) {
        return normalizeMongoValue(value, "caller-input", field).value;
    }
    if (keys.length !== 1 || !Object.hasOwn(record, "$each")) {
        invalid(field, "may only use the single $each modifier object");
    }
    const each = normalizeMongoValue(record.$each, "caller-input", `${field}.$each`).value;
    if (!Array.isArray(each) || each.length < 1 || each.length > 100) {
        invalid(`${field}.$each`, "must contain 1..100 items");
    }
    return {
        $each: each,
    };
}

function collectAuthorizationChildren(operator: string, operand: unknown) {
    if (operator === "$set") return collectDocumentPaths(operand);
    if (operator !== "$addToSet" && operator !== "$push") return [];
    if (
        operand !== null
        && typeof operand === "object"
        && !Array.isArray(operand)
        && Object.hasOwn(operand, "$each")
    ) {
        return (operand as { $each: readonly unknown[] }).$each.flatMap((entry) => collectDocumentPaths(entry));
    }
    return collectDocumentPaths(operand);
}

function assertPullDepth(value: unknown, field: string, depth = 0) {
    if (depth > 4) invalid(field, "exceeds the $pull filter depth limit");
    if (value === null || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertPullDepth(entry, `${field}[${index}]`, depth + 1));
        return;
    }
    const record = exactRecord(value, field);
    for (const [key, child] of Object.entries(record)) {
        if (["$where", "$expr", "$function", "$regex", "$options"].includes(key)) {
            invalid(`${field}.${key}`, "is not supported by $pull");
        }
        assertPullDepth(child, `${field}.${key}`, depth + 1);
    }
}

function normalizePull(value: unknown, field: string) {
    const snapshot = normalizeMongoValue(value, "caller-input", field).value;
    assertPullDepth(snapshot, field);
    if (
        snapshot === null
        || typeof snapshot !== "object"
        || Array.isArray(snapshot)
        || snapshot instanceof Date
        || snapshot instanceof Uint8Array
    ) {
        return snapshot;
    }
    const record = exactRecord(snapshot, field);
    const keys = Object.keys(record);
    if (keys.length === 0) invalid(field, "cannot be an empty pull predicate");
    const dollarKeys = keys.filter((key) => key.startsWith("$"));
    try {
        if (dollarKeys.length === 0 || dollarKeys.every((key) => ["$and", "$or", "$nor"].includes(key))) {
            return normalizeSafeMongoFilter(record as SafeMongoFilter).filter;
        }
        if (dollarKeys.length !== keys.length) invalid(field, "cannot mix field and operator keys");
        const wrapped = normalizeSafeMongoFilter({ __pullValue: record } as SafeMongoFilter).filter;
        return wrapped.__pullValue;
    } catch (error) {
        if (error instanceof PermissionCoreError && error.code === "INVALID_FILTER") {
            invalid(field, "contains an unsupported $pull predicate");
        }
        throw error;
    }
}

function normalizeOperand(operator: string, value: unknown, field: string) {
    if (value !== null && typeof value === "object" && utilTypes.isProxy(value)) {
        invalid(field, "cannot contain a Proxy value");
    }
    if (operator === "$unset") {
        if (value !== true && value !== 1 && value !== "") invalid(field, "must be true, 1, or an empty string");
        return value;
    }
    if (operator === "$inc" || operator === "$mul") {
        if (typeof value !== "number" || !Number.isFinite(value)) invalid(field, "must be a finite number");
        return Object.is(value, -0) ? 0 : value;
    }
    if (operator === "$min" || operator === "$max") {
        if (
            !((typeof value === "number" && Number.isFinite(value)) || typeof value === "string" || (value instanceof Date && Number.isFinite(value.getTime())))
        ) {
            invalid(field, "must be a finite number, string, or valid Date");
        }
        return normalizeMongoValue(value, "caller-input", field).value;
    }
    if (operator === "$addToSet" || operator === "$push") return normalizeEach(value, field);
    if (operator === "$pull") {
        return normalizePull(value, field);
    }
    return normalizeMongoValue(value, "caller-input", field).value;
}

export function normalizeSafeMongoUpdate(
    value: SafeMongoUpdate,
    scopePaths: readonly string[],
): NormalizedSafeMongoUpdate {
    const record = exactRecord(value, "update");
    const operators = Object.keys(record);
    if (operators.length < 1 || operators.length > MAX_OPERATORS || operators.some((operator) => !UPDATE_OPERATORS.has(operator))) {
        invalid("update", `must contain 1..${MAX_OPERATORS} supported update operators`);
    }
    const output: Record<string, Readonly<Record<string, unknown>>> = {};
    const touched: string[] = [];
    const authorization = new Set<string>();
    for (const operator of operators) {
        const operands = exactRecord(record[operator], `update.${operator}`);
        const paths = Object.keys(operands);
        if (paths.length === 0) invalid(`update.${operator}`, "cannot be empty");
        const normalizedOperands: Record<string, unknown> = {};
        for (const rawPath of paths) {
            const path = normalizeDataPath(rawPath, `update.${operator}.${rawPath}`);
            if (scopePaths.some((scopePath) => pathsOverlap(scopePath, path))) {
                invalid(`update.${operator}.${path}`, "cannot modify a mapped scope path");
            }
            if (touched.some((existing) => pathsOverlap(existing, path))) {
                invalid(`update.${operator}.${path}`, "overlaps another touched path");
            }
            touched.push(path);
            authorization.add(path);
            const operand = normalizeOperand(operator, operands[rawPath], `update.${operator}.${path}`);
            normalizedOperands[path] = operand;
            for (const child of collectAuthorizationChildren(operator, operand)) authorization.add(`${path}.${child}`);
        }
        output[operator] = Object.freeze(normalizedOperands);
    }
    if (touched.length > MAX_TOUCHED_PATHS) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The update touches too many paths.", {
            details: { kind: "limit-exceeded", origin: "caller-input", limitName: "update-touched-paths", current: touched.length, max: MAX_TOUCHED_PATHS, unit: "items" },
        });
    }
    const canonical = normalizeMongoValue(output, "caller-input", "update", false, MAX_UPDATE_CANONICAL_DEPTH).canonical;
    const bytes = canonicalByteLength(canonical);
    if (bytes > MAX_UPDATE_BYTES) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The update exceeds its byte limit.", {
            details: { kind: "limit-exceeded", origin: "caller-input", limitName: "update-bytes", current: bytes, max: MAX_UPDATE_BYTES, unit: "bytes" },
        });
    }
    return Object.freeze({
        update: Object.freeze(output),
        touchedPaths: Object.freeze(touched),
        authorizationPaths: Object.freeze([...authorization]),
    });
}
