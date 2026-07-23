import type { MonSQLizeInstance } from "monsqlize";
import type {
    VextPluginContext,
    VextRequest,
} from "vextjs";
import { describe, expect, it, vi } from "vitest";
import type {
    AuthorizedCollection,
    AuthorizedCollectionOptions,
    PermissionSubject,
    SubjectPermissionContext,
} from "../../src";
import { PermissionCore } from "../../src/core/permission-core";
import type { ResolvedPermissionVextDataOptions } from "../../src/plugins/vext/options";
import {
    createPermissionRequestMiddleware,
    requirePermissionContext,
} from "../../src/plugins/vext/request";
import { installTransparentDbFacade } from "../../src/plugins/vext/transparent-db";

class TestHttpError extends Error {
    readonly name = "HttpError";
    constructor(
        readonly status: number,
        message: string,
        readonly code?: string | number,
    ) {
        super(message);
    }
}

function fakeApp() {
    return {
        throw(options: { status: number; message: string; code?: string | number }) {
            throw new TestHttpError(options.status, options.message, options.code);
        },
    } as VextPluginContext & Record<string, unknown>;
}

function request(app: VextPluginContext, auth?: unknown) {
    return {
        app,
        ...(auth === undefined ? {} : { auth }),
    } as unknown as VextRequest;
}

function fakeAuthorizedCollection(): AuthorizedCollection<Record<string, unknown>> {
    return {
        find: vi.fn(async () => [{ orderNo: "O-1" }]),
        findOne: vi.fn(async () => ({ orderNo: "O-1" })),
        count: vi.fn(async () => 1),
        findAndCount: vi.fn(async () => ({ data: [{ orderNo: "O-1" }], total: 1 })),
        findPage: vi.fn(async () => ({
            items: [{ orderNo: "O-1" }],
            pageInfo: { hasNext: false, hasPrev: false, startCursor: null, endCursor: null },
        })),
        insertOne: vi.fn(async () => ({ acknowledged: true as const, insertedId: "id-1" })),
        updateOne: vi.fn(async () => ({ acknowledged: true as const, matchedCount: 1, modifiedCount: 1 })),
        updateMany: vi.fn(async () => ({ acknowledged: true as const, matchedCount: 1, modifiedCount: 1 })),
        deleteOne: vi.fn(async () => ({ acknowledged: true as const, deletedCount: 1 })),
        deleteMany: vi.fn(async () => ({ acknowledged: true as const, deletedCount: 1 })),
    };
}

function fakeCore() {
    const dataCalls: Array<{ name: string; options: AuthorizedCollectionOptions }> = [];
    const collections: AuthorizedCollection<Record<string, unknown>>[] = [];
    const core = {
        forSubject(_subject: PermissionSubject): SubjectPermissionContext {
            return {
                can: async () => true,
                cannot: async () => false,
                assert: async () => undefined,
                data: {
                    collection<
                        TDocument extends object,
                        TCreate extends object = Omit<TDocument, "_id">,
                    >(name: string, options: AuthorizedCollectionOptions): AuthorizedCollection<TDocument, TCreate> {
                        dataCalls.push({ name, options });
                        const collection = fakeAuthorizedCollection();
                        collections.push(collection);
                        return collection as AuthorizedCollection<TDocument, TCreate>;
                    },
                },
            } as unknown as SubjectPermissionContext;
        },
    } as unknown as PermissionCore;
    return { core, dataCalls, collections };
}

function dataOptions(
    input?: Partial<ResolvedPermissionVextDataOptions>,
): ResolvedPermissionVextDataOptions {
    return Object.freeze({
        transparent: true,
        scopeFields: Object.freeze({ tenantId: "tenantId" }),
        collections: Object.freeze({}),
        ...input,
    });
}

async function runProtected(
    app: VextPluginContext,
    core: PermissionCore,
    operation: (req: VextRequest) => Promise<void> | void,
    options = dataOptions(),
) {
    const req = request(app, { isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
    const middleware = createPermissionRequestMiddleware(core, undefined, options);
    await middleware(req, {} as never, async () => {
        await requirePermissionContext(req);
        await operation(req);
    });
}

function unsupportedExpectation(method: () => unknown) {
    expect(method).toThrowError(expect.objectContaining({ code: "DATA_OPERATION_UNSUPPORTED" }));
}

describe("Vext transparent app.db facade", () => {
    it("wraps an existing app.db, routes protected collection/model calls, and restores the host db", async () => {
        const app = fakeApp();
        const rawCollection = { raw: true };
        const rawModel = { collectionName: "orders" };
        const rawDb = {
            collection: vi.fn(() => rawCollection),
            model: vi.fn(() => rawModel),
        };
        Object.defineProperty(app, "db", {
            value: rawDb,
            enumerable: true,
            writable: true,
            configurable: true,
        });
        const installation = installTransparentDbFacade(app, {} as MonSQLizeInstance);
        const db = app.db as {
            collection(name: string): AuthorizedCollection<Record<string, unknown>> | typeof rawCollection;
            model(name: string): Record<string, unknown>;
        };
        expect(db).not.toBe(rawDb);
        expect(Object.isFrozen(db)).toBe(true);
        expect(db.collection("orders")).toBe(rawCollection);

        const duplicate = installTransparentDbFacade(app, {} as MonSQLizeInstance);
        duplicate.restore();
        expect(app.db).toBe(db);

        const { core, dataCalls, collections } = fakeCore();
        await runProtected(app, core, async () => {
            const orders = db.collection("orders") as AuthorizedCollection<Record<string, unknown>>;
            await orders.find({ status: "paid" });
            const model = db.model("Order") as {
                collectionName: string;
                findOneById(id: string): Promise<unknown>;
            };
            expect(model.collectionName).toBe("orders");
            await model.findOneById("id-1");
        });

        expect(rawDb.collection).toHaveBeenCalledTimes(1);
        expect(rawDb.model).toHaveBeenCalledWith("Order");
        expect(dataCalls).toEqual([
            { name: "orders", options: { resource: "db:orders", scopeFields: { tenantId: "tenantId" } } },
            { name: "orders", options: { resource: "db:orders", scopeFields: { tenantId: "tenantId" } } },
        ]);
        expect(collections[0]?.find).toHaveBeenCalledWith({ status: "paid" }, undefined);
        expect(collections[1]?.findOne).toHaveBeenCalledWith({ _id: "id-1" }, undefined);

        installation.restore();
        expect(app.db).toBe(rawDb);
    });

    it("creates a default app.db facade from MonSQLize and removes it on restore", () => {
        const app = fakeApp();
        const client = { id: "client" };
        const monsqlize = {
            collection: vi.fn((name: string) => ({ kind: "collection", name })),
            model: vi.fn((name: string) => ({ kind: "model", name })),
            scopedCollection: vi.fn((name: string, options: unknown) => ({ kind: "scoped-collection", name, options })),
            scopedModel: vi.fn((name: string, options: unknown) => ({ kind: "scoped-model", name, options })),
            client,
        } as unknown as MonSQLizeInstance;
        const installation = installTransparentDbFacade(app, monsqlize);
        const db = app.db as {
            collection(name: string): unknown;
            model(name: string): unknown;
            use(name: string): { collection(name: string): unknown; model(name: string): unknown };
            pool(name: string): { collection(name: string): unknown; model(name: string): unknown };
            client: unknown;
        };

        expect(db.client).toBe(client);
        expect(db.collection("orders")).toEqual({ kind: "collection", name: "orders" });
        expect(db.model("Order")).toEqual({ kind: "model", name: "Order" });
        expect(db.use("archive").collection("orders")).toEqual({
            kind: "scoped-collection",
            name: "orders",
            options: { database: "archive" },
        });
        expect(db.use("archive").model("Order")).toEqual({
            kind: "scoped-model",
            name: "ArchiveOrder",
            options: { database: "archive" },
        });
        expect(db.pool("analytics").collection("orders")).toEqual({
            kind: "scoped-collection",
            name: "orders",
            options: { pool: "analytics" },
        });
        expect(db.pool("analytics").model("Order")).toEqual({
            kind: "scoped-model",
            name: "Order",
            options: { pool: "analytics" },
        });

        installation.restore();
        expect(app).not.toHaveProperty("db");
    });

    it("fails closed for app.db.use/pool accessors inside protected request contexts", async () => {
        const app = fakeApp();
        const rawDb = {
            collection: vi.fn((name: string) => ({ kind: "collection", name })),
            model: vi.fn((name: string) => ({ kind: "model", name, collectionName: name })),
            use: vi.fn((dbName: string) => ({
                collection: vi.fn((name: string) => ({ kind: "use-collection", dbName, name })),
                model: vi.fn((name: string) => ({ kind: "use-model", dbName, name })),
            })),
            pool: vi.fn((poolName: string) => ({
                collection: vi.fn((name: string) => ({ kind: "pool-collection", poolName, name })),
                model: vi.fn((name: string) => ({ kind: "pool-model", poolName, name })),
            })),
        };
        Object.defineProperty(app, "db", { value: rawDb, enumerable: true, configurable: true });
        const installation = installTransparentDbFacade(app, {} as MonSQLizeInstance);
        const db = app.db as {
            use(name: string): { collection(name: string): unknown; model(name: string): unknown };
            pool(name: string): { collection(name: string): unknown; model(name: string): unknown };
        };

        expect(db.use("archive").collection("orders")).toEqual({ kind: "use-collection", dbName: "archive", name: "orders" });
        expect(db.pool("analytics").model("Order")).toEqual({ kind: "pool-model", poolName: "analytics", name: "Order" });

        await runProtected(app, fakeCore().core, () => {
            unsupportedExpectation(() => db.use("archive").collection("orders"));
            unsupportedExpectation(() => db.use("archive").model("Order"));
            unsupportedExpectation(() => db.pool("analytics").collection("orders"));
            unsupportedExpectation(() => db.pool("analytics").model("Order"));
        });

        installation.restore();
    });

    it("rejects unsafe app.db descriptors, invalid accessors, and failed redefinition", () => {
        const monsqlize = {
            collection: vi.fn(),
        } as unknown as MonSQLizeInstance;
        const validDb = { collection: vi.fn(), model: vi.fn() };

        const nonConfigurable = fakeApp();
        Object.defineProperty(nonConfigurable, "db", { value: validDb, configurable: false });
        expect(() => installTransparentDbFacade(nonConfigurable, monsqlize))
            .toThrowError(expect.objectContaining({ code: "VEXT_APP_EXTENSION_CONFLICT" }));

        const accessor = fakeApp();
        Object.defineProperty(accessor, "db", {
            configurable: true,
            get() {
                return validDb;
            },
        });
        expect(() => installTransparentDbFacade(accessor, monsqlize))
            .toThrowError(expect.objectContaining({ code: "VEXT_APP_EXTENSION_CONFLICT" }));

        for (const invalidDb of [
            null,
            { collection: "orders" },
            { model: "Order" },
        ]) {
            const app = fakeApp();
            Object.defineProperty(app, "db", { value: invalidDb, configurable: true });
            expect(() => installTransparentDbFacade(app, monsqlize))
                .toThrowError(expect.objectContaining({ code: "VEXT_APP_EXTENSION_CONFLICT" }));
        }

        const redefineFailure = new Proxy(fakeApp(), {
            defineProperty() {
                return false;
            },
        });
        expect(() => installTransparentDbFacade(redefineFailure, {
            collection: vi.fn(),
            model: vi.fn(),
        } as unknown as MonSQLizeInstance)).toThrowError(expect.objectContaining({
            code: "VEXT_APP_EXTENSION_CONFLICT",
            cause: expect.any(TypeError),
        }));

        const scopedInvalid = fakeApp();
        Object.defineProperty(scopedInvalid, "db", {
            value: {
                collection: vi.fn(),
                model: vi.fn(),
                use: vi.fn(() => null),
            },
            configurable: true,
        });
        const installation = installTransparentDbFacade(scopedInvalid, monsqlize);
        const db = scopedInvalid.db as { use(name: string): unknown };
        expect(() => db.use("broken")).toThrowError(expect.objectContaining({
            code: "VEXT_APP_EXTENSION_CONFLICT",
        }));
        installation.restore();
    });

    it("fails closed when default MonSQLize model or scoped accessors are unavailable", () => {
        const app = fakeApp();
        const installation = installTransparentDbFacade(app, {
            collection: vi.fn(),
        } as unknown as MonSQLizeInstance);
        const db = app.db as {
            model(name: string): unknown;
            use(name: string): { collection(name: string): unknown; model(name: string): unknown };
            pool(name: string): { collection(name: string): unknown; model(name: string): unknown };
        };

        expect(() => db.model("Order"))
            .toThrowError(expect.objectContaining({ code: "DATA_OPERATION_UNSUPPORTED" }));
        unsupportedExpectation(() => db.use("archive").collection("orders"));
        unsupportedExpectation(() => db.use("archive").model("Order"));
        unsupportedExpectation(() => db.pool("analytics").collection("orders"));
        unsupportedExpectation(() => db.pool("analytics").model("Order"));
        installation.restore();
    });
});
