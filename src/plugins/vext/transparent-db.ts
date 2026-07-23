import type { MonSQLizeInstance } from "monsqlize";
import type { VextPluginContext } from "vextjs";
import { PermissionCoreError } from "../../core/errors";
import {
    createProtectedModelFacade,
    currentPermissionDataApi,
} from "./request";

const TRANSPARENT_DB_OWNER = Symbol("permission-core.vext.transparent-db");

interface DbAccessorLike {
    collection?: (name: string) => unknown;
    model?: (name: string) => unknown;
    use?: (dbName: string) => unknown;
    pool?: (poolName: string) => unknown;
    readonly client?: unknown;
}

export interface TransparentDbInstallation {
    restore(): void;
}

function unsupported(field: string): never {
    throw new PermissionCoreError(
        "DATA_OPERATION_UNSUPPORTED",
        `Vext transparent permission DB cannot protect ${field}.`,
        { details: { kind: "validation", field, reason: "use the default app.db collection/model accessor or an explicit permission data facade" } },
    );
}

function invalidDb(reason: string, cause?: unknown) {
    return new PermissionCoreError("VEXT_APP_EXTENSION_CONFLICT", "The Vext app db extension cannot be wrapped by permission-core.", {
        details: { kind: "validation", field: "app.db", reason },
        ...(cause === undefined ? {} : { cause }),
    });
}

function assertDbAccessor(value: unknown, field: string): DbAccessorLike {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        throw invalidDb(`${field} must be an object`);
    }
    const record = value as Record<string, unknown>;
    for (const key of ["collection", "model"] as const) {
        if (Object.hasOwn(record, key) && typeof record[key] !== "function") {
            throw invalidDb(`${field}.${key} must be a function`);
        }
    }
    return value as DbAccessorLike;
}

function call<T>(owner: unknown, method: string, ...args: unknown[]): T {
    const fn = (owner as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
        throw invalidDb(`app.db.${method} is required`);
    }
    return fn.apply(owner, args) as T;
}

function createMonSQLizeDb(monsqlize: MonSQLizeInstance): DbAccessorLike {
    return Object.freeze({
        collection: (name: string) => monsqlize.collection(name),
        model: (name: string) => {
            const model = (monsqlize as unknown as Record<string, unknown>).model;
            if (typeof model !== "function") {
                throw unsupported("app.db.model");
            }
            return model.call(monsqlize, name);
        },
        use(dbName: string) {
            const scoped = (monsqlize as unknown as Record<string, unknown>).scopedCollection;
            return Object.freeze({
                collection(name: string) {
                    if (currentPermissionDataApi()) unsupported("app.db.use(...).collection");
                    if (typeof scoped !== "function") unsupported("app.db.use(...).collection");
                    return scoped.call(monsqlize, name, { database: dbName });
                },
                model(name: string) {
                    if (currentPermissionDataApi()) unsupported("app.db.use(...).model");
                    const scopedModel = (monsqlize as unknown as Record<string, unknown>).scopedModel;
                    if (typeof scopedModel !== "function") unsupported("app.db.use(...).model");
                    const prefix = dbName.charAt(0).toUpperCase() + dbName.slice(1);
                    const key = prefix + name.charAt(0).toUpperCase() + name.slice(1);
                    return scopedModel.call(monsqlize, key, { database: dbName });
                },
            });
        },
        pool(poolName: string) {
            return Object.freeze({
                collection(name: string) {
                    if (currentPermissionDataApi()) unsupported("app.db.pool(...).collection");
                    const scoped = (monsqlize as unknown as Record<string, unknown>).scopedCollection;
                    if (typeof scoped !== "function") unsupported("app.db.pool(...).collection");
                    return scoped.call(monsqlize, name, { pool: poolName });
                },
                model(name: string) {
                    if (currentPermissionDataApi()) unsupported("app.db.pool(...).model");
                    const scopedModel = (monsqlize as unknown as Record<string, unknown>).scopedModel;
                    if (typeof scopedModel !== "function") unsupported("app.db.pool(...).model");
                    return scopedModel.call(monsqlize, name, { pool: poolName });
                },
            });
        },
        get client() {
            return (monsqlize as unknown as Record<string, unknown>).client;
        },
    });
}

function createScopedAccessor(raw: unknown, label: string) {
    const accessor = assertDbAccessor(raw, label);
    return Object.freeze({
        collection(name: string) {
            if (currentPermissionDataApi()) unsupported(`${label}.collection`);
            return call(accessor, "collection", name);
        },
        model(name: string) {
            if (currentPermissionDataApi()) unsupported(`${label}.model`);
            return call(accessor, "model", name);
        },
        ...(typeof accessor.use === "function"
            ? { use: (dbName: string) => createScopedAccessor(accessor.use!(dbName), `${label}.use(...)`) }
            : {}),
    });
}

function createTransparentDbFacade(rawDb: DbAccessorLike) {
    const facade = {
        collection(name: string) {
            const data = currentPermissionDataApi();
            if (data) return data.collection(name);
            return call(rawDb, "collection", name);
        },
        model(name: string) {
            const rawModel = call(rawDb, "model", name);
            const data = currentPermissionDataApi();
            if (!data) return rawModel;
            return createProtectedModelFacade(name, rawModel, data);
        },
        ...(typeof rawDb.use === "function"
            ? { use: (dbName: string) => createScopedAccessor(rawDb.use!(dbName), "app.db.use(...)") }
            : {}),
        ...(typeof rawDb.pool === "function"
            ? { pool: (poolName: string) => createScopedAccessor(rawDb.pool!(poolName), "app.db.pool(...)") }
            : {}),
        get client() {
            return (rawDb as Record<string, unknown>).client;
        },
    } satisfies DbAccessorLike;
    Object.defineProperty(facade, TRANSPARENT_DB_OWNER, {
        value: true,
        enumerable: false,
        configurable: false,
    });
    return Object.freeze(facade);
}

function isInstalled(value: unknown) {
    return Boolean(value && typeof value === "object" && (value as Record<symbol, unknown>)[TRANSPARENT_DB_OWNER]);
}

export function installTransparentDbFacade(
    app: VextPluginContext,
    monsqlize: MonSQLizeInstance,
): TransparentDbInstallation {
    const descriptor = Object.getOwnPropertyDescriptor(app, "db");
    if (descriptor && "value" in descriptor && isInstalled(descriptor.value)) {
        return Object.freeze({ restore() {} });
    }
    if (descriptor && !descriptor.configurable) {
        throw invalidDb("app.db must be configurable for transparent data protection");
    }
    if (descriptor && !("value" in descriptor)) {
        throw invalidDb("app.db must be an own data property");
    }
    const rawDb = assertDbAccessor(
        descriptor && "value" in descriptor ? descriptor.value : createMonSQLizeDb(monsqlize),
        "app.db",
    );
    const facade = createTransparentDbFacade(rawDb);
    try {
        Object.defineProperty(app, "db", {
            value: facade,
            enumerable: descriptor?.enumerable ?? true,
            writable: false,
            configurable: true,
        });
    } catch (cause) {
        throw invalidDb("cannot redefine app.db", cause);
    }
    return Object.freeze({
        restore() {
            if (descriptor) {
                Object.defineProperty(app, "db", descriptor);
            } else {
                delete (app as Record<string, unknown>).db;
            }
        },
    });
}
