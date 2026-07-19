import type {
    ApiBindingManager,
    MenuManager,
    PermissionAction,
    PermissionScope,
    PermissionSubject,
    PolicyContext,
    RoleManager,
    RoleMenuPermissionManager,
    ScopedPermissionContext,
    SubjectMenuRuntime,
    SubjectDataRuntime,
    SubjectPermissionContext,
    UserRoleManager,
} from "../types";
import type { PermissionSemanticCache, CachedAuthorizationState } from "../cache";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalString } from "../internal/canonical";
import { mapDatabaseReadError, type PermissionRepository } from "../persistence/repository";
import type { RbacQueryService } from "./queries";
import { SubjectAuthorizationRuntime } from "./runtime";
import { loadEffectiveAuthorization } from "./effective";
import type { RbacScopeReader } from "./store";
import { normalizeRbacId } from "./validation";
import type { RbacPreviewService } from "./preview";
import type { RoleMutationService } from "./role-mutations";
import type { UserRoleMutationService } from "./user-role-mutations";
import type {
    ApiBindingImpactMutationService,
    ApiBindingMutationService,
    MenuManifestService,
    MenuNodeImpactMutationService,
    MenuNodeMutationService,
    MenuQueryService,
    RoleMenuPermissionMutationService,
    RoleMenuPermissionQueryService,
    RoleMenuPermissionRepairService,
    StructuralStaleReferenceService,
} from "../menu";
import { SubjectMenuAuthorizationRuntime } from "../menu";
import { exactMenuRecord, normalizeDeclaredPath } from "../menu/validation";

export type RunPermissionOperation = <T>(operation: () => Promise<T>) => Promise<T>;

export interface ScopedRbacServices {
    readonly queries: RbacQueryService;
    readonly roles: RoleMutationService;
    readonly previews: RbacPreviewService;
    readonly userRoles: UserRoleMutationService;
    readonly roleMenu: {
        readonly mutations: RoleMenuPermissionMutationService;
        readonly queries: RoleMenuPermissionQueryService;
        readonly repair: RoleMenuPermissionRepairService;
    };
    readonly menuManagement: {
        readonly queries: MenuQueryService;
        readonly nodes: MenuNodeMutationService;
        readonly nodeImpacts: MenuNodeImpactMutationService;
        readonly bindings: ApiBindingMutationService;
        readonly bindingImpacts: ApiBindingImpactMutationService;
        readonly manifest: MenuManifestService;
        readonly stale: StructuralStaleReferenceService;
    };
}

interface LoadedSubjectAuthorization extends CachedAuthorizationState {
    readonly reader?: RbacScopeReader;
}

function isReadConflict(error: unknown): error is PermissionCoreError {
    return error instanceof PermissionCoreError && error.code === "READ_CONFLICT";
}

async function loadStableSubjectAuthorization(
    queryService: RbacQueryService,
    subject: Readonly<PermissionSubject>,
): Promise<LoadedSubjectAuthorization> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const reader = await queryService.open(subject.scope);
        try {
            const direct = await reader.readUserRoleSet(subject.userId);
            const state = await loadEffectiveAuthorization(reader, direct);
            await reader.verifyAuthorizationUnchanged();
            return Object.freeze({
                state,
                rbacRevision: reader.state.rbacRevision,
                menuRevision: reader.state.menuRevision,
                reader,
            });
        } catch (error) {
            if (attempt === 0 && isReadConflict(error)) continue;
            throw error;
        }
    }
    throw new PermissionCoreError("READ_CONFLICT", "Authorization state did not stabilize after one retry.", {
        details: { kind: "read-conflict", owner: "scope.authorization", expected: "stable", current: "changing" },
    });
}

function assertReaderMatchesBoundAuthorization(
    reader: RbacScopeReader,
    loaded: LoadedSubjectAuthorization,
) {
    if (
        reader.state.rbacRevision !== loaded.rbacRevision
        || reader.state.menuRevision !== loaded.menuRevision
    ) {
        throw new PermissionCoreError("READ_CONFLICT", "Bound authorization state changed before the menu read.", {
            details: {
                kind: "read-conflict",
                owner: "scope.authorization",
                expected: canonicalString({ rbac: loaded.rbacRevision, menu: loaded.menuRevision }),
                current: canonicalString({
                    rbac: reader.state.rbacRevision,
                    menu: reader.state.menuRevision,
                }),
            },
        });
    }
}

async function retainCacheFillOnlyWhileCurrent(
    semanticCache: PermissionSemanticCache,
    subject: Readonly<PermissionSubject>,
    reader: RbacScopeReader,
) {
    try {
        // A committed mutation can delete the key after the cold read but before this reader fills the old snapshot.
        await reader.verifyAuthorizationUnchanged();
    } catch {
        try {
            await semanticCache.invalidateSubject(subject);
        } catch {
            // invalidateSubject records the bounded-staleness incident; the stable current read remains usable.
        }
    }
}

function normalizedTreeRootId(optionsInput?: { rootId?: string }) {
    const options = exactMenuRecord(optionsInput ?? {}, ["rootId"], "options");
    return Object.hasOwn(options, "rootId")
        ? normalizeRbacId(options.rootId, "options.rootId")
        : undefined;
}

function normalizedRoutePath(pathInput: string) {
    const path = normalizeDeclaredPath(pathInput, "path");
    if (path !== pathInput) {
        throw new PermissionCoreError("INVALID_ARGUMENT", "path must be a canonical declared route path.", {
            details: { kind: "validation", field: "path", reason: "must be a canonical declared route path" },
        });
    }
    return path;
}

export function createScopedPermissionContext(
    scope: Readonly<PermissionScope>,
    services: ScopedRbacServices,
    run: RunPermissionOperation,
): ScopedPermissionContext {
    const query = <T>(operation: () => Promise<T>) => run(async () => {
        try {
            return await operation();
        } catch (error) {
            throw mapDatabaseReadError("The RBAC management query failed.", error);
        }
    });
    const menuPermissions: RoleMenuPermissionManager = {
        preview: (roleId, change, options) => query(() => services.roleMenu.mutations.preview(scope, roleId, change, options)),
        grant: (roleId, selection, options) => run(() => services.roleMenu.mutations.grant(scope, roleId, selection, options)),
        revoke: (roleId, input, options) => run(() => services.roleMenu.mutations.revoke(scope, roleId, input, options)),
        deny: (roleId, selection, options) => run(() => services.roleMenu.mutations.deny(scope, roleId, selection, options)),
        set: (roleId, assignments, options) => run(() => services.roleMenu.mutations.set(scope, roleId, assignments, options)),
        getDirect: (roleId) => query(() => services.roleMenu.queries.getDirect(scope, roleId)),
        listDirect: (roleId, options) => query(() => services.roleMenu.queries.listDirect(scope, roleId, options)),
        getEffective: (roleId) => query(() => services.roleMenu.queries.getEffective(scope, roleId)),
        getAuthorizationTree: (roleId) => query(() => services.roleMenu.queries.getAuthorizationTree(scope, roleId)),
        listStale: (options) => query(() => services.roleMenu.queries.listStale(scope, options)),
        previewRepairStale: (input, options) => query(() => services.roleMenu.repair.preview(scope, input, options)),
        repairStale: (input, options) => run(() => services.roleMenu.repair.repair(scope, input, options)),
    };
    Object.freeze(menuPermissions);
    const roles: RoleManager = {
        menuPermissions,
        create: (input, options) => run(() => services.roles.create(scope, input, options)),
        get: (roleId) => query(() => services.queries.getRole(scope, roleId)),
        list: (options) => query(() => services.queries.listRoles(scope, options)),
        update: (roleId, patch, options) => run(() => services.roles.update(scope, roleId, patch, options)),
        previewAccessUpdate: (roleId, patch, options) => query(() => services.previews.previewAccessUpdate(scope, roleId, patch, options)),
        executeAccessUpdate: (roleId, patch, options) => run(() => services.previews.executeAccessUpdate(scope, roleId, patch, options)),
        getRemovalImpact: (roleId) => query(() => services.queries.getRemovalImpact(scope, roleId)),
        remove: (roleId, options) => run(() => services.roles.remove(scope, roleId, options)),
        allow: (roleId, rule, options) => run(() => services.previews.allow(scope, roleId, rule, options)),
        deny: (roleId, rule, options) => run(() => services.previews.deny(scope, roleId, rule, options)),
        revoke: (roleId, selector, options) => run(() => services.previews.revoke(scope, roleId, selector, options)),
        previewRuleChange: (roleId, change, options) => query(() => services.previews.previewRuleChange(scope, roleId, change, options)),
        executeRuleChange: (roleId, change, options) => run(() => services.previews.executeRuleChange(scope, roleId, change, options)),
        previewReplaceRules: (roleId, rules, options) => query(() => services.previews.previewReplaceRules(scope, roleId, rules, options)),
        replaceRules: (roleId, rules, options) => run(() => services.previews.replaceRules(scope, roleId, rules, options)),
        getOwnRules: (roleId) => query(() => services.queries.getOwnRules(scope, roleId)),
        listOwnRules: (roleId, options) => query(() => services.queries.listOwnRules(scope, roleId, options)),
        getEffectiveRules: (roleId) => query(() => services.queries.getEffectiveRules(scope, roleId)),
        getChain: (roleId) => query(() => services.queries.getChain(scope, roleId)),
    };
    Object.freeze(roles);
    const userRoles: UserRoleManager = {
        assign: (userId, roleId, options) => run(() => services.userRoles.assign(scope, userId, roleId, options)),
        revoke: (userId, roleId, options) => run(() => services.userRoles.revoke(scope, userId, roleId, options)),
        set: (userId, roleIds, options) => run(() => services.userRoles.set(scope, userId, roleIds, options)),
        clear: (userId, options) => run(() => services.userRoles.clear(scope, userId, options)),
        getDirect: (userId) => query(() => services.queries.getDirectUserRoles(scope, userId)),
        getEffective: (userId) => query(() => services.queries.getEffectiveUserRoles(scope, userId)),
        listUsersByRole: (roleId, options) => query(() => services.queries.listUsersByRole(scope, roleId, options)),
    };
    Object.freeze(userRoles);
    const manifest: MenuManager["manifest"] = {
        preview: (input, options) => query(() => services.menuManagement.manifest.preview(scope, input, options)),
        import: (input, options) => run(() => services.menuManagement.manifest.import(scope, input, options)),
        export: () => query(() => services.menuManagement.manifest.export(scope)),
        exportPage: (options) => query(() => services.menuManagement.manifest.exportPage(scope, options)),
    };
    Object.freeze(manifest);
    const menus: MenuManager = {
        manifest,
        create: (input, options) => run(() => services.menuManagement.nodes.create(scope, input, options)),
        get: (nodeId) => query(() => services.menuManagement.queries.getMenu(scope, nodeId)),
        list: (options) => query(() => services.menuManagement.queries.listMenus(scope, options)),
        getTree: (options) => query(() => services.menuManagement.queries.getTree(scope, options)),
        update: (nodeId, patch, options) => run(() => services.menuManagement.nodes.update(scope, nodeId, patch, options)),
        previewUpdate: (nodeId, request, options) => query(() => services.menuManagement.nodeImpacts.previewUpdate(scope, nodeId, request, options)),
        executeUpdate: (nodeId, request, options) => run(() => services.menuManagement.nodeImpacts.executeUpdate(scope, nodeId, request, options)),
        previewMove: (input, options) => query(() => services.menuManagement.nodeImpacts.previewMove(scope, input, options)),
        move: (input, options) => run(() => services.menuManagement.nodeImpacts.move(scope, input, options)),
        previewReorder: (input, options) => query(() => services.menuManagement.nodeImpacts.previewReorder(scope, input, options)),
        reorder: (input, options) => run(() => services.menuManagement.nodeImpacts.reorder(scope, input, options)),
        previewSetStatus: (nodeId, status, options) => query(() => services.menuManagement.nodeImpacts.previewSetStatus(scope, nodeId, status, options)),
        setStatus: (nodeId, status, options) => run(() => services.menuManagement.nodeImpacts.setStatus(scope, nodeId, status, options)),
        getRemovalImpact: (nodeId) => query(() => services.menuManagement.nodeImpacts.getRemovalImpact(scope, nodeId)),
        previewRemove: (nodeId, input, options) => query(() => services.menuManagement.nodeImpacts.previewRemove(scope, nodeId, input, options)),
        remove: (nodeId, input, options) => run(() => services.menuManagement.nodeImpacts.remove(scope, nodeId, input, options)),
        findStaleReferences: (options) => query(() => services.menuManagement.stale.findStaleReferences(scope, options)),
        previewRepairStaleReferences: (input, options) => query(() => services.menuManagement.stale.previewRepairStaleReferences(scope, input, options)),
        repairStaleReferences: (input, options) => run(() => services.menuManagement.stale.repairStaleReferences(scope, input, options)),
    };
    Object.freeze(menus);
    const apiBindings: ApiBindingManager = {
        create: (input, options) => run(() => services.menuManagement.bindings.create(scope, input, options)),
        get: (bindingId) => query(() => services.menuManagement.queries.getApiBinding(scope, bindingId)),
        list: (options) => query(() => services.menuManagement.queries.listApiBindings(scope, options)),
        update: (bindingId, patch, options) => run(() => services.menuManagement.bindings.update(scope, bindingId, patch, options)),
        previewSetStatus: (bindingId, status, options) => query(() => services.menuManagement.bindingImpacts.previewSetStatus(scope, bindingId, status, options)),
        setStatus: (bindingId, status, options) => run(() => services.menuManagement.bindingImpacts.setStatus(scope, bindingId, status, options)),
        getRemovalImpact: (bindingId) => query(() => services.menuManagement.bindingImpacts.getRemovalImpact(scope, bindingId)),
        previewUpdate: (bindingId, request, options) => query(() => services.menuManagement.bindingImpacts.previewUpdate(scope, bindingId, request, options)),
        executeUpdate: (bindingId, request, options) => run(() => services.menuManagement.bindingImpacts.executeUpdate(scope, bindingId, request, options)),
        previewRemove: (bindingId, input, options) => query(() => services.menuManagement.bindingImpacts.previewRemove(scope, bindingId, input, options)),
        remove: (bindingId, input, options) => run(() => services.menuManagement.bindingImpacts.remove(scope, bindingId, input, options)),
        previewReplace: (input, options) => query(() => services.menuManagement.bindingImpacts.previewReplace(scope, input, options)),
        replace: (input, options) => run(() => services.menuManagement.bindingImpacts.replace(scope, input, options)),
    };
    Object.freeze(apiBindings);
    return Object.freeze({ roles, userRoles, menus, apiBindings });
}

export function createSubjectPermissionContext(
    repository: PermissionRepository,
    queryService: RbacQueryService,
    resourceSchemes: ResourceSchemeRegistry,
    subject: Readonly<PermissionSubject>,
    context: PolicyContext,
    run: RunPermissionOperation,
    data?: SubjectDataRuntime,
    semanticCache?: PermissionSemanticCache,
): SubjectPermissionContext {
    const subjectData = data ?? Object.freeze({
        collection(): never {
            throw new PermissionCoreError("DATA_OPERATION_UNSUPPORTED", "The internal test context has no data runtime.");
        },
    });
    let authorizationLoadPromise: Promise<LoadedSubjectAuthorization> | undefined;
    const loadAuthorization = () => {
        if (!authorizationLoadPromise) {
            authorizationLoadPromise = (async () => {
                if (semanticCache !== undefined) {
                    const cached = await semanticCache.getPermissions(subject);
                    if (cached !== undefined) return cached;
                }
                const loaded = await loadStableSubjectAuthorization(queryService, subject);
                if (semanticCache !== undefined) {
                    const filled = await semanticCache.setPermissions(subject, loaded, loaded.state);
                    if (filled && loaded.reader !== undefined) {
                        await retainCacheFillOnlyWhileCurrent(semanticCache, subject, loaded.reader);
                    }
                }
                return loaded;
            })();
        }
        return authorizationLoadPromise;
    };
    const authorization = new SubjectAuthorizationRuntime(
        async () => (await loadAuthorization()).state,
        resourceSchemes,
        subject,
        context,
    );
    let menuRuntimePromise: Promise<{
        readonly runtime: SubjectMenuAuthorizationRuntime;
        readonly reader: RbacScopeReader;
    }> | undefined;
    const menuRuntime = () => {
        if (!menuRuntimePromise) {
            menuRuntimePromise = (async () => {
                const loaded = await loadAuthorization();
                const reader = loaded.reader ?? await queryService.open(subject.scope);
                assertReaderMatchesBoundAuthorization(reader, loaded);
                return Object.freeze({
                    runtime: new SubjectMenuAuthorizationRuntime(
                        repository,
                        resourceSchemes,
                        reader,
                        authorization,
                    ),
                    reader,
                });
            })();
        }
        return menuRuntimePromise;
    };
    const menus: SubjectMenuRuntime = Object.freeze({
        getVisibleTree: (options?: { rootId?: string }) => run(async () => {
            const rootId = normalizedTreeRootId(options);
            const loaded = await loadAuthorization();
            await authorization.ensurePolicyContextComplete();
            const revisions = { rbacRevision: loaded.rbacRevision, menuRevision: loaded.menuRevision };
            const cached = await semanticCache?.getMenuTree(subject, context, revisions, rootId);
            if (cached !== undefined) return cached;
            const menu = await menuRuntime();
            const result = await menu.runtime.getVisibleTree(rootId === undefined ? {} : { rootId });
            const filled = await semanticCache?.setMenuTree(subject, context, revisions, rootId, result);
            if (filled && semanticCache !== undefined) {
                await retainCacheFillOnlyWhileCurrent(semanticCache, subject, menu.reader);
            }
            return result;
        }),
        getButtonMap: (ownerNodeIdInput: string) => run(async () => {
            const ownerNodeId = normalizeRbacId(ownerNodeIdInput, "ownerNodeId");
            const loaded = await loadAuthorization();
            await authorization.ensurePolicyContextComplete();
            const revisions = { rbacRevision: loaded.rbacRevision, menuRevision: loaded.menuRevision };
            const cached = await semanticCache?.getButtonMap(subject, context, revisions, ownerNodeId);
            if (cached !== undefined) return cached;
            const menu = await menuRuntime();
            const result = await menu.runtime.getButtonMap(ownerNodeId);
            const filled = await semanticCache?.setButtonMap(subject, context, revisions, ownerNodeId, result);
            if (filled && semanticCache !== undefined) {
                await retainCacheFillOnlyWhileCurrent(semanticCache, subject, menu.reader);
            }
            return result;
        }),
        getRouteState: (pathInput: string) => run(async () => {
            const path = normalizedRoutePath(pathInput);
            const loaded = await loadAuthorization();
            await authorization.ensurePolicyContextComplete();
            const revisions = { rbacRevision: loaded.rbacRevision, menuRevision: loaded.menuRevision };
            const cached = await semanticCache?.getRouteState(subject, context, revisions, path);
            if (cached !== undefined) return cached;
            const menu = await menuRuntime();
            const result = await menu.runtime.getRouteState(path);
            const filled = await semanticCache?.setRouteState(subject, context, revisions, path, result);
            if (filled && semanticCache !== undefined) {
                await retainCacheFillOnlyWhileCurrent(semanticCache, subject, menu.reader);
            }
            return result;
        }),
    });
    return Object.freeze({
        data: subjectData,
        menus,
        can: (action: PermissionAction, resource: string) => run(() => authorization.can(action, resource)),
        cannot: (action: PermissionAction, resource: string) => run(() => authorization.cannot(action, resource)),
        assert: (action: PermissionAction, resource: string) => run(() => authorization.assert(action, resource)),
        getPermissions: () => run(() => authorization.getPermissions()),
        getResources: (action?: PermissionAction) => run(() => authorization.getResources(action)),
        explain: (action: PermissionAction, resource: string) => run(() => authorization.explain(action, resource)),
    });
}
