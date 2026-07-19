import type { PolicyScalar } from "./foundation";

export type RowOperator =
    | "eq"
    | "ne"
    | "in"
    | "nin"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "exists";

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type LiteralRowCondition =
    | { field: string; op: "eq" | "ne"; value: PolicyScalar; valueFrom?: never }
    | { field: string; op: "in" | "nin"; value: NonEmptyReadonlyArray<PolicyScalar>; valueFrom?: never }
    | { field: string; op: "gt" | "gte" | "lt" | "lte"; value: number | string; valueFrom?: never }
    | { field: string; op: "contains"; value: string; valueFrom?: never }
    | { field: string; op: "exists"; value: boolean; valueFrom?: never };

export interface DynamicRowCondition {
    field: string;
    op: RowOperator;
    value?: never;
    valueFrom: string;
}

export type RowCondition =
    | { all: NonEmptyReadonlyArray<RowCondition> }
    | { any: NonEmptyReadonlyArray<RowCondition> }
    | { not: RowCondition }
    | LiteralRowCondition
    | DynamicRowCondition;

export type PolicyConditionOutcome = "true" | "false" | "unknown" | "not-applicable";
