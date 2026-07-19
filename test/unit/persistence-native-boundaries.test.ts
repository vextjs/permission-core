import { describe, expect, it, vi } from "vitest";
import {
    createInternalPermissionCollection,
    readFindMaxLimit,
    validateFindMaxLimit,
} from "../../src/persistence/native-collection";

function createFixture() {
    const cursor = {
        sort: vi.fn(),
        limit: vi.fn(),
        toArray: vi.fn(async () => [{ id: "row-1" }]),
        explain: vi.fn(async () => ({ ok: 1 })),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);

    const native = {
        findOne: vi.fn(async () => ({ id: "row-1" })),
        find: vi.fn(() => cursor),
        countDocuments: vi.fn(async () => 1),
        insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: "id-1" })),
        insertMany: vi.fn(async () => ({ acknowledged: true, insertedCount: 1, insertedIds: { 0: "id-1" } })),
        updateOne: vi.fn(async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null })),
        updateMany: vi.fn(async () => ({ acknowledged: true, matchedCount: 2, modifiedCount: 2, upsertedCount: 0, upsertedId: null })),
        deleteOne: vi.fn(async () => ({ acknowledged: true, deletedCount: 1 })),
        deleteMany: vi.fn(async () => ({ acknowledged: true, deletedCount: 2 })),
    };
    const namespace = { iid: "db:roles", type: "mongodb", db: "db", collection: "roles" };
    const wrapper = {
        raw: vi.fn(() => native),
        getNamespace: vi.fn(() => namespace),
        createIndexes: vi.fn(async () => ["scope_1"]),
        listIndexes: vi.fn(async () => [{ name: "_id_", key: { _id: 1 } }]),
    };
    return { cursor, native, namespace, wrapper };
}

describe("MonSQLize native collection boundary", () => {
    it("validates and reads the host query budget", () => {
        expect(validateFindMaxLimit(1)).toBe(1);
        expect(validateFindMaxLimit(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
        for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => validateFindMaxLimit(value)).toThrow(expect.objectContaining({
                code: "MONSQLIZE_CONTRACT_UNSUPPORTED",
            }));
        }

        expect(readFindMaxLimit({ getDefaults: () => ({ findMaxLimit: 77 }) } as never)).toBe(77);
        expect(() => readFindMaxLimit({ getDefaults: () => null } as never)).toThrow();
        expect(() => readFindMaxLimit({ getDefaults: () => [] } as never)).toThrow();
        expect(() => readFindMaxLimit({ getDefaults: () => ({ findMaxLimit: 0 }) } as never)).toThrow();
        expect(() => readFindMaxLimit({ getDefaults: () => { throw new Error("host failure"); } } as never))
            .toThrow(expect.objectContaining({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" }));
    });

    it("forwards native operations and strips wrapper-only options", async () => {
        const { cursor, native, namespace, wrapper } = createFixture();
        const collection = createInternalPermissionCollection(wrapper as never);
        const session = { id: "session-1" };
        const wrapperOptions = { session, cache: 0, autoInvalidate: false };

        expect(Object.isFrozen(collection)).toBe(true);
        expect(collection.getNamespace()).toBe(namespace);
        await expect(collection.findOne({ id: 1 }, wrapperOptions)).resolves.toEqual({ id: "row-1" });
        expect(native.findOne).toHaveBeenCalledWith({ id: 1 }, { session });
        expect(collection.find({ active: true }, wrapperOptions)).toBe(cursor);
        expect(native.find).toHaveBeenCalledWith({ active: true }, { session });
        await expect(collection.explain({ active: true }, {
            verbosity: "executionStats",
            projection: { id: 1 },
            cache: false,
            autoInvalidate: true,
        })).resolves.toEqual({ ok: 1 });
        expect(native.find).toHaveBeenLastCalledWith({ active: true }, { projection: { id: 1 } });
        expect(cursor.explain).toHaveBeenCalledWith("executionStats");
        await expect(collection.count()).resolves.toBe(1);

        await expect(collection.insertOne({ id: 1 }, wrapperOptions)).resolves.toMatchObject({ insertedId: "id-1" });
        await expect(collection.insertMany([{ id: 1 }], wrapperOptions)).resolves.toMatchObject({ insertedCount: 1 });
        await expect(collection.updateOne({ id: 1 }, { $set: { active: true } }, wrapperOptions)).resolves.toMatchObject({ modifiedCount: 1 });
        await expect(collection.updateMany({}, { $set: { active: true } }, wrapperOptions)).resolves.toMatchObject({ modifiedCount: 2 });
        await expect(collection.deleteOne({ id: 1 }, wrapperOptions)).resolves.toMatchObject({ deletedCount: 1 });
        await expect(collection.deleteMany({}, wrapperOptions)).resolves.toMatchObject({ deletedCount: 2 });
        await expect(collection.createIndexes([{ name: "scope_1", key: { scopeKey: 1 } }])).resolves.toEqual(["scope_1"]);
        await expect(collection.listIndexes()).resolves.toEqual([{ name: "_id_", key: { _id: 1 } }]);
    });

    it("rejects invalid options, cursors, explain handles, write results, and index snapshots", async () => {
        const { cursor, native, wrapper } = createFixture();
        const collection = createInternalPermissionCollection(wrapper as never);

        for (const options of [null, [], "options"]) {
            expect(() => collection.findOne({}, options)).toThrow(TypeError);
        }

        native.find.mockReturnValueOnce(null as never);
        expect(() => collection.find()).toThrow(expect.objectContaining({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" }));
        native.find.mockReturnValueOnce({ sort: vi.fn(), limit: vi.fn() } as never);
        expect(() => collection.find()).toThrow(expect.objectContaining({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" }));
        native.find.mockReturnValueOnce({ ...cursor, explain: undefined } as never);
        await expect(collection.explain()).rejects.toMatchObject({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" });

        native.insertOne.mockResolvedValueOnce(null as never);
        await expect(collection.insertOne({})).rejects.toMatchObject({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" });
        native.updateOne.mockResolvedValueOnce([] as never);
        await expect(collection.updateOne({}, {})).rejects.toMatchObject({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" });
        wrapper.listIndexes.mockResolvedValueOnce({ name: "_id_" } as never);
        await expect(collection.listIndexes()).rejects.toMatchObject({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" });
    });

    it("rejects failed or incomplete raw collection capabilities", () => {
        expect(() => createInternalPermissionCollection({
            raw: () => { throw new Error("raw failed"); },
        } as never)).toThrow(expect.objectContaining({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" }));

        for (const raw of [null, [], {}, { findOne: vi.fn() }]) {
            expect(() => createInternalPermissionCollection({ raw: () => raw } as never))
                .toThrow(expect.objectContaining({ code: "MONSQLIZE_CONTRACT_UNSUPPORTED" }));
        }
    });
});
