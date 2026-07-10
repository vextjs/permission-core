import * as fs from "node:fs/promises";
import * as path from "node:path";

import { PermissionCoreError } from "../core/errors";
import { getPermissionScopeKey } from "../scope";
import { PermissionCoreErrorCode, type PermissionScope } from "../types";

import type {
    ApiBinding,
    ImportSummary,
    MenuNode,
    MenuPermissionStorageAdapter,
    PermissionAuditEntry,
} from "./types";

export interface FileMenuStorageAdapterOptions {
    /** Menu asset and audit JSON file. */
    path?: string;
}

interface FileMenuScopeData {
    nodes: Record<string, MenuNode>;
    apiBindings: Record<string, ApiBinding>;
    audits: PermissionAuditEntry[];
    revision: number;
}

interface FileMenuData {
    schemaVersion: 1;
    scopes: Record<string, FileMenuScopeData>;
}

function createEmptyData(): FileMenuData {
    return { schemaVersion: 1, scopes: {} };
}

function createEmptyScopeData(): FileMenuScopeData {
    return { nodes: {}, apiBindings: {}, audits: [], revision: 0 };
}

function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

function summarize<T extends { id: string }>(
    current: Record<string, T>,
    values: T[],
    revision: number,
    replace: boolean,
): { next: Record<string, T>; summary: ImportSummary } {
    const next = replace ? {} as Record<string, T> : cloneValue(current);
    const insertedIds: string[] = [];
    const updatedIds: string[] = [];
    let unchanged = 0;

    for (const value of values) {
        const existing = current[value.id];
        if (!existing) {
            insertedIds.push(value.id);
        } else if (JSON.stringify(existing) === JSON.stringify(value)) {
            unchanged += 1;
        } else {
            updatedIds.push(value.id);
        }
        next[value.id] = cloneValue(value);
    }

    const nextIds = new Set(values.map((value) => value.id));
    const deletedIds = replace
        ? Object.keys(current).filter((id) => !nextIds.has(id)).sort()
        : [];

    return {
        next,
        summary: {
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
        },
    };
}

/**
 * Scope-aware JSON persistence for menu assets and permission audit entries.
 */
export class FileMenuStorageAdapter implements MenuPermissionStorageAdapter {
    private readonly filePath: string;
    private data: FileMenuData = createEmptyData();
    private initialized = false;
    private mutationQueue: Promise<void> = Promise.resolve();
    private writeCounter = 0;

    constructor(options: FileMenuStorageAdapterOptions = {}) {
        this.filePath = options.path ?? "./permission-core-menu-data.json";
    }

    async init(): Promise<void> {
        if (this.initialized) {
            return;
        }

        try {
            const raw = await fs.readFile(this.filePath, "utf-8");
            const parsed = JSON.parse(raw) as Partial<FileMenuData>;
            if (parsed.schemaVersion !== 1 || typeof parsed.scopes !== "object" || parsed.scopes === null) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.STORAGE_ERROR,
                    `Unsupported menu storage schema in ${this.filePath}`,
                );
            }
            this.data = { schemaVersion: 1, scopes: cloneValue(parsed.scopes) };
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code === "ENOENT") {
                this.data = createEmptyData();
            } else if (error instanceof PermissionCoreError) {
                throw error;
            } else {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.STORAGE_ERROR,
                    `Failed to initialize menu storage from ${this.filePath}`,
                    error,
                );
            }
        }

        this.initialized = true;
    }

    async close(): Promise<void> {
        await this.mutationQueue;
    }

    async listMenuNodes(scope: PermissionScope): Promise<MenuNode[]> {
        await this.waitUntilReadable();
        return Object.values(this.getScopeData(scope).nodes).map(cloneValue);
    }

    async upsertMenuNodes(scope: PermissionScope, nodes: MenuNode[]): Promise<ImportSummary> {
        return this.mutateAssets(scope, "nodes", nodes, false);
    }

    async replaceMenuNodes(scope: PermissionScope, nodes: MenuNode[]): Promise<ImportSummary> {
        return this.mutateAssets(scope, "nodes", nodes, true);
    }

    async listApiBindings(scope: PermissionScope): Promise<ApiBinding[]> {
        await this.waitUntilReadable();
        return Object.values(this.getScopeData(scope).apiBindings).map(cloneValue);
    }

    async upsertApiBindings(scope: PermissionScope, bindings: ApiBinding[]): Promise<ImportSummary> {
        return this.mutateAssets(scope, "apiBindings", bindings, false);
    }

    async replaceApiBindings(scope: PermissionScope, bindings: ApiBinding[]): Promise<ImportSummary> {
        return this.mutateAssets(scope, "apiBindings", bindings, true);
    }

    async getRevision(scope: PermissionScope): Promise<number> {
        await this.waitUntilReadable();
        return this.getScopeData(scope).revision;
    }

    async listAuditEntries(scope: PermissionScope): Promise<PermissionAuditEntry[]> {
        await this.waitUntilReadable();
        return this.getScopeData(scope).audits.map(cloneValue);
    }

    async appendAuditEntries(scope: PermissionScope, entries: PermissionAuditEntry[]): Promise<void> {
        await this.enqueueMutation(async () => {
            const scopeKey = getPermissionScopeKey(scope);
            const before = cloneValue(this.getScopeData(scope));
            this.getScopeData(scope).audits.push(...entries.map(cloneValue));
            try {
                await this.persist();
            } catch (error) {
                this.data.scopes[scopeKey] = before;
                throw error;
            }
        });
    }

    private async mutateAssets<T extends MenuNode[] | ApiBinding[]>(
        scope: PermissionScope,
        field: "nodes" | "apiBindings",
        values: T,
        replace: boolean,
    ): Promise<ImportSummary> {
        let result!: ImportSummary;
        await this.enqueueMutation(async () => {
            const scopeKey = getPermissionScopeKey(scope);
            const scopeData = this.getScopeData(scope);
            const before = cloneValue(scopeData);
            const nextRevision = scopeData.revision + 1;
            const mutation = summarize(scopeData[field] as Record<string, T[number]>, values, nextRevision, replace);
            const changed = mutation.summary.inserted + mutation.summary.updated + mutation.summary.deleted > 0;
            if (!changed) {
                result = { ...mutation.summary, revision: scopeData.revision };
                return;
            }

            (scopeData[field] as Record<string, T[number]>) = mutation.next;
            scopeData.revision = nextRevision;
            try {
                await this.persist();
                result = mutation.summary;
            } catch (error) {
                this.data.scopes[scopeKey] = before;
                throw error;
            }
        });
        return result;
    }

    private async waitUntilReadable() {
        this.assertInitialized();
        await this.mutationQueue;
    }

    private async enqueueMutation(action: () => Promise<void>) {
        this.assertInitialized();
        const run = this.mutationQueue.then(action);
        this.mutationQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async persist() {
        const snapshot = JSON.stringify(this.data, null, 2);
        const tempPath = `${this.filePath}.${process.pid}.${this.writeCounter += 1}.tmp`;
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(tempPath, snapshot, "utf-8");
            await fs.rename(tempPath, this.filePath);
        } catch (error) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.STORAGE_ERROR,
                `Failed to persist menu storage to ${this.filePath}`,
                error,
            );
        }
    }

    private assertInitialized() {
        if (!this.initialized) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.NOT_INITIALIZED,
                "FileMenuStorageAdapter has not been initialized",
            );
        }
    }

    private getScopeData(scope: PermissionScope) {
        const scopeKey = getPermissionScopeKey(scope);
        this.data.scopes[scopeKey] ??= createEmptyScopeData();
        return this.data.scopes[scopeKey];
    }
}
