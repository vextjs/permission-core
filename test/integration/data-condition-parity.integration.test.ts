import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    compileResolvedRowCondition,
    type MongoFilterDocument,
} from "../../src/data/condition-compiler";
import {
    createPolicyEvaluationEnvironment,
    evaluateNormalizedRowCondition,
    normalizeRowCondition,
} from "../../src/policy/condition";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;

interface NativeCursor {
    project(value: unknown): NativeCursor;
    toArray(): Promise<Record<string, unknown>[]>;
}

interface NativeCollection {
    insertMany(value: readonly Record<string, unknown>[]): Promise<unknown>;
    find(filter: MongoFilterDocument): NativeCursor;
}

describe("RowCondition T/F/U Mongo parity", () => {
    let context: RealMongoContext;
    let collection: NativeCollection;
    const subject = { userId: "u-1", scope: { tenantId: "t-1" } } as const;
    const fixtures: readonly Record<string, unknown>[] = [
        { _id: "missing" },
        { _id: "null", value: null },
        { _id: "false", value: false },
        { _id: "number-1", value: 1 },
        { _id: "number-2", value: 2 },
        { _id: "string-a", value: "alpha" },
        { _id: "string-b", value: "beta" },
        { _id: "object", value: { nested: 1 } },
        { _id: "empty-array", value: [] },
        { _id: "number-array", value: [1, 2] },
        { _id: "string-array", value: ["alpha", "beta"] },
        { _id: "mixed-match", value: [1, { nested: 1 }] },
        { _id: "mixed-no-match", value: [2, { nested: 1 }] },
        { _id: "date", value: new Date("2026-01-01T00:00:00.000Z") },
        { _id: "binary", value: Buffer.from([1, 2, 3]) },
        { _id: "regexp", value: /alpha/u },
    ];

    beforeAll(async () => {
        context = await startRealMongo();
        collection = context.monsqlize.collection(`condition_parity_${randomUUID().replaceAll("-", "")}`).raw() as NativeCollection;
        await collection.insertMany(fixtures);
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    async function ids(filter: MongoFilterDocument) {
        const rows = await collection.find(filter).project({ _id: 1 }).toArray();
        return rows.map((row) => row._id as string).sort();
    }

    it.each([
        ["eq", { field: "value", op: "eq", value: 1 }],
        ["ne", { field: "value", op: "ne", value: 1 }],
        ["in", { field: "value", op: "in", value: [1, "alpha"] }],
        ["nin", { field: "value", op: "nin", value: [1, "alpha"] }],
        ["gt-number", { field: "value", op: "gt", value: 1 }],
        ["gt-string", { field: "value", op: "gt", value: "alpha" }],
        ["contains", { field: "value", op: "contains", value: "ph" }],
        ["exists", { field: "value", op: "exists", value: true }],
        ["not", { not: { field: "value", op: "eq", value: 1 } }],
        ["all", { all: [{ field: "value", op: "exists", value: true }, { field: "value", op: "ne", value: 2 }] }],
        ["any", { any: [{ field: "value", op: "eq", value: 1 }, { field: "value", op: "eq", value: "beta" }] }],
    ] as const)("matches evaluator partition for %s", async (_label, input) => {
        const condition = normalizeRowCondition(input);
        const partition = compileResolvedRowCondition(condition);
        const expected = { true: [] as string[], false: [] as string[], unknown: [] as string[] };
        for (const raw of fixtures) {
            const outcome = evaluateNormalizedRowCondition(
                condition,
                createPolicyEvaluationEnvironment(subject, {}, raw),
            ).outcome;
            expected[outcome].push(raw._id as string);
        }
        expected.true.sort();
        expected.false.sort();
        expected.unknown.sort();

        const actual = {
            true: await ids(partition.trueFilter),
            false: await ids(partition.falseFilter),
            unknown: await ids(partition.unknownFilter),
        };
        expect(actual).toEqual(expected);
        expect(new Set([...actual.true, ...actual.false, ...actual.unknown]).size).toBe(fixtures.length);
    });
});
