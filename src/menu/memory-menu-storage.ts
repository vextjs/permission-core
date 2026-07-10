import type { ApiBinding, ImportSummary, MenuNode, MenuPermissionStorageAdapter, PermissionAuditEntry } from "./types";
import type { PermissionScope } from "../types";
import { getPermissionScopeKey } from "../scope";

function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

function summarizeUpsert<T extends { id: string }>(
    target: Map<string, T>,
    values: T[],
    revision: number,
): ImportSummary {
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const insertedIds: string[] = [];
    const updatedIds: string[] = [];

    for (const value of values) {
        const current = target.get(value.id);
        if (!current) {
            inserted += 1;
            insertedIds.push(value.id);
            target.set(value.id, cloneValue(value));
            continue;
        }

        if (JSON.stringify(current) === JSON.stringify(value)) {
            unchanged += 1;
            continue;
        }

        updated += 1;
        updatedIds.push(value.id);
        target.set(value.id, cloneValue(value));
    }

    return {
        inserted,
        updated,
        unchanged,
        deleted: 0,
        revision,
        changes: { insertedIds: insertedIds.sort(), updatedIds: updatedIds.sort(), deletedIds: [] },
    };
}

function summarizeReplace<T extends { id: string }>(
    target: Map<string, T>,
    values: T[],
    revision: number,
): ImportSummary {
    const nextIds = new Set(values.map((value) => value.id));
    const deletedIds = Array.from(target.keys()).filter((id) => !nextIds.has(id)).sort();
    const upsert = summarizeUpsert(target, values, revision);
    for (const id of deletedIds) {
        target.delete(id);
    }

    return {
        ...upsert,
        deleted: deletedIds.length,
        changes: { ...upsert.changes, deletedIds },
    };
}

/**
 * 纯内存菜单存储，适合测试、示例和最小接入。
 */
export class MemoryMenuStorageAdapter implements MenuPermissionStorageAdapter {
    private readonly menuNodes = new Map<string, Map<string, MenuNode>>();
    private readonly apiBindings = new Map<string, Map<string, ApiBinding>>();
    private readonly auditEntries = new Map<string, PermissionAuditEntry[]>();
    private readonly revisions = new Map<string, number>();

    async init(): Promise<void> { }

    async close(): Promise<void> { }

    async listMenuNodes(scope: PermissionScope): Promise<MenuNode[]> {
        const scopedNodes = this.getMenuNodeMap(scope);
        return Array.from(scopedNodes.values()).map(cloneValue);
    }

    async upsertMenuNodes(scope: PermissionScope, nodes: MenuNode[]): Promise<ImportSummary> {
        return this.mutate(scope, (revision) => summarizeUpsert(this.getMenuNodeMap(scope), nodes, revision));
    }

    async replaceMenuNodes(scope: PermissionScope, nodes: MenuNode[]): Promise<ImportSummary> {
        return this.mutate(scope, (revision) => summarizeReplace(this.getMenuNodeMap(scope), nodes, revision));
    }

    async listApiBindings(scope: PermissionScope): Promise<ApiBinding[]> {
        const scopedBindings = this.getApiBindingMap(scope);
        return Array.from(scopedBindings.values()).map(cloneValue);
    }

    async upsertApiBindings(scope: PermissionScope, bindings: ApiBinding[]): Promise<ImportSummary> {
        return this.mutate(scope, (revision) => summarizeUpsert(this.getApiBindingMap(scope), bindings, revision));
    }

    async replaceApiBindings(scope: PermissionScope, bindings: ApiBinding[]): Promise<ImportSummary> {
        return this.mutate(scope, (revision) => summarizeReplace(this.getApiBindingMap(scope), bindings, revision));
    }

    async getRevision(scope: PermissionScope): Promise<number> {
        return this.revisions.get(getPermissionScopeKey(scope)) ?? 0;
    }

    async listAuditEntries(scope: PermissionScope): Promise<PermissionAuditEntry[]> {
        return (this.auditEntries.get(getPermissionScopeKey(scope)) ?? []).map(cloneValue);
    }

    async appendAuditEntries(scope: PermissionScope, entries: PermissionAuditEntry[]): Promise<void> {
        const scopeKey = getPermissionScopeKey(scope);
        const current = this.auditEntries.get(scopeKey) ?? [];
        this.auditEntries.set(scopeKey, [...current, ...entries.map(cloneValue)]);
    }

    private getMenuNodeMap(scope: PermissionScope) {
        const scopeKey = getPermissionScopeKey(scope);
        if (!this.menuNodes.has(scopeKey)) {
            this.menuNodes.set(scopeKey, new Map());
        }

        return this.menuNodes.get(scopeKey) as Map<string, MenuNode>;
    }

    private getApiBindingMap(scope: PermissionScope) {
        const scopeKey = getPermissionScopeKey(scope);
        if (!this.apiBindings.has(scopeKey)) {
            this.apiBindings.set(scopeKey, new Map());
        }

        return this.apiBindings.get(scopeKey) as Map<string, ApiBinding>;
    }

    private mutate(scope: PermissionScope, action: (revision: number) => ImportSummary) {
        const scopeKey = getPermissionScopeKey(scope);
        const nextRevision = (this.revisions.get(scopeKey) ?? 0) + 1;
        const summary = action(nextRevision);
        const changed = summary.inserted + summary.updated + summary.deleted > 0;
        if (changed) {
            this.revisions.set(scopeKey, nextRevision);
            return summary;
        }

        return { ...summary, revision: nextRevision - 1 };
    }
}
