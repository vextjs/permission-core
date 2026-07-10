import { PermissionCoreError } from "../core/errors";
import { getPermissionScopeKey, normalizePermissionScope } from "../scope";
import type { MonSQLizeCollectionSource } from "../storage";
import { PermissionCoreErrorCode, type PermissionScope } from "../types";

import type {
    ApiBinding,
    ImportSummary,
    MenuNode,
    MenuPermissionStorageAdapter,
    PermissionAuditEntry,
} from "./types";

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

export interface MonSQLizeMenuStorageAdapterOptions {
    msq: MonSQLizeCollectionSource;
    namespace?: string;
    ownsConnection?: boolean;
}

interface ScopeFields {
    scopeKey: string;
    tenantId: string;
    appId?: string;
    moduleId?: string;
    namespace?: string;
}

interface AssetDocument<T> extends ScopeFields {
    _id: string;
    assetId: string;
    value: T;
}

interface RevisionDocument extends ScopeFields {
    _id: string;
    revision: number;
}

interface AuditDocument extends ScopeFields {
    _id: string;
    createdAt: number;
    value: PermissionAuditEntry;
}

function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

function createSummary<T extends { id: string }>(
    current: Map<string, T>,
    values: T[],
    replace: boolean,
    revision: number,
): ImportSummary {
    const insertedIds: string[] = [];
    const updatedIds: string[] = [];
    let unchanged = 0;
    for (const value of values) {
        const existing = current.get(value.id);
        if (!existing) {
            insertedIds.push(value.id);
        } else if (JSON.stringify(existing) === JSON.stringify(value)) {
            unchanged += 1;
        } else {
            updatedIds.push(value.id);
        }
    }

    const nextIds = new Set(values.map((value) => value.id));
    const deletedIds = replace
        ? Array.from(current.keys()).filter((id) => !nextIds.has(id)).sort()
        : [];
    return {
        inserted: insertedIds.length,
        updated: updatedIds.length,
        unchanged,
        deleted: deletedIds.length,
        revision,
        changes: {
            insertedIds: insertedIds.sort(),
            updatedIds: updatedIds.sort(),
            deletedIds,
        },
    };
}

/**
 * MonSQLize-backed menu asset, revision and audit persistence.
 */
export class MonSQLizeMenuStorageAdapter implements MenuPermissionStorageAdapter {
    private readonly msq: MonSQLizeWithCollections;
    private readonly namespace: string;
    private readonly ownsConnection: boolean;
    private initialized = false;
    private mutationQueue: Promise<void> = Promise.resolve();

    private nodesCollection!: CollectionLike<AssetDocument<MenuNode>>;
    private apiBindingsCollection!: CollectionLike<AssetDocument<ApiBinding>>;
    private revisionsCollection!: CollectionLike<RevisionDocument>;
    private auditsCollection!: CollectionLike<AuditDocument>;

    constructor(options: MonSQLizeMenuStorageAdapterOptions) {
        this.msq = options.msq as unknown as MonSQLizeWithCollections;
        this.namespace = options.namespace ?? "permission_core";
        this.ownsConnection = options.ownsConnection ?? false;
    }

    async init(): Promise<void> {
        if (this.initialized) {
            return;
        }
        try {
            this.nodesCollection = this.msq.collection(`${this.namespace}_menu_nodes`);
            this.apiBindingsCollection = this.msq.collection(`${this.namespace}_api_bindings`);
            this.revisionsCollection = this.msq.collection(`${this.namespace}_menu_revisions`);
            this.auditsCollection = this.msq.collection(`${this.namespace}_permission_audits`);
            await Promise.all([
                this.nodesCollection.createIndex({ _id: 1 }, { unique: true }),
                this.nodesCollection.createIndex({ scopeKey: 1, assetId: 1 }, { unique: true }),
                this.apiBindingsCollection.createIndex({ _id: 1 }, { unique: true }),
                this.apiBindingsCollection.createIndex({ scopeKey: 1, assetId: 1 }, { unique: true }),
                this.apiBindingsCollection.createIndex({ scopeKey: 1, "value.ownerId": 1 }),
                this.revisionsCollection.createIndex({ _id: 1 }, { unique: true }),
                this.auditsCollection.createIndex({ _id: 1 }, { unique: true }),
                this.auditsCollection.createIndex({ scopeKey: 1, createdAt: -1 }),
            ]);
            this.initialized = true;
        } catch (error) {
            throw this.storageError("initialize menu collections", error);
        }
    }

    async close(): Promise<void> {
        await this.mutationQueue;
        if (this.ownsConnection && typeof this.msq.close === "function") {
            try {
                await this.msq.close();
            } catch (error) {
                throw this.storageError("close menu storage connection", error);
            }
        }
    }

    async listMenuNodes(scope: PermissionScope): Promise<MenuNode[]> {
        await this.mutationQueue;
        return this.listAssets(this.nodesCollection, scope);
    }

    async upsertMenuNodes(scope: PermissionScope, nodes: MenuNode[]): Promise<ImportSummary> {
        return this.mutateAssets(this.nodesCollection, scope, nodes, false);
    }

    async replaceMenuNodes(scope: PermissionScope, nodes: MenuNode[]): Promise<ImportSummary> {
        return this.mutateAssets(this.nodesCollection, scope, nodes, true);
    }

    async listApiBindings(scope: PermissionScope): Promise<ApiBinding[]> {
        await this.mutationQueue;
        return this.listAssets(this.apiBindingsCollection, scope);
    }

    async upsertApiBindings(scope: PermissionScope, bindings: ApiBinding[]): Promise<ImportSummary> {
        return this.mutateAssets(this.apiBindingsCollection, scope, bindings, false);
    }

    async replaceApiBindings(scope: PermissionScope, bindings: ApiBinding[]): Promise<ImportSummary> {
        return this.mutateAssets(this.apiBindingsCollection, scope, bindings, true);
    }

    async getRevision(scope: PermissionScope): Promise<number> {
        await this.mutationQueue;
        return this.readRevision(scope);
    }

    private async readRevision(scope: PermissionScope): Promise<number> {
        this.assertInitialized();
        try {
            const document = await this.revisionsCollection.findOne({ _id: this.getRevisionId(scope) });
            return document?.revision ?? 0;
        } catch (error) {
            throw this.storageError("read menu revision", error);
        }
    }

    async listAuditEntries(scope: PermissionScope): Promise<PermissionAuditEntry[]> {
        await this.mutationQueue;
        this.assertInitialized();
        try {
            const documents = await this.auditsCollection.find({ scopeKey: getPermissionScopeKey(scope) });
            return documents
                .sort((left, right) => left.createdAt - right.createdAt || left._id.localeCompare(right._id))
                .map((document) => cloneValue(document.value));
        } catch (error) {
            throw this.storageError("list permission audits", error);
        }
    }

    async appendAuditEntries(scope: PermissionScope, entries: PermissionAuditEntry[]): Promise<void> {
        this.assertInitialized();
        return this.enqueueMutation(async () => {
            try {
            const scopeFields = this.getScopeFields(scope);
            for (const entry of entries) {
                const document: AuditDocument = {
                    _id: this.getDocumentId(scope, entry.id),
                    ...scopeFields,
                    createdAt: entry.createdAt,
                    value: cloneValue(entry),
                };
                await this.auditsCollection.replaceOne({ _id: document._id }, document, { upsert: true });
            }
        } catch (error) {
            throw this.storageError("append permission audits", error);
            }
        });
    }

    private async listAssets<T>(collection: CollectionLike<AssetDocument<T>>, scope: PermissionScope): Promise<T[]> {
        this.assertInitialized();
        try {
            const documents = await collection.find({ scopeKey: getPermissionScopeKey(scope) });
            return documents.map((document) => cloneValue(document.value));
        } catch (error) {
            throw this.storageError("list menu assets", error);
        }
    }

    private async mutateAssets<T extends { id: string }>(
        collection: CollectionLike<AssetDocument<T>>,
        scope: PermissionScope,
        values: T[],
        replace: boolean,
    ): Promise<ImportSummary> {
        this.assertInitialized();
        return this.enqueueMutation(async () => {
            try {
            const currentValues = await this.listAssets(collection, scope);
            const current = new Map(currentValues.map((value) => [value.id, value]));
            const currentRevision = await this.readRevision(scope);
            const summary = createSummary(current, values, replace, currentRevision + 1);
            if (summary.inserted + summary.updated + summary.deleted === 0) {
                return { ...summary, revision: currentRevision };
            }

            for (const id of summary.changes.deletedIds) {
                await collection.deleteOne({ _id: this.getDocumentId(scope, id) });
            }
            const scopeFields = this.getScopeFields(scope);
            for (const value of values) {
                if (!summary.changes.insertedIds.includes(value.id) && !summary.changes.updatedIds.includes(value.id)) {
                    continue;
                }
                const document: AssetDocument<T> = {
                    _id: this.getDocumentId(scope, value.id),
                    ...scopeFields,
                    assetId: value.id,
                    value: cloneValue(value),
                };
                await collection.replaceOne({ _id: document._id }, document, { upsert: true });
            }
            await this.writeRevision(scope, summary.revision);
            return summary;
        } catch (error) {
            if (error instanceof PermissionCoreError) {
                throw error;
            }
            throw this.storageError("mutate menu assets", error);
            }
        });
    }

    private enqueueMutation<T>(action: () => Promise<T>): Promise<T> {
        const run = this.mutationQueue.then(action);
        this.mutationQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async writeRevision(scope: PermissionScope, revision: number) {
        const document: RevisionDocument = {
            _id: this.getRevisionId(scope),
            ...this.getScopeFields(scope),
            revision,
        };
        await this.revisionsCollection.replaceOne({ _id: document._id }, document, { upsert: true });
    }

    private getDocumentId(scope: PermissionScope, id: string) {
        return `${getPermissionScopeKey(scope)}::${id}`;
    }

    private getRevisionId(scope: PermissionScope) {
        return `${getPermissionScopeKey(scope)}::revision`;
    }

    private getScopeFields(scope: PermissionScope): ScopeFields {
        const normalized = normalizePermissionScope(scope);
        return {
            scopeKey: getPermissionScopeKey(normalized),
            tenantId: normalized.tenantId,
            ...(normalized.appId ? { appId: normalized.appId } : {}),
            ...(normalized.moduleId ? { moduleId: normalized.moduleId } : {}),
            ...(normalized.namespace ? { namespace: normalized.namespace } : {}),
        };
    }

    private assertInitialized() {
        if (!this.initialized) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.NOT_INITIALIZED,
                "MonSQLizeMenuStorageAdapter has not been initialized",
            );
        }
    }

    private storageError(operation: string, error: unknown) {
        return new PermissionCoreError(
            PermissionCoreErrorCode.STORAGE_ERROR,
            `Failed to ${operation} for namespace '${this.namespace}'`,
            error,
        );
    }
}
