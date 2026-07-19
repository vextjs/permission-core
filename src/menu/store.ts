import type { MongoSession } from "monsqlize";
import type { PermissionScope } from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalByteLength, compareUtf8 } from "../internal/canonical";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import { mapDatabaseReadError, type PermissionRepository } from "../persistence/repository";
import type { ScopeStateView } from "../persistence/scope-state";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
    InternalRoleMenuGrantDocument,
} from "../persistence/documents";
import { normalizeRbacId } from "../rbac/validation";
import {
    apiBindingManifestItemFromDocument,
    materializeApiBindingDocument,
    materializeMenuNodeDocument,
    materializeRoleMenuGrantDocument,
    menuNodeManifestItemFromDocument,
} from "./materialize";

export const MAX_MENU_NODES = 10_000;
export const MAX_API_BINDINGS = 20_000;
export const MAX_MENU_TREE_NODES = 5_000;
export const MAX_MENU_DEPTH = 64;
export const MAX_ROLE_MENU_GRANTS = 20_000;
export const MAX_EFFECTIVE_ROLE_MENU_GRANTS = 50_000;
const READ_PAGE_SIZE = 200;

function readOptions(session?: MongoSession) {
    return {
        cache: 0,
        collation: SIMPLE_COLLATION,
        ...(session === undefined ? {} : { session }),
    };
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted menu state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function readConflict(expected: number, current: number): never {
    throw new PermissionCoreError("READ_CONFLICT", "Menu state changed during the read.", {
        details: { kind: "read-conflict", owner: "scope.menu", expected, current },
    });
}

export class MenuScopeReader {
    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        readonly state: ScopeStateView,
        private readonly session?: MongoSession,
    ) {}

    private pageSize(preferred = READ_PAGE_SIZE) {
        return Math.min(preferred, this.repository.findMaxLimit);
    }

    private assertScopeStateForRows(rowCount: number) {
        if (!this.state.persisted && rowCount > 0) {
            persistedInvalid("menu documents exist without their owning scope state");
        }
    }

    async verifyMenuUnchanged() {
        const current = await this.repository.scopeStates.read(this.state.scope, this.session);
        if (current.menuRevision !== this.state.menuRevision || current.revision !== this.state.revision) {
            readConflict(this.state.menuRevision, current.menuRevision);
        }
    }

    async verifyMenuAuthorizationUnchanged() {
        const current = await this.repository.scopeStates.read(this.state.scope, this.session);
        if (
            current.menuRevision !== this.state.menuRevision
            || current.rbacRevision !== this.state.rbacRevision
            || current.revision !== this.state.revision
        ) {
            readConflict(this.state.revision, current.revision);
        }
    }

    async readGrant(roleIdInput: unknown, grantIdInput: unknown): Promise<Readonly<InternalRoleMenuGrantDocument> | null> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const grantId = normalizeRbacId(grantIdInput, "grantId");
        try {
            const raw = await this.repository.collections.roleMenuGrants.findOne(
                { scopeKey: this.state.scopeKey, roleId, grantId },
                readOptions(this.session),
            );
            this.assertScopeStateForRows(raw === null ? 0 : 1);
            return raw === null ? null : materializeRoleMenuGrantDocument(raw, this.state.scope, this.state.scopeKey);
        } catch (error) {
            throw mapDatabaseReadError("The role menu grant read failed.", error);
        }
    }

    async readGrantsForRole(roleIdInput: unknown) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const result: Readonly<InternalRoleMenuGrantDocument>[] = [];
        let after: string | undefined;
        const pageSize = this.pageSize();
        try {
            while (result.length <= MAX_ROLE_MENU_GRANTS) {
                const base = { scopeKey: this.state.scopeKey, roleId };
                const filter = after === undefined ? base : { ...base, grantId: { $gt: after } };
                const rows = await this.repository.collections.roleMenuGrants.find(filter, readOptions(this.session))
                    .sort({ grantId: 1 })
                    .limit(pageSize)
                    .toArray();
                if (rows.length > pageSize) persistedInvalid("role menu grant page exceeds the host query budget");
                this.assertScopeStateForRows(rows.length);
                if (rows.length === 0) break;
                for (const row of rows) {
                    const grant = materializeRoleMenuGrantDocument(row, this.state.scope, this.state.scopeKey);
                    if (grant.roleId !== roleId) persistedInvalid("role menu grant query returned a different role");
                    if (after !== undefined && compareUtf8(grant.grantId, after) <= 0) persistedInvalid("role menu grant keyset did not advance");
                    after = grant.grantId;
                    result.push(grant);
                    if (result.length > MAX_ROLE_MENU_GRANTS) persistedInvalid("role menu grant inventory exceeds its role limit");
                }
                if (rows.length < pageSize) break;
            }
            return Object.freeze(result);
        } catch (error) {
            throw mapDatabaseReadError("The role menu grant inventory read failed.", error);
        }
    }

    async readGrantsForRoles(roleIdInputs: readonly unknown[]) {
        const roleIds = [...new Set(roleIdInputs.map((value) => normalizeRbacId(value, "roleIds")))]
            .sort(compareUtf8);
        if (roleIds.length === 0) {
            return Object.freeze([]) as readonly Readonly<InternalRoleMenuGrantDocument>[];
        }
        const expected = new Set(roleIds);
        const perRole = new Map<string, number>();
        const result: Readonly<InternalRoleMenuGrantDocument>[] = [];
        let after: { roleId: string; grantId: string } | undefined;
        const pageSize = this.pageSize();
        try {
            while (result.length <= MAX_EFFECTIVE_ROLE_MENU_GRANTS) {
                const base = { scopeKey: this.state.scopeKey, roleId: { $in: roleIds } };
                const filter = after === undefined
                    ? base
                    : {
                        $and: [
                            base,
                            {
                                $or: [
                                    { roleId: { $gt: after.roleId } },
                                    { roleId: after.roleId, grantId: { $gt: after.grantId } },
                                ],
                            },
                        ],
                    };
                const rows = await this.repository.collections.roleMenuGrants.find(filter, readOptions(this.session))
                    .sort({ roleId: 1, grantId: 1 })
                    .limit(pageSize)
                    .toArray();
                if (rows.length > pageSize) persistedInvalid("role menu grant keyset exceeded the host query budget");
                this.assertScopeStateForRows(rows.length);
                if (rows.length === 0) break;
                for (const row of rows) {
                    const grant = materializeRoleMenuGrantDocument(row, this.state.scope, this.state.scopeKey);
                    if (!expected.has(grant.roleId)) persistedInvalid("role menu grant batch crossed a role boundary");
                    if (
                        after !== undefined
                        && (
                            compareUtf8(grant.roleId, after.roleId) < 0
                            || (grant.roleId === after.roleId && compareUtf8(grant.grantId, after.grantId) <= 0)
                        )
                    ) {
                        persistedInvalid("role menu grant keyset did not advance");
                    }
                    const roleCount = (perRole.get(grant.roleId) ?? 0) + 1;
                    if (roleCount > MAX_ROLE_MENU_GRANTS) persistedInvalid(`role ${grant.roleId} grant inventory exceeds its limit`);
                    perRole.set(grant.roleId, roleCount);
                    after = { roleId: grant.roleId, grantId: grant.grantId };
                    result.push(grant);
                    if (result.length > MAX_EFFECTIVE_ROLE_MENU_GRANTS) {
                        persistedInvalid("effective role menu grant inventory exceeds its limit");
                    }
                }
                if (rows.length < pageSize) break;
            }
            return Object.freeze(result);
        } catch (error) {
            throw mapDatabaseReadError("The effective role menu grant inventory read failed.", error);
        }
    }

    async readNode(nodeIdInput: unknown): Promise<Readonly<InternalMenuNodeDocument> | null> {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        try {
            const raw = await this.repository.collections.menuNodes.findOne(
                { scopeKey: this.state.scopeKey, nodeId },
                readOptions(this.session),
            );
            this.assertScopeStateForRows(raw === null ? 0 : 1);
            return raw === null ? null : materializeMenuNodeDocument(raw, this.state.scope, this.state.scopeKey, this.schemes);
        } catch (error) {
            throw mapDatabaseReadError("The menu node read failed.", error);
        }
    }

    async requireNode(nodeIdInput: unknown) {
        const nodeId = normalizeRbacId(nodeIdInput, "nodeId");
        const node = await this.readNode(nodeId);
        if (node === null) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${nodeId} was not found.`);
        return node;
    }

    async readBinding(bindingIdInput: unknown): Promise<Readonly<InternalApiBindingDocument> | null> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        try {
            const raw = await this.repository.collections.apiBindings.findOne(
                { scopeKey: this.state.scopeKey, bindingId },
                readOptions(this.session),
            );
            this.assertScopeStateForRows(raw === null ? 0 : 1);
            return raw === null ? null : materializeApiBindingDocument(raw, this.state.scope, this.state.scopeKey, this.schemes);
        } catch (error) {
            throw mapDatabaseReadError("The API binding read failed.", error);
        }
    }

    async requireBinding(bindingIdInput: unknown) {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const binding = await this.readBinding(bindingId);
        if (binding === null) throw new PermissionCoreError("API_BINDING_NOT_FOUND", `API binding ${bindingId} was not found.`);
        return binding;
    }

    async readNodesByIds(nodeIdInputs: readonly unknown[]) {
        const ids = [...new Set(nodeIdInputs.map((value) => normalizeRbacId(value, "nodeIds")))].sort(compareUtf8);
        if (ids.length > MAX_MENU_NODES) persistedInvalid("menu node batch identity exceeds the scope limit");
        const result = new Map<string, Readonly<InternalMenuNodeDocument>>();
        const chunkSize = this.pageSize(ids.length || 1);
        try {
            for (let offset = 0; offset < ids.length; offset += chunkSize) {
                const chunk = ids.slice(offset, offset + chunkSize);
                const rows = await this.repository.collections.menuNodes.find(
                    { scopeKey: this.state.scopeKey, nodeId: { $in: chunk } },
                    readOptions(this.session),
                ).limit(chunk.length).toArray();
                this.assertScopeStateForRows(rows.length);
                for (const row of rows) {
                    const node = materializeMenuNodeDocument(row, this.state.scope, this.state.scopeKey, this.schemes);
                    if (!ids.includes(node.nodeId) || result.has(node.nodeId)) persistedInvalid("menu node batch returned an unexpected identity");
                    result.set(node.nodeId, node);
                }
            }
            return result;
        } catch (error) {
            throw mapDatabaseReadError("The menu node batch read failed.", error);
        }
    }

    async readBindingsByIds(bindingIdInputs: readonly unknown[]) {
        const ids = [...new Set(bindingIdInputs.map((value) => normalizeRbacId(value, "bindingIds")))].sort(compareUtf8);
        if (ids.length > MAX_API_BINDINGS) persistedInvalid("API binding batch identity exceeds the scope limit");
        const result = new Map<string, Readonly<InternalApiBindingDocument>>();
        const chunkSize = this.pageSize(ids.length || 1);
        try {
            for (let offset = 0; offset < ids.length; offset += chunkSize) {
                const chunk = ids.slice(offset, offset + chunkSize);
                const rows = await this.repository.collections.apiBindings.find(
                    { scopeKey: this.state.scopeKey, bindingId: { $in: chunk } },
                    readOptions(this.session),
                ).limit(chunk.length).toArray();
                this.assertScopeStateForRows(rows.length);
                for (const row of rows) {
                    const binding = materializeApiBindingDocument(row, this.state.scope, this.state.scopeKey, this.schemes);
                    if (!ids.includes(binding.bindingId) || result.has(binding.bindingId)) persistedInvalid("API binding batch returned an unexpected identity");
                    result.set(binding.bindingId, binding);
                }
            }
            return result;
        } catch (error) {
            throw mapDatabaseReadError("The API binding batch read failed.", error);
        }
    }

    async readAllNodes() {
        const result: Readonly<InternalMenuNodeDocument>[] = [];
        let after: string | undefined;
        const pageSize = this.pageSize();
        try {
            while (result.length <= MAX_MENU_NODES) {
                const filter = after === undefined
                    ? { scopeKey: this.state.scopeKey }
                    : { scopeKey: this.state.scopeKey, nodeId: { $gt: after } };
                const rows = await this.repository.collections.menuNodes.find(filter, readOptions(this.session))
                    .sort({ nodeId: 1 })
                    .limit(pageSize)
                    .toArray();
                if (rows.length > pageSize) persistedInvalid("menu inventory page exceeds the host query budget");
                this.assertScopeStateForRows(rows.length);
                if (rows.length === 0) break;
                for (const row of rows) {
                    const node = materializeMenuNodeDocument(row, this.state.scope, this.state.scopeKey, this.schemes);
                    if (after !== undefined && compareUtf8(node.nodeId, after) <= 0) persistedInvalid("menu node keyset did not advance");
                    after = node.nodeId;
                    result.push(node);
                    if (result.length > MAX_MENU_NODES) persistedInvalid("menu node inventory exceeds the scope limit");
                }
                if (rows.length < pageSize) break;
            }
            if (result.length !== this.state.menuNodeCount) persistedInvalid("scope menuNodeCount does not match the menu inventory");
            return Object.freeze(result);
        } catch (error) {
            throw mapDatabaseReadError("The menu inventory read failed.", error);
        }
    }

    async readAllBindings() {
        const result: Readonly<InternalApiBindingDocument>[] = [];
        let after: string | undefined;
        const pageSize = this.pageSize();
        try {
            while (result.length <= MAX_API_BINDINGS) {
                const filter = after === undefined
                    ? { scopeKey: this.state.scopeKey }
                    : { scopeKey: this.state.scopeKey, bindingId: { $gt: after } };
                const rows = await this.repository.collections.apiBindings.find(filter, readOptions(this.session))
                    .sort({ bindingId: 1 })
                    .limit(pageSize)
                    .toArray();
                if (rows.length > pageSize) persistedInvalid("API inventory page exceeds the host query budget");
                this.assertScopeStateForRows(rows.length);
                if (rows.length === 0) break;
                for (const row of rows) {
                    const binding = materializeApiBindingDocument(row, this.state.scope, this.state.scopeKey, this.schemes);
                    if (after !== undefined && compareUtf8(binding.bindingId, after) <= 0) persistedInvalid("API binding keyset did not advance");
                    after = binding.bindingId;
                    result.push(binding);
                    if (result.length > MAX_API_BINDINGS) persistedInvalid("API binding inventory exceeds the scope limit");
                }
                if (rows.length < pageSize) break;
            }
            if (result.length !== this.state.apiBindingCount) persistedInvalid("scope apiBindingCount does not match the API inventory");
            return Object.freeze(result);
        } catch (error) {
            throw mapDatabaseReadError("The API binding inventory read failed.", error);
        }
    }

    async readCompleteInventory() {
        const nodes = await this.readAllNodes();
        const bindings = await this.readAllBindings();
        const nodesById = new Map(nodes.map((node) => [node.nodeId, node] as const));
        const endpoints = new Set<string>();
        const availabilityModes = new Map<string, "all" | "any">();
        for (const binding of bindings) {
            const endpoint = `${binding.method}\u0000${binding.path}`;
            if (endpoints.has(endpoint)) persistedInvalid("API inventory contains a duplicate method and path");
            endpoints.add(endpoint);
            for (const owner of binding.owners) {
                const node = nodesById.get(owner.id);
                if (!node) persistedInvalid("API binding owner references a missing menu node");
                if (node.type !== owner.type) persistedInvalid("API binding owner type does not match its menu node");
                if (owner.availabilityGroup !== undefined) {
                    const key = `${owner.type}\u0000${owner.id}\u0000${owner.availabilityGroup}`;
                    const current = availabilityModes.get(key);
                    if (current !== undefined && current !== owner.availabilityMode) {
                        persistedInvalid("API binding availability group contains conflicting modes");
                    }
                    availabilityModes.set(key, owner.availabilityMode!);
                }
            }
        }
        const manifestBytes = canonicalByteLength({
            schemaVersion: 2,
            mode: "replace",
            nodes: nodes.map(menuNodeManifestItemFromDocument),
            apiBindings: bindings.map(apiBindingManifestItemFromDocument),
        });
        if (manifestBytes !== this.state.replaceManifestBytes) {
            persistedInvalid("scope replaceManifestBytes does not match the complete inventory");
        }
        return Object.freeze({ nodes, bindings, manifestBytes });
    }
}

export class MenuReadStore {
    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
    ) {}

    async open(scope: PermissionScope, session?: MongoSession) {
        try {
            const state = await this.repository.scopeStates.read(scope, session);
            return new MenuScopeReader(this.repository, this.schemes, state, session);
        } catch (error) {
            throw mapDatabaseReadError("The menu scope state read failed.", error);
        }
    }
}
