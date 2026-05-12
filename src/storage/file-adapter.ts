import * as fs from "node:fs/promises";
import * as path from "node:path";

import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode, type PermissionRule, type RoleData } from "../types";

import { StorageAdapter } from "./adapter";

export interface FileAdapterOptions {
    path?: string;
}

interface FileData {
    roles: Record<string, RoleData>;
    userRoles: Record<string, string[]>;
    rules: Record<string, PermissionRule[]>;
}

function createEmptyFileData(): FileData {
    return {
        roles: {},
        userRoles: {},
        rules: {},
    };
}

// FileAdapter 用于单机演示和本地回退场景，重点是稳定而不是并发吞吐。
export class FileAdapter extends StorageAdapter {
    private readonly filePath: string;
    private data: FileData = createEmptyFileData();
    private roleUsers = new Map<string, Set<string>>();
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private writeInFlight: Promise<void> | null = null;
    private pendingWrite = false;
    private lastWriteError: PermissionCoreError | null = null;

    constructor(options: FileAdapterOptions = {}) {
        super();
        this.filePath = options.path ?? "./permission-core-data.json";
    }

    async init(): Promise<void> {
        try {
            const raw = await fs.readFile(this.filePath, "utf-8");
            const parsed = JSON.parse(raw) as Partial<FileData>;
            this.data = {
                roles: parsed.roles ?? {},
                userRoles: parsed.userRoles ?? {},
                rules: parsed.rules ?? {},
            };
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code === "ENOENT") {
                // 首次启动时文件不存在属于正常路径，直接以内存空数据启动。
                this.data = createEmptyFileData();
            } else if (error instanceof SyntaxError) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.STORAGE_ERROR,
                    `Failed to parse ${this.filePath}`,
                    error,
                );
            } else {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.STORAGE_ERROR,
                    `Failed to read ${this.filePath}`,
                    error,
                );
            }
        }

        this.rebuildRoleUsers();
        this.lastWriteError = null;
    }

    async close(): Promise<void> {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        await this.writeToDisk();
        if (this.writeInFlight) {
            await this.writeInFlight;
        }
        this.throwIfWriteFailed();
    }

    async getRoles(): Promise<Map<string, RoleData>> {
        this.throwIfWriteFailed();
        return new Map(
            Object.entries(this.data.roles).map(([roleId, roleData]) => [roleId, structuredClone(roleData)]),
        );
    }

    async getRole(id: string): Promise<RoleData | null> {
        this.throwIfWriteFailed();
        const role = this.data.roles[id];
        return role ? structuredClone(role) : null;
    }

    async setRole(id: string, roleData: RoleData): Promise<void> {
        this.throwIfWriteFailed();
        this.data.roles[id] = structuredClone(roleData);
        this.scheduleWrite();
    }

    async deleteRole(id: string): Promise<void> {
        this.throwIfWriteFailed();
        delete this.data.roles[id];
        delete this.data.rules[id];
        this.roleUsers.delete(id);
        this.scheduleWrite();
    }

    async getUserRoles(userId: string): Promise<string[]> {
        this.throwIfWriteFailed();
        return structuredClone(this.data.userRoles[userId] ?? []);
    }

    async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
        this.throwIfWriteFailed();
        const uniqueRoleIds = Array.from(new Set(roleIds));
        this.updateRoleUsersIndex(userId, uniqueRoleIds);
        this.data.userRoles[userId] = structuredClone(uniqueRoleIds);
        this.scheduleWrite();
    }

    async getUsersByRole(roleId: string): Promise<string[]> {
        this.throwIfWriteFailed();
        return Array.from(this.roleUsers.get(roleId) ?? []);
    }

    async getRules(roleId: string): Promise<PermissionRule[]> {
        this.throwIfWriteFailed();
        return structuredClone(this.data.rules[roleId] ?? []);
    }

    async setRules(roleId: string, rules: PermissionRule[]): Promise<void> {
        this.throwIfWriteFailed();
        this.data.rules[roleId] = structuredClone(rules);
        this.scheduleWrite();
    }

    async deleteRules(roleId: string): Promise<void> {
        this.throwIfWriteFailed();
        delete this.data.rules[roleId];
        this.scheduleWrite();
    }

    private rebuildRoleUsers() {
        this.roleUsers = new Map();
        for (const [userId, roleIds] of Object.entries(this.data.userRoles)) {
            for (const roleId of roleIds) {
                if (!this.roleUsers.has(roleId)) {
                    this.roleUsers.set(roleId, new Set());
                }

                this.roleUsers.get(roleId)?.add(userId);
            }
        }
    }

    private updateRoleUsersIndex(userId: string, newRoleIds: string[]) {
        // 反向索引用于快速找“某角色绑定了哪些用户”，删除角色时会直接复用。
        const oldRoleIds = this.data.userRoles[userId] ?? [];
        const removedRoleIds = oldRoleIds.filter((roleId) => !newRoleIds.includes(roleId));
        const addedRoleIds = newRoleIds.filter((roleId) => !oldRoleIds.includes(roleId));

        for (const roleId of removedRoleIds) {
            this.roleUsers.get(roleId)?.delete(userId);
            if (this.roleUsers.get(roleId)?.size === 0) {
                this.roleUsers.delete(roleId);
            }
        }

        for (const roleId of addedRoleIds) {
            if (!this.roleUsers.has(roleId)) {
                this.roleUsers.set(roleId, new Set());
            }

            this.roleUsers.get(roleId)?.add(userId);
        }
    }

    private scheduleWrite() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // 高频写入时只保留最后一次刷盘，避免角色/规则批量更新造成抖动写盘。
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.writeToDisk();
        }, 100);
    }

    private async writeToDisk(): Promise<void> {
        if (this.writeInFlight) {
            // 正在写盘时只登记“还有变更”，待当前写完后再补一次最终状态。
            this.pendingWrite = true;
            return this.writeInFlight;
        }

        this.pendingWrite = false;
        this.writeInFlight = (async () => {
            try {
                await fs.mkdir(path.dirname(this.filePath), { recursive: true });
                const json = JSON.stringify(this.data, null, 2);
                await fs.writeFile(this.filePath, json, "utf-8");
                this.lastWriteError = null;
            } catch (error) {
                this.lastWriteError = new PermissionCoreError(
                    PermissionCoreErrorCode.STORAGE_ERROR,
                    `Failed to write ${this.filePath}`,
                    error,
                );
                throw this.lastWriteError;
            }
        })();

        try {
            await this.writeInFlight;
        } finally {
            this.writeInFlight = null;
            if (this.pendingWrite) {
                // 把写盘期间累积的新状态再刷一遍，避免 debounce 与并发写交错丢数据。
                this.pendingWrite = false;
                await this.writeToDisk();
            }
        }
    }

    private throwIfWriteFailed() {
        if (this.lastWriteError) {
            throw this.lastWriteError;
        }
    }
}