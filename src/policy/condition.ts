import { types as utilTypes } from "node:util";
import type {
    PermissionScope,
    PermissionSubject,
    PolicyContext,
    PolicyScalar,
    PolicyConditionOutcome,
    RowCondition,
    RowOperator,
} from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import {
    CanonicalByteLimitError,
    canonicalByteLength,
    canonicalString,
    compareUtf8,
} from "../internal/canonical";
import { isWellFormedUnicode } from "../internal/unicode";

const MAX_CONDITION_BYTES = 64 * 1024;
const MAX_CONDITION_DEPTH = 12;
const MAX_CONDITION_LEAVES = 128;
const MAX_LOGICAL_CHILDREN = 32;
const MAX_SET_VALUES = 100;
const MAX_CONTAINS_CHARACTERS = 256;
const MAX_FIELD_PATH_BYTES = 512;
const MAX_FIELD_PATH_SEGMENTS = 32;
const SAFE_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const ROW_OPERATORS = new Set<RowOperator>([
    "eq",
    "ne",
    "in",
    "nin",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "exists",
]);

type ThreeStateOutcome = Exclude<PolicyConditionOutcome, "not-applicable">;

export interface PolicyEvaluationEnvironment {
    readonly subject: PermissionSubject;
    readonly context: PolicyContext;
    readonly fieldSource: Readonly<Record<string, unknown>>;
}

export interface PolicyContextFailure {
    readonly valueFrom: string;
    readonly reason: "missing" | "invalid";
}

export interface RowConditionEvaluation {
    readonly outcome: ThreeStateOutcome;
    readonly contextFailure?: PolicyContextFailure;
}

export interface ResolvedRowCondition {
    readonly condition?: RowCondition;
    readonly contextFailure?: PolicyContextFailure;
}

interface NormalizationState {
    leaves: number;
    ancestors: Set<object>;
}

interface PathResolution {
    found: boolean;
    supported: boolean;
    value?: unknown;
}

function invalid(field: string, reason: string): never {
    throw validationError("INVALID_POLICY", field, reason);
}

function limitExceeded(limitName: string, current: number, max: number, unit: "items" | "bytes" | "depth"): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", `${limitName} exceeds the policy limit.`, {
        details: {
            kind: "limit-exceeded",
            origin: "caller-input",
            limitName,
            current,
            max,
            unit,
        },
    });
}

function exactRecord(value: unknown, field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        invalid(field, "must be a plain condition object");
    }
    if (utilTypes.isProxy(value)) {
        invalid(field, "cannot be a Proxy");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        invalid(field, "must be a plain condition object");
    }
    const record: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
            invalid(field, "cannot contain symbol keys");
        }
        if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
            invalid(field, `contains forbidden key ${key}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            invalid(`${field}.${key}`, "must be an enumerable data property");
        }
        record[key] = descriptor.value;
    }
    return record;
}

function exactArray(value: unknown, field: string, minimum: number, maximum: number) {
    if (!Array.isArray(value)) {
        invalid(field, "must be an array");
    }
    if (utilTypes.isProxy(value)) {
        invalid(field, "cannot be a Proxy");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value as number
        : -1;
    if (length < minimum || length > maximum) {
        invalid(field, `must contain ${minimum}..${maximum} items`);
    }
    const copy = new Array<unknown>(length);
    let indexCount = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") {
            continue;
        }
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            invalid(field, "cannot contain non-index array properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            invalid(`${field}[${key}]`, "must be an enumerable data property");
        }
        copy[Number(key)] = descriptor.value;
        indexCount += 1;
    }
    if (indexCount !== length) {
        invalid(field, "cannot be sparse");
    }
    return copy;
}

function normalizePath(value: unknown, field: string) {
    if (
        typeof value !== "string"
        || !value
        || Buffer.byteLength(value, "utf8") > MAX_FIELD_PATH_BYTES
        || !isWellFormedUnicode(value)
    ) {
        invalid(field, `must be a non-empty safe path of at most ${MAX_FIELD_PATH_BYTES} UTF-8 bytes`);
    }
    const segments = value.split(".");
    if (
        segments.length > MAX_FIELD_PATH_SEGMENTS
        || segments.some((segment) => !SAFE_PATH_SEGMENT.test(segment) || FORBIDDEN_PATH_SEGMENTS.has(segment))
    ) {
        invalid(field, `must contain 1..${MAX_FIELD_PATH_SEGMENTS} safe field segments`);
    }
    return value;
}

function normalizeValueFrom(value: unknown, field: string) {
    if (value === "subject.userId") {
        return value;
    }
    if (
        value === "scope.tenantId"
        || value === "scope.appId"
        || value === "scope.moduleId"
        || value === "scope.namespace"
    ) {
        return value;
    }
    if (typeof value !== "string") {
        invalid(field, "must reference subject, scope, claims, or context");
    }
    const separator = value.indexOf(".");
    const root = separator < 0 ? value : value.slice(0, separator);
    const path = separator < 0 ? "" : value.slice(separator + 1);
    if ((root !== "claims" && root !== "context") || !path) {
        invalid(field, "must reference subject, scope, claims, or context");
    }
    normalizePath(path, field);
    return value;
}

function normalizeScalar(value: unknown, field: string): PolicyScalar {
    if (value === null || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            invalid(field, "must be a finite number");
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "string") {
        if (!isWellFormedUnicode(value)) {
            invalid(field, "cannot contain an unpaired UTF-16 surrogate");
        }
        return value;
    }
    invalid(field, "must be a policy scalar");
}

function normalizeSet(value: unknown, field: string) {
    const items = exactArray(value, field, 1, MAX_SET_VALUES).map((item, index) => (
        normalizeScalar(item, `${field}[${index}]`)
    ));
    const unique = new Map<string, PolicyScalar>();
    for (const item of items) {
        unique.set(canonicalString(item), item);
    }
    return Object.freeze(
        [...unique.entries()]
            .sort(([left], [right]) => compareUtf8(left, right))
            .map(([, item]) => item),
    ) as readonly [PolicyScalar, ...PolicyScalar[]];
}

function normalizeLiteralOperand(op: RowOperator, value: unknown, field: string) {
    if (op === "eq" || op === "ne") {
        return normalizeScalar(value, field);
    }
    if (op === "in" || op === "nin") {
        return normalizeSet(value, field);
    }
    if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        if (typeof value === "number") {
            if (!Number.isFinite(value)) {
                invalid(field, "must be a finite number or string");
            }
            return Object.is(value, -0) ? 0 : value;
        }
        if (typeof value === "string" && isWellFormedUnicode(value)) {
            return value;
        }
        invalid(field, "must be a finite number or well-formed string");
    }
    if (op === "contains") {
        if (
            typeof value !== "string"
            || !isWellFormedUnicode(value)
            || value.length === 0
            || [...value].length > MAX_CONTAINS_CHARACTERS
        ) {
            invalid(field, `must be a non-empty string of at most ${MAX_CONTAINS_CHARACTERS} characters`);
        }
        return value;
    }
    if (typeof value !== "boolean") {
        invalid(field, "must be a boolean");
    }
    return value;
}

function normalizeNode(
    value: unknown,
    field: string,
    depth: number,
    state: NormalizationState,
): RowCondition {
    if (depth > MAX_CONDITION_DEPTH) {
        limitExceeded("row-condition-depth", depth, MAX_CONDITION_DEPTH, "depth");
    }
    if (value !== null && typeof value === "object") {
        if (state.ancestors.has(value)) {
            invalid(field, "cannot contain a cycle");
        }
        state.ancestors.add(value);
    }
    try {
        const record = exactRecord(value, field);
        const keys = Object.keys(record);
        if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
            const operation = keys[0] as "all" | "any";
            const children = exactArray(record[operation], `${field}.${operation}`, 1, MAX_LOGICAL_CHILDREN)
                .map((child, index) => normalizeNode(child, `${field}.${operation}[${index}]`, depth + 1, state));
            return Object.freeze({ [operation]: Object.freeze(children) }) as RowCondition;
        }
        if (keys.length === 1 && keys[0] === "not") {
            return Object.freeze({ not: normalizeNode(record.not, `${field}.not`, depth + 1, state) });
        }

        const allowed = new Set(["field", "op", "value", "valueFrom"]);
        const unsupported = keys.find((key) => !allowed.has(key));
        if (unsupported) {
            invalid(`${field}.${unsupported}`, "is not supported");
        }
        if (!Object.hasOwn(record, "field") || !Object.hasOwn(record, "op")) {
            invalid(field, "leaf conditions require field and op");
        }
        if (typeof record.op !== "string" || !ROW_OPERATORS.has(record.op as RowOperator)) {
            invalid(`${field}.op`, "is not a supported row operator");
        }
        const hasValue = Object.hasOwn(record, "value");
        const hasValueFrom = Object.hasOwn(record, "valueFrom");
        if (hasValue === hasValueFrom) {
            invalid(field, "must provide exactly one of value or valueFrom");
        }

        state.leaves += 1;
        if (state.leaves > MAX_CONDITION_LEAVES) {
            limitExceeded("row-condition-leaves", state.leaves, MAX_CONDITION_LEAVES, "items");
        }
        const normalizedField = normalizePath(record.field, `${field}.field`);
        const op = record.op as RowOperator;
        if (hasValueFrom) {
            return Object.freeze({
                field: normalizedField,
                op,
                valueFrom: normalizeValueFrom(record.valueFrom, `${field}.valueFrom`),
            }) as RowCondition;
        }
        return Object.freeze({
            field: normalizedField,
            op,
            value: normalizeLiteralOperand(op, record.value, `${field}.value`),
        }) as RowCondition;
    } finally {
        if (value !== null && typeof value === "object") {
            state.ancestors.delete(value);
        }
    }
}

export function normalizeRowCondition(value: unknown): RowCondition {
    const normalized = normalizeNode(value, "where", 1, { leaves: 0, ancestors: new Set() });
    try {
        canonicalByteLength(normalized, MAX_CONDITION_BYTES);
    } catch (error) {
        if (error instanceof CanonicalByteLimitError) {
            limitExceeded("row-condition-bytes", error.current, MAX_CONDITION_BYTES, "bytes");
        }
        throw error;
    }
    return normalized;
}

function resolvePath(root: unknown, path: string): PathResolution {
    let current = root;
    for (const segment of path.split(".")) {
        if (current === null || typeof current !== "object" || Array.isArray(current) || utilTypes.isProxy(current)) {
            return { found: false, supported: false };
        }
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) {
            return { found: false, supported: false };
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, segment);
        if (!descriptor) {
            return { found: false, supported: true };
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
            return { found: false, supported: false };
        }
        current = descriptor.value;
    }
    return { found: true, supported: true, value: current };
}

function resolveDynamicValue(
    valueFrom: string,
    subject: PermissionSubject,
    context: PolicyContext,
): PathResolution {
    if (valueFrom === "subject.userId") {
        return { found: true, supported: true, value: subject.userId };
    }
    if (valueFrom.startsWith("scope.")) {
        return resolvePath(subject.scope, valueFrom.slice("scope.".length));
    }
    if (valueFrom.startsWith("claims.")) {
        return resolvePath(subject.claims ?? {}, valueFrom.slice("claims.".length));
    }
    return resolvePath(context, valueFrom.slice("context.".length));
}

function isSupportedScalar(value: unknown): value is PolicyScalar {
    return value === null
        || typeof value === "boolean"
        || typeof value === "string"
        || (typeof value === "number" && Number.isFinite(value));
}

function equalScalar(left: PolicyScalar, right: PolicyScalar) {
    return typeof left === typeof right && left === right;
}

function positiveScalarOutcome(op: RowOperator, left: unknown, right: unknown): ThreeStateOutcome {
    if (!isSupportedScalar(left)) {
        return "unknown";
    }
    if (op === "eq" || op === "ne") {
        return equalScalar(left, right as PolicyScalar) ? "true" : "false";
    }
    if (op === "in" || op === "nin") {
        return (right as readonly PolicyScalar[]).some((candidate) => equalScalar(left, candidate))
            ? "true"
            : "false";
    }
    if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        if (typeof left !== typeof right || (typeof left !== "number" && typeof left !== "string")) {
            return "unknown";
        }
        const comparison = typeof left === "number"
            ? left === (right as number) ? 0 : left < (right as number) ? -1 : 1
            : compareUtf8(left, right as string);
        if (op === "gt") {
            return comparison > 0 ? "true" : "false";
        }
        if (op === "gte") {
            return comparison >= 0 ? "true" : "false";
        }
        if (op === "lt") {
            return comparison < 0 ? "true" : "false";
        }
        return comparison <= 0 ? "true" : "false";
    }
    if (op === "contains") {
        return typeof left === "string"
            ? (left.includes(right as string) ? "true" : "false")
            : "unknown";
    }
    return "unknown";
}

function aggregateExistential(outcomes: readonly ThreeStateOutcome[]) {
    if (outcomes.includes("true")) {
        return "true" as const;
    }
    return outcomes.includes("unknown") ? "unknown" as const : "false" as const;
}

function positiveOutcome(op: RowOperator, left: unknown, right: unknown): ThreeStateOutcome {
    if (!Array.isArray(left)) {
        return positiveScalarOutcome(op, left, right);
    }
    if (utilTypes.isProxy(left)) {
        return "unknown";
    }
    const descriptors = exactRuntimeArray(left);
    if (!descriptors) {
        return "unknown";
    }
    return aggregateExistential(descriptors.map((item) => positiveScalarOutcome(op, item, right)));
}

function exactRuntimeArray(value: unknown[]) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value as number : -1;
    if (!Number.isSafeInteger(length) || length < 0) {
        return null;
    }
    const result = new Array<unknown>(length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") {
            continue;
        }
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            return null;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            return null;
        }
        result[Number(key)] = descriptor.value;
        count += 1;
    }
    return count === length ? result : null;
}

function normalizeDynamicOperand(op: RowOperator, value: unknown) {
    try {
        return { valid: true as const, value: normalizeLiteralOperand(op, value, "where.valueFrom") };
    } catch (error) {
        if (
            error instanceof PermissionCoreError
            && (error.code === "INVALID_POLICY" || error.code === "LIMIT_EXCEEDED")
        ) {
            return { valid: false as const };
        }
        throw error;
    }
}

function resolveConditionNode(
    condition: RowCondition,
    subject: PermissionSubject,
    context: PolicyContext,
): ResolvedRowCondition {
    if ("all" in condition || "any" in condition) {
        const operation = "all" in condition ? "all" : "any";
        const sourceChildren = "all" in condition ? condition.all : condition.any;
        const children: RowCondition[] = [];
        for (const child of sourceChildren) {
            const resolved = resolveConditionNode(child, subject, context);
            if (resolved.contextFailure) {
                return resolved;
            }
            children.push(resolved.condition!);
        }
        return Object.freeze({
            condition: Object.freeze({
                [operation]: Object.freeze(children),
            }) as RowCondition,
        });
    }
    if ("not" in condition) {
        const resolved = resolveConditionNode(condition.not, subject, context);
        return resolved.contextFailure
            ? resolved
            : Object.freeze({ condition: Object.freeze({ not: resolved.condition! }) });
    }
    if (!("valueFrom" in condition) || typeof condition.valueFrom !== "string") {
        return Object.freeze({ condition });
    }

    const valueFrom = condition.valueFrom;
    const resolved = resolveDynamicValue(valueFrom, subject, context);
    if (!resolved.found) {
        return Object.freeze({
            contextFailure: Object.freeze({
                valueFrom,
                reason: resolved.supported ? "missing" : "invalid",
            }),
        });
    }
    const operand = normalizeDynamicOperand(condition.op, resolved.value);
    if (!operand.valid) {
        return Object.freeze({
            contextFailure: Object.freeze({ valueFrom, reason: "invalid" }),
        });
    }
    return Object.freeze({
        condition: Object.freeze({
            field: condition.field,
            op: condition.op,
            value: operand.value,
        }) as RowCondition,
    });
}

export function resolveNormalizedRowCondition(
    condition: RowCondition,
    subject: PermissionSubject,
    context: PolicyContext,
): ResolvedRowCondition {
    return resolveConditionNode(condition, subject, context);
}

function invert(outcome: ThreeStateOutcome): ThreeStateOutcome {
    if (outcome === "true") {
        return "false";
    }
    if (outcome === "false") {
        return "true";
    }
    return "unknown";
}

function evaluateLeaf(condition: Extract<RowCondition, { field: string }>, environment: PolicyEvaluationEnvironment): RowConditionEvaluation {
    const left = resolvePath(environment.fieldSource, condition.field);
    let right: unknown;
    if ("valueFrom" in condition && typeof condition.valueFrom === "string") {
        const valueFrom = condition.valueFrom;
        const resolved = resolveDynamicValue(valueFrom, environment.subject, environment.context);
        if (!resolved.found) {
            return Object.freeze({
                outcome: "unknown",
                contextFailure: Object.freeze({
                    valueFrom,
                    reason: resolved.supported ? "missing" : "invalid",
                }),
            });
        }
        const normalized = normalizeDynamicOperand(condition.op, resolved.value);
        if (!normalized.valid) {
            return Object.freeze({
                outcome: "unknown",
                contextFailure: Object.freeze({ valueFrom, reason: "invalid" }),
            });
        }
        right = normalized.value;
    } else {
        right = condition.value;
    }

    if (condition.op === "exists") {
        return Object.freeze({ outcome: (left.found === right) ? "true" : "false" });
    }
    if (!left.found || !left.supported) {
        return Object.freeze({ outcome: "unknown" });
    }

    const positiveOp = condition.op === "ne"
        ? "eq"
        : condition.op === "nin" ? "in" : condition.op;
    const positive = positiveOutcome(positiveOp, left.value, right);
    return Object.freeze({
        outcome: condition.op === "ne" || condition.op === "nin" ? invert(positive) : positive,
    });
}

function evaluateNode(condition: RowCondition, environment: PolicyEvaluationEnvironment): RowConditionEvaluation {
    if ("all" in condition) {
        const children = condition.all.map((child) => evaluateNode(child, environment));
        const contextFailure = children.find((child) => child.contextFailure)?.contextFailure;
        const outcomes = children.map((child) => child.outcome);
        const outcome = outcomes.includes("false") ? "false" : outcomes.includes("unknown") ? "unknown" : "true";
        return Object.freeze({ outcome, ...(contextFailure ? { contextFailure } : {}) });
    }
    if ("any" in condition) {
        const children = condition.any.map((child) => evaluateNode(child, environment));
        const contextFailure = children.find((child) => child.contextFailure)?.contextFailure;
        const outcomes = children.map((child) => child.outcome);
        const outcome = outcomes.includes("true") ? "true" : outcomes.includes("unknown") ? "unknown" : "false";
        return Object.freeze({ outcome, ...(contextFailure ? { contextFailure } : {}) });
    }
    if ("not" in condition) {
        const child = evaluateNode(condition.not, environment);
        return Object.freeze({
            outcome: invert(child.outcome),
            ...(child.contextFailure ? { contextFailure: child.contextFailure } : {}),
        });
    }
    return evaluateLeaf(condition, environment);
}

export function evaluateNormalizedRowCondition(
    condition: RowCondition,
    environment: PolicyEvaluationEnvironment,
): RowConditionEvaluation {
    return evaluateNode(condition, environment);
}

export function evaluateRowCondition(
    condition: unknown,
    environment: PolicyEvaluationEnvironment,
): RowConditionEvaluation {
    return evaluateNormalizedRowCondition(normalizeRowCondition(condition), environment);
}

export function createPolicyEvaluationEnvironment(
    subject: PermissionSubject,
    context: PolicyContext,
    fieldSource: Readonly<Record<string, unknown>>,
): PolicyEvaluationEnvironment {
    return Object.freeze({ subject, context, fieldSource });
}

export function createContextFailureError(failure: PolicyContextFailure) {
    return new PermissionCoreError(
        "POLICY_CONTEXT_MISSING",
        `Policy operand ${failure.valueFrom} is ${failure.reason}.`,
        {
            details: {
                kind: "validation",
                field: failure.valueFrom,
                reason: failure.reason,
            },
        },
    );
}

export function createEvaluationSubject(
    userId: string,
    scope: Readonly<PermissionScope>,
    claims?: PermissionSubject["claims"],
): PermissionSubject {
    return Object.freeze({ userId, scope, ...(claims === undefined ? {} : { claims }) });
}
