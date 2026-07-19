import type {
    CacheLike,
    HealthView,
    MonSQLizeInstance,
} from "monsqlize";
import { vi } from "vitest";

type StubMock = ReturnType<typeof vi.fn>;

export interface MonSQLizeStub {
    instance: MonSQLizeInstance;
    cache: CacheLike;
    admin: { serverStatus: StubMock };
    database: { admin: StubMock };
    collections: Map<string, Record<string, unknown>>;
    spies: {
        connect: StubMock;
        getCache: StubMock;
        getDefaults: StubMock;
        close: StubMock;
        health: StubMock;
        collection: StubMock;
        db: StubMock;
        withTransaction: StubMock;
    };
}

export function createMonSQLizeStub(): MonSQLizeStub {
    const cache = {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        del: vi.fn(async () => false),
        delPattern: vi.fn(async () => 0),
    } as unknown as CacheLike;
    const admin = {
        serverStatus: vi.fn(async () => ({ ok: 1, localTime: new Date() })),
    };
    const database = {
        admin: vi.fn(() => admin),
    };
    const collections = new Map<string, Record<string, unknown>>();

    function findChain(rows: Record<string, unknown>[] = []) {
        let limitValue = Number.POSITIVE_INFINITY;
        const chain = {
            limit: vi.fn((value: number) => {
                limitValue = value;
                return chain;
            }),
            skip: vi.fn(() => chain),
            sort: vi.fn(() => chain),
            project: vi.fn(() => chain),
            hint: vi.fn(() => chain),
            collation: vi.fn(() => chain),
            comment: vi.fn(() => chain),
            maxTimeMS: vi.fn(() => chain),
            batchSize: vi.fn(() => chain),
            explain: vi.fn(async () => ({})),
            stream: vi.fn(),
            toArray: vi.fn(async () => rows.slice(0, limitValue)),
        };
        return chain;
    }

    const collection = vi.fn((name: string) => {
        const existing = collections.get(name);
        if (existing) {
            return existing;
        }
        const indexes: Record<string, unknown>[] = [
            { name: "_id_", key: { _id: 1 } },
        ];
        const handle = {
            getNamespace: vi.fn(() => ({
                iid: `test-db:${name}`,
                type: "mongodb" as const,
                db: "test-db",
                collection: name,
            })),
            raw: vi.fn(() => handle),
            findOne: vi.fn(async () => null),
            find: vi.fn(() => findChain()),
            findAndCount: vi.fn(async () => ({ data: [], total: 0 })),
            findPage: vi.fn(async () => ({ data: [], nextCursor: null })),
            count: vi.fn(async () => 0),
            countDocuments: vi.fn(async () => 0),
            insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: "id" })),
            insertMany: vi.fn(async () => ({ acknowledged: true, insertedCount: 0, insertedIds: {} })),
            updateOne: vi.fn(async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null })),
            updateMany: vi.fn(async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null })),
            deleteOne: vi.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
            deleteMany: vi.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
            createIndexes: vi.fn(async (specs: Record<string, unknown>[]) => {
                for (const spec of specs) {
                    const position = indexes.findIndex((candidate) => candidate.name === spec.name);
                    if (position >= 0) {
                        indexes[position] = { ...spec };
                    } else {
                        indexes.push({ ...spec });
                    }
                }
                return specs.map((spec) => spec.name as string);
            }),
            listIndexes: vi.fn(async () => indexes.map((item) => ({ ...item }))),
        };
        collections.set(name, handle);
        return handle;
    });

    const health = vi.fn<() => Promise<HealthView>>(async () => ({ status: "up", connected: true }));
    const getDefaults = vi.fn(() => Object.freeze({ findMaxLimit: 10_000 }));
    const getCache = vi.fn(() => cache);
    const db = vi.fn(() => database);
    const connect = vi.fn(async () => ({}));
    const close = vi.fn(async () => undefined);
    const withTransaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        state: "active",
        abort: vi.fn(async () => undefined),
        session: {
            id: "test-session",
            inTransaction: vi.fn(() => true),
        },
    }));

    const instance = {
        connect,
        getCache,
        getDefaults,
        close,
        health,
        collection,
        db,
        withTransaction,
    } as unknown as MonSQLizeInstance;

    return {
        instance,
        cache,
        admin,
        database,
        collections,
        spies: {
            connect,
            getCache,
            getDefaults,
            close,
            health,
            collection,
            db,
            withTransaction,
        },
    };
}
