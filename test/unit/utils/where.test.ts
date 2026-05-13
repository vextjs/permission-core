import { describe, expect, it } from "vitest";

import { combineAnyConditions, evaluateRowCondition } from "../../../src/utils/where";

describe("where utils", () => {
    it("combines any-conditions only when needed", () => {
        const condition = { field: "ownerId", op: "eq", value: "user-001" } as const;

        expect(combineAnyConditions([])).toBeUndefined();
        expect(combineAnyConditions([condition])).toBe(condition);
        expect(combineAnyConditions([condition, { field: "status", op: "eq", value: "paid" }])).toEqual({
            any: [condition, { field: "status", op: "eq", value: "paid" }],
        });
    });

    it("evaluates logical row conditions", () => {
        const row = { ownerId: "user-001", status: "paid", archived: false };
        const context = { userId: "user-001" };

        expect(
            evaluateRowCondition(
                {
                    all: [
                        { field: "ownerId", op: "eq", valueFrom: "userId" },
                        { field: "status", op: "eq", value: "paid" },
                    ],
                },
                row,
                context,
            ),
        ).toBe(true);

        expect(
            evaluateRowCondition(
                {
                    any: [
                        { field: "ownerId", op: "eq", value: "other" },
                        { field: "status", op: "eq", value: "paid" },
                    ],
                },
                row,
                context,
            ),
        ).toBe(true);

        expect(
            evaluateRowCondition(
                { not: { field: "archived", op: "eq", value: true } },
                row,
                context,
            ),
        ).toBe(true);
    });

    it("evaluates scalar operators and valueFrom lookups", () => {
        const row = {
            ownerId: "user-001",
            score: 10,
            tags: ["vip", "paid"],
            title: "paid invoice",
        };
        const context = { userId: "user-001" };

        expect(evaluateRowCondition({ field: "ownerId", op: "eq", valueFrom: "userId" }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "ownerId", op: "ne", value: "user-002" }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "ownerId", op: "in", value: ["user-001", "user-002"] }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "ownerId", op: "nin", value: ["user-003"] }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "score", op: "gt", value: 9 }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "score", op: "gte", value: 10 }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "score", op: "lt", value: 11 }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "score", op: "lte", value: 10 }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "title", op: "contains", value: "invoice" }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "tags", op: "contains", value: "vip" }, row, context)).toBe(true);
        expect(evaluateRowCondition({ field: "missing", op: "exists" }, row, context)).toBe(false);
        expect(evaluateRowCondition({ field: "missing", op: "exists", value: false }, row, context)).toBe(true);
    });

    it("returns false when comparison values are missing or unsupported", () => {
        const row = { score: null, title: "paid invoice" };

        expect(evaluateRowCondition({ field: "score", op: "gt", value: 1 }, row, {})).toBe(false);
        expect(evaluateRowCondition({ field: "score", op: "gte", value: 1 }, row, {})).toBe(false);
        expect(evaluateRowCondition({ field: "score", op: "lt", value: 1 }, row, {})).toBe(false);
        expect(evaluateRowCondition({ field: "score", op: "lte", value: 1 }, row, {})).toBe(false);
        expect(evaluateRowCondition({ field: "title", op: "contains", value: 1 }, row, {})).toBe(false);
        expect(evaluateRowCondition({ field: "title", op: "in", value: "paid" as never }, row, {})).toBe(false);
        expect(evaluateRowCondition({ field: "title", op: "nin", value: "paid" as never }, row, {})).toBe(false);
    });
});