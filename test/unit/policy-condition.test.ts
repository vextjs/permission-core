import { describe, expect, it } from "vitest";
import {
    PermissionCoreError,
    type PermissionSubject,
    type PolicyContext,
    type RowCondition,
} from "../../src";
import {
    createPolicyEvaluationEnvironment,
    evaluateNormalizedRowCondition,
    evaluateRowCondition,
    normalizeRowCondition,
} from "../../src/policy";

const subject: PermissionSubject = Object.freeze({
    userId: "u-1",
    scope: Object.freeze({ tenantId: "tenant-a", appId: "admin" }),
    claims: Object.freeze({
        merchantId: "m-1",
        regionIds: Object.freeze(["north", "south"]),
    }),
});

function evaluate(condition: unknown, fieldSource: Record<string, unknown>, context: PolicyContext = {}) {
    return evaluateRowCondition(
        condition,
        createPolicyEvaluationEnvironment(subject, Object.freeze(context), fieldSource),
    );
}

describe("RowCondition normalization", () => {
    it("copies, freezes, and canonicalizes set operands", () => {
        const input = {
            all: [
                { field: "status", op: "in", value: ["paid", "paid", "draft"] },
                { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" },
            ],
        };
        const normalized = normalizeRowCondition(input);
        expect(normalized).not.toBe(input);
        expect(Object.isFrozen(normalized)).toBe(true);
        expect(Object.isFrozen((normalized as { all: readonly RowCondition[] }).all)).toBe(true);
        const first = (normalized as unknown as { all: readonly [{ value: readonly string[] }] }).all[0];
        expect(first.value).toEqual(["draft", "paid"]);

        (input.all[0] as { value: string[] }).value.push("cancelled");
        expect(first.value).toEqual(["draft", "paid"]);
    });

    it("rejects ambiguous, empty, unsafe, accessor, sparse, cyclic, and oversized input", () => {
        const accessor: Record<string, unknown> = { field: "status", op: "eq" };
        Object.defineProperty(accessor, "value", { enumerable: true, get: () => "paid" });
        const sparse = new Array(1);
        const cyclic: Record<string, unknown> = {};
        cyclic.not = cyclic;

        const invalidValues: unknown[] = [
            { all: [] },
            { field: "status", op: "eq" },
            { field: "status", op: "eq", value: "paid", valueFrom: "claims.status" },
            { field: "__proto__.role", op: "eq", value: "admin" },
            { field: "status", op: "in", value: [] },
            { field: "status", op: "contains", value: "" },
            { field: "status", op: "eq", valueFrom: "merchantId" },
            accessor,
            { all: sparse },
            cyclic,
            { field: "status", op: "eq", value: "x".repeat(65 * 1024) },
        ];
        for (const value of invalidValues) {
            expect(() => normalizeRowCondition(value)).toThrowError(PermissionCoreError);
        }
    });

    it("rejects Proxy input before invoking traps", () => {
        let traps = 0;
        const value = new Proxy({ field: "status", op: "eq", value: "paid" }, {
            ownKeys() {
                traps += 1;
                return [];
            },
        });
        expect(() => normalizeRowCondition(value)).toThrowError(PermissionCoreError);
        expect(traps).toBe(0);
    });
});

describe("RowCondition evaluator", () => {
    it.each([
        ["eq", "paid", "paid", "true"],
        ["eq", "paid", "draft", "false"],
        ["ne", "paid", "paid", "false"],
        ["ne", "paid", "draft", "true"],
        ["in", ["paid", "shipped"], "paid", "true"],
        ["nin", ["paid", "shipped"], "draft", "true"],
        ["gt", 10, 11, "true"],
        ["gte", 10, 10, "true"],
        ["lt", 10, 9, "true"],
        ["lte", 10, 11, "false"],
        ["contains", "ship", "shipped", "true"],
        ["exists", true, "paid", "true"],
        ["exists", false, undefined, "true"],
    ] as const)("evaluates %s literals", (op, value, actual, expected) => {
        const fieldSource = actual === undefined ? {} : { target: actual };
        expect(evaluate({ field: "target", op, value }, fieldSource).outcome).toBe(expected);
    });

    it("uses existential array semantics without hiding unsupported elements", () => {
        expect(evaluate(
            { field: "status", op: "eq", value: "paid" },
            { status: ["draft", "paid", { unsafe: true }] },
        ).outcome).toBe("true");
        expect(evaluate(
            { field: "status", op: "eq", value: "paid" },
            { status: ["draft", { unsafe: true }] },
        ).outcome).toBe("unknown");
        expect(evaluate(
            { field: "status", op: "ne", value: "paid" },
            { status: ["draft", { unsafe: true }] },
        ).outcome).toBe("unknown");
        expect(evaluate(
            { field: "status", op: "ne", value: "paid" },
            { status: ["draft", "paid", { unsafe: true }] },
        ).outcome).toBe("false");
    });

    it("returns unknown for missing or wrong-type left operands", () => {
        expect(evaluate({ field: "missing", op: "eq", value: "paid" }, {}).outcome).toBe("unknown");
        expect(evaluate({ field: "target", op: "gt", value: 10 }, { target: "11" }).outcome).toBe("unknown");
        expect(evaluate({ field: "target", op: "contains", value: "1" }, { target: 11 }).outcome).toBe("unknown");
        expect(evaluate({ field: "target", op: "eq", value: "paid" }, { target: { value: "paid" } }).outcome).toBe("unknown");
    });

    it("applies Kleene all, any, and not semantics", () => {
        const environment = createPolicyEvaluationEnvironment(subject, {}, { status: "paid" });
        const all = normalizeRowCondition({
            all: [
                { field: "status", op: "eq", value: "paid" },
                { field: "missing", op: "eq", value: true },
            ],
        });
        const any = normalizeRowCondition({
            any: [
                { field: "status", op: "eq", value: "paid" },
                { field: "missing", op: "eq", value: true },
            ],
        });
        expect(evaluateNormalizedRowCondition(all, environment).outcome).toBe("unknown");
        expect(evaluateNormalizedRowCondition(any, environment).outcome).toBe("true");
        expect(evaluate({ not: { field: "missing", op: "eq", value: true } }, {}).outcome).toBe("unknown");
    });

    it("resolves all trusted valueFrom roots", () => {
        const fieldSource = {
            userId: "u-1",
            tenantId: "tenant-a",
            merchantId: "m-1",
            channel: "admin",
            region: "south",
        };
        const condition = {
            all: [
                { field: "userId", op: "eq", valueFrom: "subject.userId" },
                { field: "tenantId", op: "eq", valueFrom: "scope.tenantId" },
                { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" },
                { field: "channel", op: "eq", valueFrom: "context.request.channel" },
                { field: "region", op: "in", valueFrom: "claims.regionIds" },
            ],
        };
        expect(evaluate(condition, fieldSource, { request: { channel: "admin" } }).outcome).toBe("true");
    });

    it("keeps missing or invalid dynamic operands distinct from left-side unknown", () => {
        const missing = evaluate(
            {
                all: [
                    { field: "status", op: "eq", value: "draft" },
                    { field: "merchantId", op: "eq", valueFrom: "context.merchantId" },
                ],
            },
            { status: "paid", merchantId: "m-1" },
        );
        expect(missing).toEqual({
            outcome: "false",
            contextFailure: { valueFrom: "context.merchantId", reason: "missing" },
        });

        const invalid = evaluate(
            { field: "merchantId", op: "eq", valueFrom: "context.merchantId" },
            { merchantId: "m-1" },
            { merchantId: ["m-1"] },
        );
        expect(invalid).toEqual({
            outcome: "unknown",
            contextFailure: { valueFrom: "context.merchantId", reason: "invalid" },
        });
    });
});
