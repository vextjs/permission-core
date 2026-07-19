import type {
    PermissionSubject,
    PolicyContext,
    PolicyScalar,
    RowCondition,
    RowOperator,
} from "../types";
import { validationError } from "../core/errors";
import {
    createContextFailureError,
    resolveNormalizedRowCondition,
} from "../policy/condition";

export type MongoFilterDocument = Readonly<Record<string, unknown>>;

export interface MongoConditionPartition {
    readonly trueFilter: MongoFilterDocument;
    readonly falseFilter: MongoFilterDocument;
    readonly unknownFilter: MongoFilterDocument;
}

const SUPPORTED_SCALAR_TYPES = ["null", "bool", "number", "string"] as const;

function and(filters: readonly MongoFilterDocument[]): MongoFilterDocument {
    if (filters.length === 0) return {};
    if (filters.length === 1) return filters[0];
    return { $and: filters };
}

function or(filters: readonly MongoFilterDocument[]): MongoFilterDocument {
    if (filters.length === 0) return impossible();
    if (filters.length === 1) return filters[0];
    return { $or: filters };
}

function impossible(): MongoFilterDocument {
    return { $and: [{ _id: { $exists: true } }, { _id: { $exists: false } }] };
}

function complementUnion(left: MongoFilterDocument, right: MongoFilterDocument): MongoFilterDocument {
    return { $nor: [left, right] };
}

function scalarType(value: PolicyScalar) {
    if (value === null) return "null";
    if (typeof value === "boolean") return "bool";
    if (typeof value === "number") return "number";
    return "string";
}

function scalarGuard(field: string, types: readonly string[]): MongoFilterDocument {
    return or(types.map((type) => and([
        { [field]: { $type: type } },
        { [field]: { $not: { $type: "array" } } },
    ])));
}

function arrayGuard(field: string): MongoFilterDocument {
    return { [field]: { $type: "array" } };
}

function arrayHas(field: string, predicate: Readonly<Record<string, unknown>>): MongoFilterDocument {
    return { [field]: { $elemMatch: predicate } };
}

function arrayHasNoUnsupported(field: string, supportedTypes: readonly string[]): MongoFilterDocument {
    return {
        [field]: {
            $not: {
                $elemMatch: {
                    $not: { $type: supportedTypes },
                },
            },
        },
    };
}

function notPredicate(field: string, predicate: Readonly<Record<string, unknown>>): MongoFilterDocument {
    return { [field]: { $not: predicate } };
}

function escapedRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function positivePredicate(op: RowOperator, value: unknown): Readonly<Record<string, unknown>> {
    if (op === "eq") return { $eq: value };
    if (op === "in") return { $in: value };
    if (op === "gt" || op === "gte" || op === "lt" || op === "lte") return { [`$${op}`]: value };
    if (op === "contains") return { $regex: escapedRegex(value as string) };
    throw validationError("INVALID_POLICY", "where.op", `cannot compile ${op} as a positive predicate`);
}

function deterministicTypes(op: RowOperator, value: unknown): readonly string[] {
    if (op === "eq" || op === "in") return SUPPORTED_SCALAR_TYPES;
    if (op === "contains") return ["string"];
    const operand = Array.isArray(value) ? value[0] : value;
    return [scalarType(operand as PolicyScalar)];
}

function compilePositiveLeaf(field: string, op: RowOperator, value: unknown): MongoConditionPartition {
    const predicate = positivePredicate(op, value);
    const determinateTypes = deterministicTypes(op, value);
    const trueFilter = or([
        and([scalarGuard(field, determinateTypes), { [field]: predicate }]),
        and([arrayGuard(field), arrayHas(field, predicate)]),
    ]);
    const falseFilter = or([
        and([scalarGuard(field, determinateTypes), notPredicate(field, predicate)]),
        and([
            arrayGuard(field),
            notPredicate(field, { $elemMatch: predicate }),
            arrayHasNoUnsupported(field, determinateTypes),
        ]),
    ]);
    return Object.freeze({
        trueFilter,
        falseFilter,
        unknownFilter: complementUnion(trueFilter, falseFilter),
    });
}

function compileLeaf(condition: Extract<RowCondition, { field: string }>): MongoConditionPartition {
    if (!("value" in condition)) {
        throw validationError("INVALID_POLICY", "where.valueFrom", "must be resolved before Mongo compilation");
    }
    if (condition.op === "exists") {
        const exists = condition.value as boolean;
        const trueFilter = { [condition.field]: { $exists: exists } };
        const falseFilter = { [condition.field]: { $exists: !exists } };
        return Object.freeze({ trueFilter, falseFilter, unknownFilter: impossible() });
    }
    const positiveOp = condition.op === "ne" ? "eq" : condition.op === "nin" ? "in" : condition.op;
    const positive = compilePositiveLeaf(condition.field, positiveOp, condition.value);
    return condition.op === "ne" || condition.op === "nin"
        ? Object.freeze({
            trueFilter: positive.falseFilter,
            falseFilter: positive.trueFilter,
            unknownFilter: positive.unknownFilter,
        })
        : positive;
}

export function compileResolvedRowCondition(condition: RowCondition): MongoConditionPartition {
    if ("all" in condition || "any" in condition) {
        const operation = "all" in condition ? "all" : "any";
        const sourceChildren = "all" in condition ? condition.all : condition.any;
        const children = sourceChildren.map(compileResolvedRowCondition);
        const trueFilter = operation === "all"
            ? and(children.map((entry) => entry.trueFilter))
            : or(children.map((entry) => entry.trueFilter));
        const falseFilter = operation === "all"
            ? or(children.map((entry) => entry.falseFilter))
            : and(children.map((entry) => entry.falseFilter));
        return Object.freeze({
            trueFilter,
            falseFilter,
            unknownFilter: complementUnion(trueFilter, falseFilter),
        });
    }
    if ("not" in condition) {
        const child = compileResolvedRowCondition(condition.not);
        return Object.freeze({
            trueFilter: child.falseFilter,
            falseFilter: child.trueFilter,
            unknownFilter: child.unknownFilter,
        });
    }
    return compileLeaf(condition);
}

export function resolveAndCompileRowCondition(
    condition: RowCondition,
    subject: PermissionSubject,
    context: PolicyContext,
) {
    const resolved = resolveNormalizedRowCondition(condition, subject, context);
    if (resolved.contextFailure) {
        throw createContextFailureError(resolved.contextFailure);
    }
    return Object.freeze({
        condition: resolved.condition!,
        partition: compileResolvedRowCondition(resolved.condition!),
    });
}

export const mongoFilterCombinators = Object.freeze({ and, or, impossible });
