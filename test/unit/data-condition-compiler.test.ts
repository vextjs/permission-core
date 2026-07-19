import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src/core/errors";
import {
    compileResolvedRowCondition,
    resolveAndCompileRowCondition,
} from "../../src/data/condition-compiler";
import { normalizeRowCondition } from "../../src/policy/condition";

const subject = {
    userId: "u-1",
    scope: { tenantId: "t-1" },
    claims: { merchantId: "m-1" },
} as const;

describe("RowCondition Mongo compiler", () => {
    it("resolves trusted operands and produces exhaustive T/F/U partitions", () => {
        const condition = normalizeRowCondition({
            all: [
                { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" },
                { not: { field: "status", op: "in", value: ["cancelled"] } },
            ],
        });
        const result = resolveAndCompileRowCondition(condition, subject, {});

        expect(result.condition).toEqual({
            all: [
                { field: "merchantId", op: "eq", value: "m-1" },
                { not: { field: "status", op: "in", value: ["cancelled"] } },
            ],
        });
        expect(result.partition.trueFilter).toHaveProperty("$and");
        expect(result.partition.falseFilter).toHaveProperty("$or");
        expect(result.partition.unknownFilter).toEqual({
            $nor: [result.partition.trueFilter, result.partition.falseFilter],
        });
    });

    it("swaps true and false for not instead of promoting unknown", () => {
        const child = compileResolvedRowCondition(normalizeRowCondition({ field: "value", op: "eq", value: 1 }));
        const negated = compileResolvedRowCondition(normalizeRowCondition({ not: { field: "value", op: "eq", value: 1 } }));
        expect(negated.trueFilter).toEqual(child.falseFilter);
        expect(negated.falseFilter).toEqual(child.trueFilter);
        expect(negated.unknownFilter).toEqual(child.unknownFilter);
    });

    it("fails a missing dynamic operand before business collection I/O", () => {
        const condition = normalizeRowCondition({ field: "merchantId", op: "eq", valueFrom: "context.merchantId" });
        expect(() => resolveAndCompileRowCondition(condition, subject, {})).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "POLICY_CONTEXT_MISSING" }),
        );
    });
});
