import type { Transaction } from "monsqlize";

export interface AuthorizedCollectionOptions {
    resource: string;
    scopeFields: {
        tenantId: string;
        appId?: string;
        moduleId?: string;
        namespace?: string;
    };
}

export type SafeMongoScalar = null | boolean | number | string | Date | Uint8Array;

export type SafeMongoValue =
    | SafeMongoScalar
    | readonly SafeMongoValue[]
    | Readonly<{ [key: string]: SafeMongoValue }>;

export type SafeMongoFilter = Readonly<Record<string, SafeMongoValue>>;
export type SafeMongoUpdate = Readonly<Record<string, Readonly<Record<string, SafeMongoValue>>>>;
export type AuthorizedDocument<T> = Partial<T>;

export interface AuthorizedReadOptions {
    projection?: Readonly<Record<string, 0 | 1>> | readonly string[];
    sort?: Readonly<Record<string, 1 | -1>>;
    limit?: number;
    maxTimeMS?: number;
    transaction?: Transaction;
}

export type AuthorizedFindOneOptions = Omit<AuthorizedReadOptions, "limit">;

export type AuthorizedPageQuery = Omit<AuthorizedReadOptions, "limit"> & {
    filter?: SafeMongoFilter;
    totals?: boolean;
} & (
    | { first?: number; after?: string; last?: never; before?: never }
    | { last: number; before?: string; first?: never; after?: never }
);

export interface AuthorizedPageResult<T> {
    items: readonly AuthorizedDocument<T>[];
    pageInfo: {
        hasNext: boolean;
        hasPrev: boolean;
        startCursor: string | null;
        endCursor: string | null;
    };
    total?: number;
}

export interface AuthorizedInsertResult {
    acknowledged: true;
    insertedId: unknown;
}

export interface AuthorizedUpdateResult {
    acknowledged: true;
    matchedCount: number;
    modifiedCount: number;
}

export interface AuthorizedDeleteResult {
    acknowledged: true;
    deletedCount: number;
}

export interface AuthorizedBulkWriteOptions {
    maxAffected: number;
    transaction?: Transaction;
}

export interface AuthorizedCollection<
    TDocument extends object,
    TCreate extends object = Omit<TDocument, "_id">,
> {
    find(filter?: SafeMongoFilter, options?: AuthorizedReadOptions): Promise<AuthorizedDocument<TDocument>[]>;
    findOne(filter?: SafeMongoFilter, options?: AuthorizedFindOneOptions): Promise<AuthorizedDocument<TDocument> | null>;
    count(filter?: SafeMongoFilter, options?: Pick<AuthorizedReadOptions, "maxTimeMS" | "transaction">): Promise<number>;
    findAndCount(filter?: SafeMongoFilter, options?: AuthorizedReadOptions): Promise<{ data: AuthorizedDocument<TDocument>[]; total: number }>;
    findPage(query?: AuthorizedPageQuery): Promise<AuthorizedPageResult<TDocument>>;
    insertOne(document: TCreate, options?: { transaction?: Transaction }): Promise<AuthorizedInsertResult>;
    updateOne(filter: SafeMongoFilter, update: SafeMongoUpdate, options?: { transaction?: Transaction }): Promise<AuthorizedUpdateResult>;
    updateMany(filter: SafeMongoFilter, update: SafeMongoUpdate, options: AuthorizedBulkWriteOptions): Promise<AuthorizedUpdateResult>;
    deleteOne(filter: SafeMongoFilter, options?: { transaction?: Transaction }): Promise<AuthorizedDeleteResult>;
    deleteMany(filter: SafeMongoFilter, options: AuthorizedBulkWriteOptions): Promise<AuthorizedDeleteResult>;
}

export interface SubjectDataRuntime {
    collection<
        TDocument extends object,
        TCreate extends object = Omit<TDocument, "_id">,
    >(name: string, options: AuthorizedCollectionOptions): AuthorizedCollection<TDocument, TCreate>;
}
