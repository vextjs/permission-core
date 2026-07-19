import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import {
    createContextFailureError,
    createEvaluationSubject,
    createPolicyEvaluationEnvironment,
    evaluateNormalizedRowCondition,
    evaluateRowCondition,
    normalizeRowCondition,
    resolveNormalizedRowCondition,
} from "../../src/policy/condition";

const subject = createEvaluationSubject("user-1", { tenantId: "tenant-a" }, { merchantId: "m-1" });

function expectPermissionError(run: () => unknown, code?: string) {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionCoreError);
    if (code) expect(caught).toMatchObject({ code });
}

function environment(fieldSource: Record<string, unknown>, context: Record<string, unknown> = {}) {
    return createPolicyEvaluationEnvironment(subject, context as never, fieldSource);
}

describe("row condition structural boundaries", () => {
    it("rejects exotic records and arrays before invoking accessors", () => {
        class Exotic {
            field = "status";
            op = "eq";
            value = "paid";
        }
        const symbol = { field: "status", op: "eq", value: "paid", [Symbol("extra")]: true };
        const forbidden = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(forbidden, "__proto__", { enumerable: true, value: true });
        const accessor = { field: "status", op: "eq" } as Record<string, unknown>;
        Object.defineProperty(accessor, "value", { enumerable: true, get: () => "paid" });
        for (const value of [null, [], new Exotic(), symbol, forbidden, accessor]) {
            expectPermissionError(() => normalizeRowCondition(value), "INVALID_POLICY");
        }

        const tagged = [{ field: "status", op: "eq", value: "paid" }] as unknown[] & { extra?: boolean };
        tagged.extra = true;
        const hidden = [{ field: "status", op: "eq", value: "paid" }];
        Object.defineProperty(hidden, "0", { enumerable: false, value: hidden[0] });
        const sparse = new Array(1);
        for (const children of [tagged, hidden, sparse, new Proxy([{ field: "status", op: "eq", value: "paid" }], {})]) {
            expectPermissionError(() => normalizeRowCondition({ all: children }), "INVALID_POLICY");
        }
    });

    it("rejects invalid paths, operands, operators, and leaf shapes", () => {
        const invalid = [
            {},
            { field: "status", value: "paid" },
            { field: "status", op: "unknown", value: "paid" },
            { field: "status", op: "eq", value: "paid", extra: true },
            { field: 1, op: "eq", value: "paid" },
            { field: "a".repeat(513), op: "eq", value: "paid" },
            { field: Array.from({ length: 33 }, () => "a").join("."), op: "eq", value: "paid" },
            { field: "status", op: "eq", value: Number.NaN },
            { field: "status", op: "eq", value: "\ud800" },
            { field: "status", op: "gt", value: Number.POSITIVE_INFINITY },
            { field: "status", op: "gt", value: true },
            { field: "status", op: "contains", value: "x".repeat(257) },
            { field: "status", op: "exists", value: 1 },
            { field: "status", op: "eq", valueFrom: 1 },
            { field: "status", op: "eq", valueFrom: "subject.role" },
        ];
        for (const value of invalid) expectPermissionError(() => normalizeRowCondition(value), "INVALID_POLICY");
    });

    it("enforces depth and aggregate leaf limits", () => {
        let deep: unknown = { field: "status", op: "eq", value: "paid" };
        for (let index = 0; index < 13; index += 1) deep = { not: deep };
        expectPermissionError(() => normalizeRowCondition(deep), "LIMIT_EXCEEDED");

        const leaves = Array.from({ length: 5 }, (_, group) => ({
            all: Array.from({ length: group === 4 ? 25 : 26 }, (_, index) => ({
                field: `f${group}_${index}`,
                op: "eq" as const,
                value: true,
            })),
        }));
        expectPermissionError(() => normalizeRowCondition({ all: leaves }), "LIMIT_EXCEEDED");
    });

    it("requires logical children to be concrete arrays", () => {
        expectPermissionError(() => normalizeRowCondition({ all: {} }), "INVALID_POLICY");
        expectPermissionError(() => normalizeRowCondition({ any: "children" }), "INVALID_POLICY");
    });
});

describe("row condition resolution and evaluation boundaries", () => {
    it("resolves or reports dynamic values through all logical shapes", () => {
        const all = normalizeRowCondition({
            all: [
                { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" },
                { field: "channel", op: "eq", valueFrom: "context.channel" },
            ],
        });
        expect(resolveNormalizedRowCondition(all, subject, { channel: "admin" }).condition).toBeDefined();
        expect(resolveNormalizedRowCondition(all, subject, {}).contextFailure).toEqual({
            valueFrom: "context.channel",
            reason: "missing",
        });
        const not = normalizeRowCondition({ not: { field: "channel", op: "eq", valueFrom: "context.channel" } });
        expect(resolveNormalizedRowCondition(not, subject, {}).contextFailure).toBeDefined();
        const invalid = normalizeRowCondition({ field: "amount", op: "gt", valueFrom: "context.amount" });
        expect(resolveNormalizedRowCondition(invalid, subject, { amount: true }).contextFailure).toEqual({
            valueFrom: "context.amount",
            reason: "invalid",
        });
    });

    it("treats proxy, sparse, accessor, and tagged runtime arrays as unknown", () => {
        const condition = normalizeRowCondition({ field: "status", op: "eq", value: "paid" });
        const sparse = new Array(1);
        const tagged = ["paid"] as string[] & { extra?: string };
        tagged.extra = "extra";
        const hidden = ["paid"];
        Object.defineProperty(hidden, "0", { enumerable: false, value: "paid" });
        for (const value of [new Proxy(["paid"], {}), sparse, tagged, hidden]) {
            expect(evaluateNormalizedRowCondition(condition, environment({ status: value })).outcome).toBe("unknown");
        }
    });

    it("covers string comparisons, inverse set outcomes, exists, and logical context failures", () => {
        expect(evaluateRowCondition({ field: "name", op: "gt", value: "Ada" }, environment({ name: "Bob" })).outcome).toBe("true");
        expect(evaluateRowCondition({ field: "status", op: "nin", value: ["blocked"] }, environment({ status: "paid" })).outcome).toBe("true");
        expect(evaluateRowCondition({ field: "missing", op: "exists", value: false }, environment({})).outcome).toBe("true");
        const any = normalizeRowCondition({
            any: [
                { field: "status", op: "eq", value: "paid" },
                { field: "merchantId", op: "eq", valueFrom: "context.merchantId" },
            ],
        });
        expect(evaluateNormalizedRowCondition(any, environment({ status: "draft", merchantId: "m-1" }))).toMatchObject({
            outcome: "unknown",
            contextFailure: { reason: "missing" },
        });
    });

    it("materializes context errors and optional subject claims", () => {
        expect(createContextFailureError({ valueFrom: "context.channel", reason: "missing" })).toMatchObject({
            code: "POLICY_CONTEXT_MISSING",
            details: { field: "context.channel", reason: "missing" },
        });
        expect(createEvaluationSubject("user-1", { tenantId: "tenant-a" })).toEqual({
            userId: "user-1",
            scope: { tenantId: "tenant-a" },
        });
    });

    it("does not traverse primitive, exotic, or accessor-backed dynamic paths", () => {
        const condition = normalizeRowCondition({ field: "region", op: "eq", valueFrom: "context.request.region" });
        const exotic = { request: new Date() };
        let accessorCalls = 0;
        const accessor = {} as Record<string, unknown>;
        Object.defineProperty(accessor, "request", {
            enumerable: true,
            get() {
                accessorCalls += 1;
                return { region: "east" };
            },
        });
        for (const context of [{ request: "east" }, exotic, accessor]) {
            expect(resolveNormalizedRowCondition(condition, subject, context as never).contextFailure)
                .toEqual({ valueFrom: "context.request.region", reason: "invalid" });
        }
        expect(accessorCalls).toBe(0);
    });

    it("covers scalar and array comparison true, false, and unknown outcomes", () => {
        const cases = [
            ["eq", "paid", "paid", "true"],
            ["eq", "draft", "paid", "false"],
            ["in", "paid", ["paid", "draft"], "true"],
            ["in", "blocked", ["paid", "draft"], "false"],
            ["gt", 2, 1, "true"],
            ["gt", 1, 2, "false"],
            ["gte", 2, 2, "true"],
            ["gte", 1, 2, "false"],
            ["lt", "Ada", "Bob", "true"],
            ["lt", "Bob", "Ada", "false"],
            ["lte", 2, 2, "true"],
            ["lte", 3, 2, "false"],
            ["contains", "orders:read", "read", "true"],
            ["contains", "orders:read", "write", "false"],
            ["gt", "2", 1, "unknown"],
            ["contains", 1, "1", "unknown"],
        ] as const;
        for (const [op, left, right, outcome] of cases) {
            expect(evaluateRowCondition({ field: "value", op, value: right } as never, environment({ value: left })).outcome)
                .toBe(outcome);
        }

        const eq = normalizeRowCondition({ field: "value", op: "eq", value: "paid" });
        expect(evaluateNormalizedRowCondition(eq, environment({ value: ["draft", "paid"] })).outcome).toBe("true");
        expect(evaluateNormalizedRowCondition(eq, environment({ value: ["draft", "blocked"] })).outcome).toBe("false");
        expect(evaluateNormalizedRowCondition(eq, environment({ value: [{ unsupported: true }, "draft"] })).outcome).toBe("unknown");
    });
});
