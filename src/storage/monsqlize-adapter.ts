import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode, type PermissionRule, type PermissionScope, type RoleData } from "../types";
import { DEFAULT_PERMISSION_SCOPE, getPermissionScopeKey, normalizePermissionScope } from "../scope/scope";
import type { ScopedStorageAdapter } from "../scope/scoped-storage";

import { StorageAdapter } from "./adapter";

/**
 * MonSQLize collection 的最小能力约束。
 */
interface CollectionLike<TDocument = Record<string, unknown>> {
    find(query?: unknown, options?: unknown): Promise<TDocument[]>;
    findOne(query?: unknown, options?: unknown): Promise<TDocument | null>;
    replaceOne(filter?: unknown, replacement?: unknown, options?: unknown): Promise<unknown>;
    deleteOne(filter?: unknown, options?: unknown): Promise<unknown>;
    createIndex(keys: unknown, options?: unknown): Promise<unknown>;
}

/**
 * permission-core 实际依赖的 MonSQLize 接口子集。
 */
interface MonSQLizeWithCollections {
    collection<TDocument = Record<string, unknown>>(name: string): CollectionLike<TDocument>;
    close?(): Promise<void>;
}

/** permission-core 对 MonSQLize 实例要求的公开最小结构。 */
export interface MonSQLizeCollectionSource {
    collection(name: string): unknown;
    close?(): Promise<void>;
}

/**
 * MonSQLizeStorageAdapter 构造参数。
 */
export interface MonSQLizeStorageAdapterOptions {
    /** 已初始化的 MonSQLize 实例。 */
    msq: MonSQLizeCollectionSource;
    /** collection 命名空间前缀。 */
    namespace?: string;
    /** 关闭适配器时是否顺带关闭连接。 */
    ownsConnection?: boolean;
}

interface ScopeDocumentFields {
    scopeKey: string;
    tenantId: string;
    appId?: string;
    moduleId?: string;
    namespace?: string;
}

/** 角色文档结构。 */
interface RoleDocument extends RoleData, ScopeDocumentFields {
    _id: string;
}

/** 用户角色绑定文档结构。 */
interface UserRolesDocument extends ScopeDocumentFields {
    _id: string;
    userId: string;
    roleIds: string[];
}

/** 角色规则文档结构。 */
interface RulesDocument extends ScopeDocumentFields {
    _id: string;
    roleId: string;
    rules: PermissionRule[];
}

/**
 * 基于 MonSQLize 的官方持久化适配器。
 */
export class MonSQLizeStorageAdapter extends StorageAdapter implements ScopedStorageAdapter {
    private readonly msq: MonSQLizeWithCollections;
    private readonly namespace: string;
    private readonly ownsConnection: boolean;

    private rolesCollection!: CollectionLike<RoleDocument>;
    private userRolesCollection!: CollectionLike<UserRolesDocument>;
    private rulesCollection!: CollectionLike<RulesDocument>;

    /**
     * @param options MonSQLize 实例与命名空间配置。
     */
    constructor(options: MonSQLizeStorageAdapterOptions) {
        super();
        this.msq = options.msq as unknown as MonSQLizeWithCollections;
        this.namespace = options.namespace ?? "permission_core";
        this.ownsConnection = options.ownsConnection ?? false;
    }

    /**
     * 初始化 collections 并建立索引。
     */
    async init(): Promise<void> {
        try {
            // 每类数据都落到独立 collection，便于索引、迁移和后台排障。
            this.rolesCollection = this.msq.collection<RoleDocument>(`${this.namespace}_roles`);
            this.userRolesCollection = this.msq.collection<UserRolesDocument>(`${this.namespace}_user_roles`);
            this.rulesCollection = this.msq.collection<RulesDocument>(`${this.namespace}_rules`);

            await Promise.all([
                this.rolesCollection.createIndex({ _id: 1 }, { unique: true }),
                this.rolesCollection.createIndex({ scopeKey: 1, id: 1 }, { unique: true }),
                this.userRolesCollection.createIndex({ _id: 1 }, { unique: true }),
                this.userRolesCollection.createIndex({ scopeKey: 1, userId: 1 }, { unique: true }),
                this.userRolesCollection.createIndex({ scopeKey: 1, roleIds: 1 }),
                this.rulesCollection.createIndex({ _id: 1 }, { unique: true }),
                this.rulesCollection.createIndex({ scopeKey: 1, roleId: 1 }, { unique: true }),
            ]);
        } catch (error) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.STORAGE_ERROR,
                `Failed to initialize MonSQLize storage for namespace '${this.namespace}'`,
                error,
            );
        }
    }

    /**
     * 关闭底层 MonSQLize 连接（仅在 ownsConnection=true 时）。
     */
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

    /** 获取全部角色。 */
    async getRoles(): Promise<Map<string, RoleData>> {
        return this.getScopedRoles(DEFAULT_PERMISSION_SCOPE);
    }

    /** 获取 scope 内全部角色。 */
    async getScopedRoles(scope: PermissionScope): Promise<Map<string, RoleData>> {
        return this.withStorageError("get roles", async () => {
            const docs = await this.rolesCollection.find({ scopeKey: getPermissionScopeKey(scope) });
            return new Map(docs.map((doc) => [doc.id, this.stripRoleDocument(doc)]));
        });
    }

    /** 获取单个角色。 */
    async getRole(id: string): Promise<RoleData | null> {
        return this.getScopedRole(DEFAULT_PERMISSION_SCOPE, id);
    }

    /** 获取 scope 内单个角色。 */
    async getScopedRole(scope: PermissionScope, id: string): Promise<RoleData | null> {
        return this.withStorageError(`get role '${id}'`, async () => {
            const doc = await this.rolesCollection.findOne({ _id: this.getDocumentId(scope, id) });
            return doc ? this.stripRoleDocument(doc) : null;
        });
    }

    /** 写入角色。 */
    async setRole(id: string, roleData: RoleData): Promise<void> {
        await this.setScopedRole(DEFAULT_PERMISSION_SCOPE, id, roleData);
    }

    /** 写入 scope 内角色。 */
    async setScopedRole(scope: PermissionScope, id: string, roleData: RoleData): Promise<void> {
        await this.withStorageError(`set role '${id}'`, async () => {
            const documentId = this.getDocumentId(scope, id);
            await this.rolesCollection.replaceOne(
                { _id: documentId },
                { _id: documentId, ...this.getScopeFields(scope), ...structuredClone(roleData) },
                { upsert: true },
            );
        });
    }

    /** 删除角色。 */
    async deleteRole(id: string): Promise<void> {
        await this.deleteScopedRole(DEFAULT_PERMISSION_SCOPE, id);
    }

    /** 删除 scope 内角色。 */
    async deleteScopedRole(scope: PermissionScope, id: string): Promise<void> {
        await this.withStorageError(`delete role '${id}'`, async () => {
            await this.rolesCollection.deleteOne({ _id: this.getDocumentId(scope, id) });
        });
    }

    /** 获取某个用户绑定的角色列表。 */
    async getUserRoles(userId: string): Promise<string[]> {
        return this.getScopedUserRoles(DEFAULT_PERMISSION_SCOPE, userId);
    }

    /** 获取 scope 内某个用户绑定的角色列表。 */
    async getScopedUserRoles(scope: PermissionScope, userId: string): Promise<string[]> {
        return this.withStorageError(`get user roles '${userId}'`, async () => {
            const doc = await this.userRolesCollection.findOne({ _id: this.getDocumentId(scope, userId) });
            return structuredClone(doc?.roleIds ?? []);
        });
    }

    /** 覆盖写入某个用户的角色列表。 */
    async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
        await this.setScopedUserRoles(DEFAULT_PERMISSION_SCOPE, userId, roleIds);
    }

    /** 覆盖写入 scope 内某个用户的角色列表。 */
    async setScopedUserRoles(scope: PermissionScope, userId: string, roleIds: string[]): Promise<void> {
        await this.withStorageError(`set user roles '${userId}'`, async () => {
            const documentId = this.getDocumentId(scope, userId);
            await this.userRolesCollection.replaceOne(
                { _id: documentId },
                { _id: documentId, ...this.getScopeFields(scope), userId, roleIds: structuredClone(roleIds) },
                { upsert: true },
            );
        });
    }

    /** 获取某个角色直接绑定的用户列表。 */
    async getUsersByRole(roleId: string): Promise<string[]> {
        return this.getScopedUsersByRole(DEFAULT_PERMISSION_SCOPE, roleId);
    }

    /** 获取 scope 内某个角色直接绑定的用户列表。 */
    async getScopedUsersByRole(scope: PermissionScope, roleId: string): Promise<string[]> {
        return this.withStorageError(`get users by role '${roleId}'`, async () => {
            const docs = await this.userRolesCollection.find({ scopeKey: getPermissionScopeKey(scope), roleIds: roleId });
            return docs.map((doc) => doc.userId);
        });
    }

    /** 获取某个角色的规则集合。 */
    async getRules(roleId: string): Promise<PermissionRule[]> {
        return this.getScopedRules(DEFAULT_PERMISSION_SCOPE, roleId);
    }

    /** 获取 scope 内某个角色的规则集合。 */
    async getScopedRules(scope: PermissionScope, roleId: string): Promise<PermissionRule[]> {
        return this.withStorageError(`get rules '${roleId}'`, async () => {
            const doc = await this.rulesCollection.findOne({ _id: this.getDocumentId(scope, roleId) });
            return structuredClone(doc?.rules ?? []);
        });
    }

    /** 覆盖写入某个角色的规则集合。 */
    async setRules(roleId: string, rules: PermissionRule[]): Promise<void> {
        await this.setScopedRules(DEFAULT_PERMISSION_SCOPE, roleId, rules);
    }

    /** 覆盖写入 scope 内某个角色的规则集合。 */
    async setScopedRules(scope: PermissionScope, roleId: string, rules: PermissionRule[]): Promise<void> {
        await this.withStorageError(`set rules '${roleId}'`, async () => {
            const documentId = this.getDocumentId(scope, roleId);
            await this.rulesCollection.replaceOne(
                { _id: documentId },
                { _id: documentId, ...this.getScopeFields(scope), roleId, rules: structuredClone(rules) },
                { upsert: true },
            );
        });
    }

    /** 删除某个角色的规则集合。 */
    async deleteRules(roleId: string): Promise<void> {
        await this.deleteScopedRules(DEFAULT_PERMISSION_SCOPE, roleId);
    }

    /** 删除 scope 内某个角色的规则集合。 */
    async deleteScopedRules(scope: PermissionScope, roleId: string): Promise<void> {
        await this.withStorageError(`delete rules '${roleId}'`, async () => {
            await this.rulesCollection.deleteOne({ _id: this.getDocumentId(scope, roleId) });
        });
    }

    /**
     * 统一包装底层存储异常。
     */
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

    /**
     * 去掉数据库文档里的 `_id` 字段。
     */
    private stripRoleDocument(doc: RoleDocument): RoleData {
        const {
            _id: _ignored,
            scopeKey: _scopeKey,
            tenantId: _tenantId,
            appId: _appId,
            moduleId: _moduleId,
            namespace: _namespace,
            ...rest
        } = doc;
        return structuredClone(rest);
    }

    private getDocumentId(scope: PermissionScope, id: string) {
        return `${getPermissionScopeKey(scope)}::${id}`;
    }

    private getScopeFields(scope: PermissionScope): ScopeDocumentFields {
        const normalized = normalizePermissionScope(scope);
        return {
            scopeKey: getPermissionScopeKey(normalized),
            tenantId: normalized.tenantId,
            ...(normalized.appId ? { appId: normalized.appId } : {}),
            ...(normalized.moduleId ? { moduleId: normalized.moduleId } : {}),
            ...(normalized.namespace ? { namespace: normalized.namespace } : {}),
        };
    }
}
