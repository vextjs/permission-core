import { describe, expect, it } from "vitest";

import { deduplicateRules, stableCondition } from "../../../src/utils/merge";

describe("merge utils", () => {
    it("stabilizes row conditions and deduplicates equivalent where rules", () => {
        const jsonValue = {
            toJSON() {
                return { b: 2, a: 1 };
            },
        };

        expect(stableCondition({
            field: "metadata",
            op: "eq",
            value: [{ z: 1, a: jsonValue }],
        })).toBe('{"field":"metadata","op":"eq","value":[{"a":{"a":1,"b":2},"z":1}]}');

        expect(stableCondition({
            all: [
                { field: "status", op: "eq", value: "paid" },
                { field: "ownerId", op: "eq", valueFrom: "userId" },
            ],
        })).toBe(stableCondition({
            all: [
                { field: "ownerId", op: "eq", valueFrom: "userId" },
                { field: "status", op: "eq", value: "paid" },
            ],
        }));

        expect(stableCondition({
            any: [
                { field: "status", op: "eq", value: "paid" },
                { field: "ownerId", op: "eq", valueFrom: "userId" },
            ],
        })).toBe(stableCondition({
            any: [
                { field: "ownerId", op: "eq", valueFrom: "userId" },
                { field: "status", op: "eq", value: "paid" },
            ],
        }));

        expect(stableCondition({
            not: { op: "eq", value: true, field: "archived" },
        })).toBe('{"not":{"field":"archived","op":"eq","value":true}}');

        expect(stableCondition({
            field: "id",
            op: "in",
            value: ["b", "a"],
        })).toBe(stableCondition({
            field: "id",
            op: "in",
            value: ["a", "b"],
        }));

        expect(stableCondition({
            field: "optional",
            op: "in",
            value: [undefined, "a"],
        })).toBe(stableCondition({
            field: "optional",
            op: "in",
            value: ["a", undefined],
        }));

        const dynamicValue = () => "ignored";
        expect(stableCondition({
            field: "optional",
            op: "nin",
            value: [dynamicValue, "a"],
        })).toBe(stableCondition({
            field: "optional",
            op: "nin",
            value: ["a", dynamicValue],
        }));

        const rules = deduplicateRules([
            {
                type: "allow",
                action: "read",
                resource: "db:orders",
                where: { field: "ownerId", op: "eq", valueFrom: "userId" },
            },
            {
                type: "allow",
                action: "read",
                resource: "db:orders",
                where: { op: "eq", valueFrom: "userId", field: "ownerId" },
            },
        ]);

        expect(rules).toHaveLength(1);
        expect(rules[0]).toMatchObject({
            type: "allow",
            action: "read",
            resource: "db:orders",
        });
    });
});
