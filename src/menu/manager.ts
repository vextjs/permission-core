import { randomUUID } from "node:crypto";

import { PermissionCore, PermissionCoreError } from "../core";
import { getSubjectScope, normalizePermissionScope } from "../scope";
import type { RoleManager } from "../rbac";
import { PermissionCoreErrorCode, type PermissionRule, type PermissionScope, type PermissionSubject } from "../types";
import { getPermissionScopeKey } from "../scope";
import { assertValidAction } from "../utils/validation";

import { buildAuthorizationTree } from "./authorization-tree";
import { getNodeBinding } from "./binding";
import { createApiResource, normalizeApiManifest, normalizeFrontendManifest, type RawApiManifestRoute } from "./manifest";
import { MemoryMenuStorageAdapter } from "./memory-menu-storage";
import { createMenuHash, stableSerialize } from "./hash";
import { MenuPermissionExtensionRegistry } from "./extensions";
import { validateMenuConfiguration } from "./validation";
import type {
    ApiBinding,
    ApiManifest,
    ButtonMapOptions,
    ButtonPermissionMap,
    FrontendMenuManifest,
    ImportSummary,
    ManifestImportOptions,
    MenuNode,
    MenuPermissionSnapshot,
    PermissionBinding,
    PermissionAuditEntry,
    RoleAuthorizationInput,
    MenuPermissionOptions,
    MenuPermissionStorageAdapter,
    RoutePermissionState,
    AuthorizationTreeNode,
    VisibleMenuNode,
    VisibleTreeOptions,
} from "./types";

const TREE_NODE_TYPES = new Set(["directory", "menu", "page", "external", "iframe"]);

export class MenuPermissionManager {
    private readonly core: PermissionCore;
    private readonly storage: MenuPermissionStorageAdapter;
    private readonly strictApiBindings: boolean;
    private readonly cacheEnabled: boolean;
    private readonly cacheMaxEntries: number;
    private readonly snapshots = new Map<string, MenuPermissionSnapshot<unknown>>();
    private storageReady?: Promise<void>;
    private closed = false;
    /** 当前 manager 使用的 manifest 与校验扩展注册表。 */
    readonly extensions: MenuPermissionExtensionRegistry;

    constructor(options: MenuPermissionOptions) {
        this.core = options.core;
        this.storage = options.storage ?? new MemoryMenuStorageAdapter();
        this.strictApiBindings = options.strictApiBindings ?? false;
        this.cacheEnabled = options.cache !== false;
        this.cacheMaxEntries = options.cache === false ? 0 : Math.max(1, options.cache?.maxEntries ?? 500);
        this.extensions = options.extensions ?? new MenuPermissionExtensionRegistry();
    }

    async init(): Promise<void> {
        await this.ensureStorageReady();
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        await this.ensureStorageReady();
        await this.storage.close?.();
        this.snapshots.clear();
        this.closed = true;
    }

    async getVisibleMenuTree(subject: PermissionSubject, options: VisibleTreeOptions = {}): Promise<VisibleMenuNode[]> {
        return (await this.getVisibleMenuSnapshot(subject, options)).data;
    }

    async getVisibleMenuSnapshot(
        subject: PermissionSubject,
        options: VisibleTreeOptions = {},
    ): Promise<MenuPermissionSnapshot<VisibleMenuNode[]>> {
        await this.ensureStorageReady();
        const scope = getSubjectScope(subject);
        const cacheContext = await this.createCacheContext(subject, `tree:${options.includeDisabled === true}`);
        const cached = this.getCachedSnapshot<VisibleMenuNode[]>(cacheContext.key);
        if (cached) {
            return cached;
        }
        const nodes = (await this.storage.listMenuNodes(scope))
            .filter((node) => TREE_NODE_TYPES.has(node.type));
        const childMap = this.createChildMap(nodes);

        const rootNodes = nodes.filter((node) => !node.parentId);
        const visibleRoots = await Promise.all(
            rootNodes.map((node) => this.toVisibleNode(subject, node, childMap, options)),
        );

        const data = visibleRoots
            .filter((node): node is VisibleMenuNode => node !== null)
            .sort(compareMenuNodes);
        return this.cacheSnapshot(cacheContext.key, cacheContext.version, data);
    }

    async getVisibleButtons(
        subject: PermissionSubject,
        pageId: string,
        options: ButtonMapOptions = {},
    ): Promise<ButtonPermissionMap> {
        return (await this.getButtonPermissionSnapshot(subject, pageId, options)).data;
    }

    async getButtonPermissionSnapshot(
        subject: PermissionSubject,
        pageId: string,
        options: ButtonMapOptions = {},
    ): Promise<MenuPermissionSnapshot<ButtonPermissionMap>> {
        await this.ensureStorageReady();
        const scope = getSubjectScope(subject);
        const strictApiBindings = options.strictApiBindings ?? this.strictApiBindings;
        const cacheContext = await this.createCacheContext(subject, `buttons:${pageId}:${strictApiBindings}`);
        const cached = this.getCachedSnapshot<ButtonPermissionMap>(cacheContext.key);
        if (cached) {
            return cached;
        }
        const [nodes, apiBindings] = await Promise.all([
            this.storage.listMenuNodes(scope),
            this.storage.listApiBindings(scope),
        ]);
        const buttons = nodes.filter((node) => node.type === "button" && (node.pageId === pageId || node.parentId === pageId));
        const map: ButtonPermissionMap = {};

        for (const button of buttons.sort(compareMenuNodes)) {
            const code = button.code ?? button.id;
            const binding = getNodeBinding(button);
            const bindings = apiBindings.filter((apiBinding) => apiBinding.ownerType === "button" && apiBinding.ownerId === button.id);
            const apiResources = bindings.map((apiBinding) => apiBinding.resource);

            if (isDisabled(button)) {
                map[code] = {
                    visible: false,
                    enabled: false,
                    reason: "disabled",
                    resource: binding.resource,
                    apiBindings: apiResources,
                };
                continue;
            }

            const visible = await this.core.canSubject(subject, binding.action, binding.resource);
            if (!visible) {
                map[code] = {
                    visible: false,
                    enabled: false,
                    reason: "permission-denied",
                    resource: binding.resource,
                    apiBindings: apiResources,
                };
                continue;
            }

            const missingRequiredApi = strictApiBindings
                ? await this.findMissingRequiredApi(subject, bindings)
                : undefined;

            map[code] = {
                visible: true,
                enabled: missingRequiredApi === undefined,
                reason: missingRequiredApi ? "required-api-denied" : undefined,
                resource: binding.resource,
                apiBindings: apiResources,
            };
        }

        return this.cacheSnapshot(cacheContext.key, cacheContext.version, map);
    }

    async getRoutePermission(subject: PermissionSubject, path: string): Promise<RoutePermissionState> {
        await this.ensureStorageReady();
        const scope = getSubjectScope(subject);
        const nodes = await this.storage.listMenuNodes(scope);
        const routeTarget = selectRouteAuthorizationTarget(nodes, path);

        if (routeTarget.kind === "missing") {
            return { allowed: false, reason: "route-not-found" };
        }

        // Route ambiguity is an authorization ambiguity, so it must fail closed.
        if (routeTarget.kind === "conflict") {
            return { allowed: false, reason: "route-conflict" };
        }

        const node = routeTarget.node;
        if (isDisabled(node)) {
            return { allowed: false, reason: "disabled", node };
        }

        const binding = getNodeBinding(node);
        const allowed = await this.core.canSubject(subject, binding.action, binding.resource);
        return {
            allowed,
            reason: allowed ? undefined : "permission-denied",
            action: binding.action,
            resource: binding.resource,
            node,
        };
    }

    async importFrontendManifest(
        scope: PermissionScope,
        manifest: FrontendMenuManifest | MenuNode[],
        options: ManifestImportOptions = {},
    ): Promise<{ nodes: ImportSummary; apiBindings?: ImportSummary }> {
        await this.ensureStorageReady();
        const normalizedScope = normalizePermissionScope(scope);
        const normalized = await this.extensions.normalizeFrontend(
            normalizeFrontendManifest(manifest),
            { scope: normalizedScope },
        );
        assertUniqueIds(normalized.nodes, "menu manifest");
        if (normalized.apiBindings) {
            assertUniqueIds(normalized.apiBindings, "API binding manifest");
        }
        const beforeNodes = await this.storage.listMenuNodes(normalizedScope);
        const beforeBindings = await this.storage.listApiBindings(normalizedScope);
        const candidateNodes = options.mode === "merge"
            ? mergeAssets(beforeNodes, normalized.nodes)
            : normalized.nodes;
        const candidateBindings = normalized.apiBindings
            ? options.mode === "merge"
                ? mergeAssets(beforeBindings, normalized.apiBindings)
                : normalized.apiBindings
            : beforeBindings;
        await this.assertManifestValid(normalizedScope, candidateNodes, candidateBindings);

        try {
            const nodes = options.mode === "merge"
                ? await this.storage.upsertMenuNodes(normalizedScope, normalized.nodes)
                : await this.storage.replaceMenuNodes(normalizedScope, normalized.nodes);
            const apiBindings = normalized.apiBindings
                ? options.mode === "merge"
                    ? await this.storage.upsertApiBindings(normalizedScope, normalized.apiBindings)
                    : await this.storage.replaceApiBindings(normalizedScope, normalized.apiBindings)
                : undefined;
            await this.appendManifestAudit(normalizedScope, options, { nodes, apiBindings });
            await this.invalidateMenu(normalizedScope);
            return { nodes, apiBindings };
        } catch (error) {
            return this.compensateManifestImport(normalizedScope, beforeNodes, beforeBindings, error);
        }
    }

    async importApiManifest(
        scope: PermissionScope,
        manifest: ApiManifest | ApiBinding[] | { routes: RawApiManifestRoute[] },
        options: ManifestImportOptions = {},
    ): Promise<ImportSummary> {
        await this.ensureStorageReady();
        const normalizedScope = normalizePermissionScope(scope);
        const normalized = await this.extensions.normalizeApi(
            normalizeApiManifest(manifest),
            { scope: normalizedScope },
        );
        assertUniqueIds(normalized.bindings, "API binding manifest");
        const [nodes, beforeBindings] = await Promise.all([
            this.storage.listMenuNodes(normalizedScope),
            this.storage.listApiBindings(normalizedScope),
        ]);
        const candidateBindings = options.mode === "merge"
            ? mergeAssets(beforeBindings, normalized.bindings)
            : normalized.bindings;
        await this.assertManifestValid(normalizedScope, nodes, candidateBindings);

        try {
            const summary = options.mode === "merge"
                ? await this.storage.upsertApiBindings(normalizedScope, normalized.bindings)
                : await this.storage.replaceApiBindings(normalizedScope, normalized.bindings);
            await this.appendManifestAudit(normalizedScope, options, { apiBindings: summary });
            await this.invalidateMenu(normalizedScope);
            return summary;
        } catch (error) {
            return this.compensateManifestImport(normalizedScope, nodes, beforeBindings, error);
        }
    }

    async validate(scope: PermissionScope) {
        await this.ensureStorageReady();
        const normalizedScope = normalizePermissionScope(scope);
        const [nodes, apiBindings, roleRules] = await Promise.all([
            this.storage.listMenuNodes(normalizedScope),
            this.storage.listApiBindings(normalizedScope),
            this.collectRoleRules(normalizedScope),
        ]);

        const builtIn = validateMenuConfiguration(nodes, apiBindings, roleRules, {
            resourceSchemes: this.core.resourceSchemes,
        });
        const extensionDiagnostics = await this.extensions.validate(nodes, apiBindings, {
            scope: normalizedScope,
            roleRules,
        });
        return [...builtIn, ...extensionDiagnostics];
    }

    async loadFrontendManifest(
        scope: PermissionScope,
        loaderName: string,
        source: unknown,
        options: ManifestImportOptions = {},
    ) {
        const normalizedScope = normalizePermissionScope(scope);
        const manifest = await this.extensions.loadFrontend(loaderName, source, { scope: normalizedScope });
        return this.importFrontendManifest(normalizedScope, manifest, options);
    }

    async loadApiManifest(
        scope: PermissionScope,
        loaderName: string,
        source: unknown,
        options: ManifestImportOptions = {},
    ) {
        const normalizedScope = normalizePermissionScope(scope);
        const manifest = await this.extensions.loadApi(loaderName, source, { scope: normalizedScope });
        return this.importApiManifest(normalizedScope, manifest, options);
    }

    async getAuthorizationTree(scope: PermissionScope, roleId: string): Promise<AuthorizationTreeNode[]> {
        await this.ensureStorageReady();
        const normalizedScope = normalizePermissionScope(scope);
        const scoped = this.core.scope(normalizedScope);
        const [nodes, apiBindings, inspection] = await Promise.all([
            this.storage.listMenuNodes(normalizedScope),
            this.storage.listApiBindings(normalizedScope),
            scoped.roles.inspect(roleId),
        ]);

        const roleRuleSources = await Promise.all(inspection.roleChain.map(async (role) => ({
            roleId: role.id,
            rules: await scoped.roles.getRules(role.id),
        })));
        return buildAuthorizationTree(
            nodes,
            apiBindings,
            inspection.ownRules,
            inspection.effectiveRules,
            roleRuleSources,
            (pattern, resource) => this.core.resourceSchemes.match(pattern, resource),
        );
    }

    async saveRoleAuthorization(
        scope: PermissionScope,
        roleId: string,
        input: RoleAuthorizationInput,
    ): Promise<PermissionAuditEntry> {
        await this.ensureStorageReady();
        const normalizedScope = normalizePermissionScope(scope);
        const scoped = this.core.scope(normalizedScope);
        const [before, nodes, apiBindings] = await Promise.all([
            scoped.roles.getRules(roleId),
            this.storage.listMenuNodes(normalizedScope),
            this.storage.listApiBindings(normalizedScope),
        ]);
        this.assertAuthorizationInput(input, before, nodes, apiBindings);
        const after = createNextRoleRules(before, input);
        const changes = diffRules(before, after);
        if (changes.added.length > 0 || changes.removed.length > 0) {
            try {
                await this.applyRoleRules(scoped.roles, roleId, after);
            } catch (error) {
                await this.compensateRoleRules(normalizedScope, scoped.roles, roleId, before, error, "apply role authorization");
            }
        }

        const auditEntry: PermissionAuditEntry = {
            id: `audit:${randomUUID()}`,
            scopeKey: getPermissionScopeKey(normalizedScope),
            actorId: input.actorId,
            roleId,
            action: "role-authorization.save",
            before,
            after,
            changes,
            reason: input.reason,
            createdAt: Date.now(),
        };

        try {
            await this.storage.appendAuditEntries(normalizedScope, [auditEntry]);
        } catch (error) {
            if (changes.added.length > 0 || changes.removed.length > 0) {
                await this.compensateRoleRules(normalizedScope, scoped.roles, roleId, before, error, "append role authorization audit");
            }
            throw error;
        }
        await scoped.invalidateScope();
        await this.invalidateMenu(normalizedScope);
        return auditEntry;
    }

    async listAuditEntries(scope: PermissionScope): Promise<PermissionAuditEntry[]> {
        await this.ensureStorageReady();
        return this.storage.listAuditEntries(normalizePermissionScope(scope));
    }

    async invalidateMenu(scope?: PermissionScope): Promise<void> {
        const prefix = scope ? `${getPermissionScopeKey(normalizePermissionScope(scope))}|` : undefined;
        for (const key of this.snapshots.keys()) {
            if (!prefix || key.startsWith(prefix)) {
                this.snapshots.delete(key);
            }
        }
    }

    private async ensureStorageReady() {
        if (this.closed) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.NOT_INITIALIZED,
                "MenuPermissionManager has been closed",
            );
        }
        this.storageReady ??= Promise.resolve(this.storage.init?.());
        await this.storageReady;
    }

    private async createCacheContext(subject: PermissionSubject, discriminator: string) {
        const scope = getSubjectScope(subject);
        const [revision, permissions] = await Promise.all([
            this.storage.getRevision(scope),
            this.core.getPermissionsForSubject(subject),
        ]);
        const permissionHash = createMenuHash(sortRules(permissions));
        const version = `${revision}:${permissionHash.slice(0, 16)}`;
        return {
            key: JSON.stringify([getPermissionScopeKey(scope), subject.userId, discriminator, version]),
            version,
        };
    }

    private getCachedSnapshot<T>(key: string): MenuPermissionSnapshot<T> | undefined {
        if (!this.cacheEnabled) {
            return undefined;
        }
        const snapshot = this.snapshots.get(key) as MenuPermissionSnapshot<T> | undefined;
        return snapshot ? structuredClone(snapshot) : undefined;
    }

    private cacheSnapshot<T>(key: string, version: string, data: T): MenuPermissionSnapshot<T> {
        const snapshot: MenuPermissionSnapshot<T> = {
            data: structuredClone(data),
            version,
            etag: `"${createMenuHash({ version, data })}"`,
        };
        if (this.cacheEnabled) {
            while (this.snapshots.size >= this.cacheMaxEntries) {
                const oldestKey = this.snapshots.keys().next().value as string | undefined;
                if (!oldestKey) {
                    break;
                }
                this.snapshots.delete(oldestKey);
            }
            this.snapshots.set(key, structuredClone(snapshot));
        }
        return structuredClone(snapshot);
    }

    private async assertManifestValid(scope: PermissionScope, nodes: MenuNode[], apiBindings: ApiBinding[]) {
        const roleRules = await this.collectRoleRules(scope);
        const builtIn = validateMenuConfiguration(nodes, apiBindings, roleRules, {
            resourceSchemes: this.core.resourceSchemes,
        });
        const extensionDiagnostics = await this.extensions.validate(nodes, apiBindings, { scope, roleRules });
        const errors = [...builtIn, ...extensionDiagnostics].filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length > 0) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `Menu manifest validation failed: ${errors.map((error) => error.code).join(", ")}`,
                errors,
            );
        }
    }

    private async appendManifestAudit(
        scope: PermissionScope,
        options: ManifestImportOptions,
        changes: { nodes?: ImportSummary; apiBindings?: ImportSummary },
    ) {
        const entry: PermissionAuditEntry = {
            id: `audit:${randomUUID()}`,
            scopeKey: getPermissionScopeKey(scope),
            actorId: options.actorId,
            action: "manifest.import",
            changes: { mode: options.mode ?? "replace", ...changes },
            reason: options.reason,
            createdAt: Date.now(),
        };
        await this.storage.appendAuditEntries(scope, [entry]);
    }

    private async compensateManifestImport(
        scope: PermissionScope,
        nodes: MenuNode[],
        apiBindings: ApiBinding[],
        cause: unknown,
    ): Promise<never> {
        try {
            await this.storage.replaceMenuNodes(scope, nodes);
            await this.storage.replaceApiBindings(scope, apiBindings);
            await this.invalidateMenu(scope);
        } catch (compensationError) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.STORAGE_ERROR,
                "Menu manifest import failed and compensation could not restore the previous state",
                { cause, compensationError },
            );
        }
        throw new PermissionCoreError(
            PermissionCoreErrorCode.STORAGE_ERROR,
            "Menu manifest import failed; the previous state was restored",
            cause,
        );
    }

    private assertAuthorizationInput(
        input: RoleAuthorizationInput,
        before: PermissionRule[],
        nodes: MenuNode[],
        apiBindings: ApiBinding[],
    ) {
        const known = new Set<string>();
        for (const node of nodes) {
            const binding = getNodeBinding(node);
            known.add(permissionBindingKey(binding));
            for (const dataPermission of node.dataPermissions ?? []) {
                known.add(permissionBindingKey({
                    action: dataPermission.action ?? "read",
                    resource: dataPermission.resource,
                }));
            }
        }
        for (const binding of apiBindings) {
            known.add(permissionBindingKey({
                action: binding.action ?? "invoke",
                resource: binding.resource,
            }));
        }

        const beforeKeys = new Set(before.map((rule) => permissionBindingKey(rule)));
        const allowKeys = new Set<string>();
        const denyKeys = new Set<string>();
        for (const [kind, bindings] of [
            ["allow", input.allow ?? []],
            ["deny", input.deny ?? []],
            ["revoke", input.revoke ?? []],
        ] as const) {
            for (const binding of bindings) {
                assertValidAction(binding.action);
                this.core.resourceSchemes.assertValid(binding.resource);
                const key = permissionBindingKey(binding);
                if (!known.has(key) && !(kind === "revoke" && beforeKeys.has(key))) {
                    throw new PermissionCoreError(
                        PermissionCoreErrorCode.INVALID_ARGUMENT,
                        `Role authorization references an unknown asset '${binding.action} ${binding.resource}'`,
                    );
                }
                if (kind === "allow") allowKeys.add(key);
                if (kind === "deny") denyKeys.add(key);
            }
        }
        const conflicts = Array.from(allowKeys).filter((key) => denyKeys.has(key));
        if (conflicts.length > 0) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                "The same asset cannot be allowed and denied in one authorization save",
                conflicts,
            );
        }
    }

    private async applyRoleRules(roles: RoleManager, roleId: string, rules: PermissionRule[]) {
        await roles.clearRules(roleId);
        for (const rule of sortRules(rules)) {
            const method = rule.type === "allow" ? roles.allow.bind(roles) : roles.deny.bind(roles);
            await method(roleId, rule.action, rule.resource, { where: rule.where });
        }
    }

    private async compensateRoleRules(
        scope: PermissionScope,
        roles: RoleManager,
        roleId: string,
        before: PermissionRule[],
        cause: unknown,
        operation: string,
    ): Promise<never> {
        try {
            await this.applyRoleRules(roles, roleId, before);
            await this.invalidateMenu(scope);
        } catch (compensationError) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.STORAGE_ERROR,
                `Failed to ${operation}; role rule compensation also failed`,
                { cause, compensationError },
            );
        }
        throw new PermissionCoreError(
            PermissionCoreErrorCode.STORAGE_ERROR,
            `Failed to ${operation}; previous role rules were restored`,
            cause,
        );
    }

    private async collectRoleRules(scope: PermissionScope) {
        const scoped = this.core.scope(scope);
        const roles = await scoped.roles.list();
        return Promise.all(roles.map(async (role) => ({
            roleId: role.id,
            rules: await scoped.roles.getEffectiveRules(role.id),
        })));
    }

    private createChildMap(nodes: MenuNode[]) {
        const childMap = new Map<string, MenuNode[]>();
        for (const node of nodes) {
            if (!node.parentId) {
                continue;
            }

            const children = childMap.get(node.parentId) ?? [];
            children.push(node);
            childMap.set(node.parentId, children);
        }

        return childMap;
    }

    private async toVisibleNode(
        subject: PermissionSubject,
        node: MenuNode,
        childMap: Map<string, MenuNode[]>,
        options: VisibleTreeOptions,
    ): Promise<VisibleMenuNode | null> {
        if (!options.includeDisabled && isDisabled(node)) {
            return null;
        }

        const children = await Promise.all(
            (childMap.get(node.id) ?? []).map((child) => this.toVisibleNode(subject, child, childMap, options)),
        );
        const visibleChildren = children
            .filter((child): child is VisibleMenuNode => child !== null)
            .sort(compareMenuNodes);

        if (node.hidden || node.type === "page") {
            return visibleChildren.length > 0 ? { ...node, children: visibleChildren } : null;
        }

        if (node.type === "directory" && !node.resource) {
            return visibleChildren.length > 0 ? { ...node, children: visibleChildren } : null;
        }

        const binding = getNodeBinding(node);
        const allowed = await this.core.canSubject(subject, binding.action, binding.resource);
        if (!allowed && visibleChildren.length === 0) {
            return null;
        }

        return {
            ...node,
            children: visibleChildren.length > 0 ? visibleChildren : undefined,
        };
    }

    private async findMissingRequiredApi(subject: PermissionSubject, bindings: ApiBinding[]) {
        for (const group of groupRequiredApiBindings(bindings)) {
            const results = await Promise.all(group.bindings.map(async (binding) => ({
                binding,
                allowed: await this.core.canSubject(
                    subject,
                    binding.action ?? "invoke",
                    binding.resource || createApiResource(binding.method, binding.path),
                ),
            })));
            const satisfied = group.mode === "any"
                ? results.some((result) => result.allowed)
                : results.every((result) => result.allowed);
            if (!satisfied) {
                return results.find((result) => !result.allowed)?.binding ?? group.bindings[0];
            }
        }

        return undefined;
    }
}

function groupRequiredApiBindings(bindings: ApiBinding[]) {
    const groups = new Map<string, { mode: "any" | "all"; bindings: ApiBinding[] }>();
    for (const binding of bindings.filter((candidate) => candidate.required)) {
        const key = binding.permissionGroup ?? `binding:${binding.id}`;
        const group = groups.get(key) ?? { mode: binding.permissionMode ?? "all", bindings: [] };
        group.bindings.push(binding);
        groups.set(key, group);
    }
    return Array.from(groups.values());
}

function mergeAssets<T extends { id: string }>(current: T[], incoming: T[]) {
    const merged = new Map(current.map((item) => [item.id, structuredClone(item)]));
    for (const item of incoming) {
        merged.set(item.id, structuredClone(item));
    }
    return Array.from(merged.values());
}

function assertUniqueIds<T extends { id: string }>(values: T[], label: string) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value.id)) {
            duplicates.add(value.id);
        }
        seen.add(value.id);
    }
    if (duplicates.size > 0) {
        throw new PermissionCoreError(
            PermissionCoreErrorCode.INVALID_ARGUMENT,
            `${label} contains duplicate ids: ${Array.from(duplicates).sort().join(", ")}`,
        );
    }
}

function permissionBindingKey(binding: Pick<PermissionBinding, "action" | "resource">) {
    return `${binding.action}\u0000${binding.resource}`;
}

function sortRules(rules: PermissionRule[]) {
    return rules
        .map((rule) => structuredClone(rule))
        .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
}

function createNextRoleRules(before: PermissionRule[], input: RoleAuthorizationInput) {
    const revokes = new Set((input.revoke ?? []).map(permissionBindingKey));
    const desired = new Map<string, PermissionRule>();
    for (const binding of input.allow ?? []) {
        desired.set(permissionBindingKey(binding), {
            type: "allow",
            action: binding.action,
            resource: binding.resource,
        });
    }
    for (const binding of input.deny ?? []) {
        desired.set(permissionBindingKey(binding), {
            type: "deny",
            action: binding.action,
            resource: binding.resource,
        });
    }

    const next = before.filter((rule) => {
        if (rule.where !== undefined) {
            return true;
        }
        const key = permissionBindingKey(rule);
        return !revokes.has(key) && !desired.has(key);
    });
    next.push(...desired.values());

    const deduplicated = new Map<string, PermissionRule>();
    for (const rule of next) {
        deduplicated.set(stableSerialize(rule), structuredClone(rule));
    }
    return sortRules(Array.from(deduplicated.values()));
}

function diffRules(before: PermissionRule[], after: PermissionRule[]) {
    const beforeByKey = new Map(before.map((rule) => [stableSerialize(rule), structuredClone(rule)]));
    const afterByKey = new Map(after.map((rule) => [stableSerialize(rule), structuredClone(rule)]));
    return {
        added: sortRules(Array.from(afterByKey.entries())
            .filter(([key]) => !beforeByKey.has(key))
            .map(([, rule]) => rule)),
        removed: sortRules(Array.from(beforeByKey.entries())
            .filter(([key]) => !afterByKey.has(key))
            .map(([, rule]) => rule)),
    };
}

export function createMenuPermission(options: MenuPermissionOptions) {
    return new MenuPermissionManager(options);
}

function compareMenuNodes(left: MenuNode, right: MenuNode) {
    return (left.order ?? 0) - (right.order ?? 0)
        || left.title.localeCompare(right.title)
        || left.id.localeCompare(right.id);
}

function isDisabled(node: MenuNode) {
    return node.disabled === true || node.status === "disabled";
}

type RouteTargetResult =
    | { kind: "found"; node: MenuNode }
    | { kind: "missing" }
    | { kind: "conflict" };

function selectRouteAuthorizationTarget(nodes: MenuNode[], path: string): RouteTargetResult {
    const candidates = nodes.filter((candidate) => candidate.path === path && candidate.type !== "button");
    if (candidates.length === 0) {
        return { kind: "missing" };
    }

    const priority = ["page", "menu", "external", "iframe", "directory"] as const;
    for (const type of priority) {
        const matches = candidates.filter((candidate) => candidate.type === type);
        if (matches.length > 1) {
            return { kind: "conflict" };
        }
        if (matches.length === 1) {
            return { kind: "found", node: matches[0] };
        }
    }

    return { kind: "conflict" };
}
