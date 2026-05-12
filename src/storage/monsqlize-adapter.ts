import type MonSQLize from "monsqlize";

import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode, type PermissionRule, type RoleData } from "../types";

import { StorageAdapter } from "./adapter";

interface CollectionLike<TDocument = Record<string, unknown>> {
    find(query?: unknown, options?: unknown): Promise<TDocument[]>;
    findOne(query?: unknown, options?: unknown): Promise<TDocument | null>;
    replaceOne(filter?: unknown, replacement?: unknown, options?: unknown): Promise<unknown>;
    deleteOne(filter?: unknown, options?: unknown): Promise<unknown>;
    createIndex(keys: unknown, options?: unknown): Promise<unknown>;
}

interface MonSQLizeWithCollections {
    collection<TDocument = Record<string, unknown>>(name: string): CollectionLike<TDocument>;
    close?(): Promise<void>;
}

export interface MonSQLizeStorageAdapterOptions {
    msq: MonSQLize;
    namespace?: string;
    ownsConnection?: boolean;
}

interface RoleDocument extends RoleData {
    _id: string;
}

interface UserRolesDocument {
    _id: string;
    userId: string;
    roleIds: string[];
}

interface RulesDocument {
    _id: string;
    roleId: string;
    rules: PermissionRule[];
}

// MonSQLizeStorageAdapter 是官方默认生产路径，对外仍保持 StorageAdapter 抽象。
export class MonSQLizeStorageAdapter extends StorageAdapter {
    private readonly msq: MonSQLizeWithCollections;
    private readonly namespace: string;
    private readonly ownsConnection: boolean;

    private rolesCollection!: CollectionLike<RoleDocument>;
    private userRolesCollection!: CollectionLike<UserRolesDocument>;
    private rulesCollection!: CollectionLike<RulesDocument>;

    constructor(options: MonSQLizeStorageAdapterOptions) {
        super();
        this.msq = options.msq as unknown as MonSQLizeWithCollections;
        this.namespace = options.namespace ?? "permission_core";
        this.ownsConnection = options.ownsConnection ?? false;
    }

    async init(): Promise<void> {
        try {
            // 每类数据都落到独立 collection，便于索引、迁移和后台排障。
            this.rolesCollection = this.msq.collection<RoleDocument>(`${this.namespace}_roles`);
            this.userRolesCollection = this.msq.collection<UserRolesDocument>(`${this.namespace}_user_roles`);
            this.rulesCollection = this.msq.collection<RulesDocument>(`${this.namespace}_rules`);

            await Promise.all([
                this.rolesCollection.createIndex({ _id: 1 }, { unique: true }),
                this.userRolesCollection.createIndex({ _id: 1 }, { unique: true }),
                this.userRolesCollection.createIndex({ roleIds: 1 }),
                this.rulesCollection.createIndex({ _id: 1 }, { unique: true }),
            ]);
        } catch (error) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.STORAGE_ERROR,
                `Failed to initialize MonSQLize storage for namespace '${this.namespace}'`,
                error,
            );
        }
    }

    async close(): Promise<void> {
        // 默认不接管外部连接，只有显式声明 ownsConnection 时才负责关闭。
        if (this.ownsConnection && typeof this.msq.close === "function") {
            try {
                await this.msq.close();
            } catch (error) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.STORAGE_ERROR,
                    `Failed to close MonSQLize storage for namespace '${this.namespace}'`,
                    error,
                );
            }
        }
    }

    async getRoles(): Promise<Map<string, RoleData>> {
        return this.withStorageError("get roles", async () => {
            const docs = await this.rolesCollection.find({});
            return new Map(docs.map((doc) => [doc._id, this.stripId(doc)]));
        });
    }

    async getRole(id: string): Promise<RoleData | null> {
        return this.withStorageError(`get role '${id}'`, async () => {
            const doc = await this.rolesCollection.findOne({ _id: id });
            return doc ? this.stripId(doc) : null;
        });
    }

    async setRole(id: string, roleData: RoleData): Promise<void> {
        await this.withStorageError(`set role '${id}'`, async () => {
            await this.rolesCollection.replaceOne(
                { _id: id },
                { _id: id, ...structuredClone(roleData) },
                { upsert: true },
            );
        });
    }

    async deleteRole(id: string): Promise<void> {
        await this.withStorageError(`delete role '${id}'`, async () => {
            await this.rolesCollection.deleteOne({ _id: id });
        });
    }

    async getUserRoles(userId: string): Promise<string[]> {
        return this.withStorageError(`get user roles '${userId}'`, async () => {
            const doc = await this.userRolesCollection.findOne({ _id: userId });
            return structuredClone(doc?.roleIds ?? []);
        });
    }

    async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
        await this.withStorageError(`set user roles '${userId}'`, async () => {
            await this.userRolesCollection.replaceOne(
                { _id: userId },
                { _id: userId, userId, roleIds: structuredClone(roleIds) },
                { upsert: true },
            );
        });
    }

    async getUsersByRole(roleId: string): Promise<string[]> {
        return this.withStorageError(`get users by role '${roleId}'`, async () => {
            const docs = await this.userRolesCollection.find({ roleIds: roleId });
            return docs.map((doc) => doc.userId);
        });
    }

    async getRules(roleId: string): Promise<PermissionRule[]> {
        return this.withStorageError(`get rules '${roleId}'`, async () => {
            const doc = await this.rulesCollection.findOne({ _id: roleId });
            return structuredClone(doc?.rules ?? []);
        });
    }

    async setRules(roleId: string, rules: PermissionRule[]): Promise<void> {
        await this.withStorageError(`set rules '${roleId}'`, async () => {
            await this.rulesCollection.replaceOne(
                { _id: roleId },
                { _id: roleId, roleId, rules: structuredClone(rules) },
                { upsert: true },
            );
        });
    }

    async deleteRules(roleId: string): Promise<void> {
        await this.withStorageError(`delete rules '${roleId}'`, async () => {
            await this.rulesCollection.deleteOne({ _id: roleId });
        });
    }

    private async withStorageError<T>(operation: string, action: () => Promise<T>): Promise<T> {
        // 统一包装底层存储异常，避免上层直接暴露 monsqlize 的实现细节。
        try {
            return await action();
        } catch (error) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.STORAGE_ERROR,
                `Failed to ${operation}`,
                error,
            );
        }
    }

    private stripId<TDocument extends { _id: string }>(doc: TDocument): Omit<TDocument, "_id"> {
        const { _id: _ignored, ...rest } = doc;
        return structuredClone(rest);
    }
}