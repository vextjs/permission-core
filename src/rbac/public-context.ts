import type {
    PermissionAction,
    PermissionScope,
    PermissionSubject,
    PolicyContext,
    PreviewOptions,
    RoleManager,
    RoleMenuPermissionManager,
    ScopedMutationDefaults,
    ScopedPermissionContext,
    SubjectMenuRuntime,
    SubjectDataRuntime,
    SubjectPermissionContext,
    UserRoleManager,
    ApiResource,
} from "../types";
import type { PermissionSemanticCache, CachedAuthorizationState } from "../cache";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalString } from "../internal/canonical";
import { mapDatabaseReadError, type PermissionRepository } from "../persistence/repository";
import type { RbacQueryService } from "./queries";
import { SubjectAuthorizationRuntime } from "./runtime";
import { loadEffectiveAuthorization } from "./effective";
import { normalizePreviewOptions } from "./preview-inputs";
import type { RbacScopeReader } from "./store";
import { normalizeRbacId } from "./validation";
import type { RbacPreviewService } from "./preview";
import type { RoleMutationService } from "./role-mutations";
import type { UserRoleMutationService } from "./user-role-mutations";
import type {
    ApiBindingImpactMutationService,
    ApiBindingMutationService,
    BusinessRoleMenuPermissionMutationService,
    MenuConfigService,
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
        readonly businessMutations: BusinessRoleMenuPermissionMutationService;
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
        readonly config: MenuConfigService;
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

function menuConfigNotReady<T>(method: string): Promise<T> {
    return Promise.reject(new PermissionCoreError(
        "INVALID_CONFIGURATION",
        `${method} is not available until the menu config coordinator is initialized.`,
        {
            details: {
                kind: "validation",
                field: method,
                reason: "menu config coordinator is not implemented in this batch",
            },
        },
    ));
}

export function createScopedPermissionContext(
    scope: Readonly<PermissionScope>,
    services: ScopedRbacServices,
    run: RunPermissionOperation,
    defaults?: ScopedMutationDefaults,
): ScopedPermissionContext {
    const defaultOptions = defaults === undefined ? undefined : normalizePreviewOptions(defaults);
    const mergeOptionalOptions = <TOptions extends object>(options?: TOptions): TOptions | undefined => {
        if (defaultOptions === undefined) {
            return options;
        }
        return Object.freeze({
            ...defaultOptions,
            ...(options ?? {}),
        }) as TOptions;
    };
    const mergeRequiredOptions = <TOptions extends object>(options: TOptions): TOptions =>
        mergeOptionalOptions(options) as TOptions;
    const withDefaults = (nextDefaults: ScopedMutationDefaults) =>
        createScopedPermissionContext(scope, services, run, mergeOptionalOptions<PreviewOptions>(nextDefaults));
    const query = <T>(operation: () => Promise<T>) => run(async () => {
        try {
            return await operation();
        } catch (error) {
            throw mapDatabaseReadError("The RBAC management query failed.", error);
        }
    });
    const menuPermissions: RoleMenuPermissionManager = {
        preview: (roleId, change, options) => query(() =>
            services.roleMenu.businessMutations.preview(scope, roleId, change, mergeOptionalOptions(options))),
        grant: (roleId, selection, options) => run(() =>
            services.roleMenu.businessMutations.grant(scope, roleId, selection, mergeRequiredOptions(options))),
        revoke: (roleId, input, options) => run(() => services.roleMenu.businessMutations.revoke(scope, roleId, input, mergeRequiredOptions(options))),
        deny: (roleId, selection, options) => run(() =>
            services.roleMenu.businessMutations.deny(scope, roleId, selection, mergeRequiredOptions(options))),
        set: (roleId, assignments, options) => run(() =>
            services.roleMenu.businessMutations.set(scope, roleId, assignments, mergeRequiredOptions(options))),
        getDirect: (roleId) => query(() => services.roleMenu.queries.getBusinessDirect(scope, roleId)),
        listDirect: (roleId, options) => query(() => services.roleMenu.queries.listBusinessDirect(scope, roleId, options)),
        getEffective: (roleId) => query(() => services.roleMenu.queries.getBusinessEffective(scope, roleId)),
        getAuthorizationTree: (roleId, options) => query(() => services.roleMenu.queries.getBusinessAuthorizationTree(scope, roleId, options)),
    };
    Object.freeze(menuPermissions);
    const roles: RoleManager = {
        menuPermissions,
        create: (input, options) => run(() => services.roles.create(scope, input, mergeOptionalOptions(options))),
        get: (roleId) => query(() => services.queries.getRole(scope, roleId)),
        list: (options) => query(() => services.queries.listRoles(scope, options)),
        update: (roleId, patch, options) => run(() => services.roles.update(scope, roleId, patch, mergeRequiredOptions(options))),
        previewAccessUpdate: (roleId, patch, options) => query(() => services.previews.previewAccessUpdate(scope, roleId, patch, mergeOptionalOptions(options))),
        executeAccessUpdate: (roleId, patch, options) => run(() => services.previews.executeAccessUpdate(scope, roleId, patch, mergeRequiredOptions(options))),
        getRemovalImpact: (roleId) => query(() => services.queries.getRemovalImpact(scope, roleId)),
        remove: (roleId, options) => run(() => services.roles.remove(scope, roleId, mergeRequiredOptions(options))),
        allow: (roleId, rule, options) => run(() => services.previews.allow(scope, roleId, rule, mergeOptionalOptions(options))),
        deny: (roleId, rule, options) => run(() => services.previews.deny(scope, roleId, rule, mergeOptionalOptions(options))),
        revoke: (roleId, selector, options) => run(() => services.previews.revoke(scope, roleId, selector, mergeOptionalOptions(options))),
        previewRuleChange: (roleId, change, options) => query(() => services.previews.previewRuleChange(scope, roleId, change, mergeOptionalOptions(options))),
        executeRuleChange: (roleId, change, options) => run(() => services.previews.executeRuleChange(scope, roleId, change, mergeRequiredOptions(options))),
        previewReplaceRules: (roleId, rules, options) => query(() => services.previews.previewReplaceRules(scope, roleId, rules, mergeOptionalOptions(options))),
        replaceRules: (roleId, rules, options) => run(() => services.previews.replaceRules(scope, roleId, rules, mergeRequiredOptions(options))),
        getOwnRules: (roleId) => query(() => services.queries.getOwnRules(scope, roleId)),
        listOwnRules: (roleId, options) => query(() => services.queries.listOwnRules(scope, roleId, options)),
        getEffectiveRules: (roleId) => query(() => services.queries.getEffectiveRules(scope, roleId)),
        getChain: (roleId) => query(() => services.queries.getChain(scope, roleId)),
    };
    Object.freeze(roles);
    const userRoles: UserRoleManager = {
        assign: (userId, roleId, options) => run(() => services.userRoles.assign(scope, userId, roleId, mergeOptionalOptions(options))),
        revoke: (userId, roleId, options) => run(() => services.userRoles.revoke(scope, userId, roleId, mergeOptionalOptions(options))),
        set: (userId, roleIds, options) => run(() => services.userRoles.set(scope, userId, roleIds, mergeRequiredOptions(options))),
        clear: (userId, options) => run(() => services.userRoles.clear(scope, userId, mergeRequiredOptions(options))),
        getDirect: (userId) => query(() => services.queries.getDirectUserRoles(scope, userId)),
        getEffective: (userId) => query(() => services.queries.getEffectiveUserRoles(scope, userId)),
        listUsersByRole: (roleId, options) => query(() => services.queries.listUsersByRole(scope, roleId, options)),
    };
    Object.freeze(userRoles);
    const config: ScopedPermissionContext["menus"]["config"] = {
        preview: (input, options) => query(() => services.menuManagement.config.preview(scope, input, mergeOptionalOptions(options))),
        save: (input, options) => run(() => services.menuManagement.config.save(scope, input, mergeRequiredOptions(options))),
        get: (configId) => query(() => services.menuManagement.config.get(scope, configId)),
        list: (options) => query(() => services.menuManagement.config.list(scope, options)),
        previewRemove: (configId, options) => query(() => services.menuManagement.config.previewRemove(scope, configId, mergeOptionalOptions(options))),
        remove: (configId, options) => run(() => services.menuManagement.config.remove(scope, configId, mergeRequiredOptions(options))),
        previewChanges: (changes, options) => query(() => services.menuManagement.config.previewChanges(scope, changes, mergeOptionalOptions(options))),
        applyChanges: (changes, options) => run(() => services.menuManagement.config.applyChanges(scope, changes, mergeRequiredOptions(options))),
    };
    Object.freeze(config);
    const management: ScopedPermissionContext["menus"]["management"] = {
        previewChanges: (configId, changes, options) => query(() =>
            services.menuManagement.config.previewManagementChanges(scope, configId, changes, mergeOptionalOptions(options))),
        applyChanges: (configId, changes, options) => run(() =>
            services.menuManagement.config.applyManagementChanges(scope, configId, changes, mergeOptionalOptions(options))),
    };
    Object.freeze(management);
    const configs: ScopedPermissionContext["menus"]["configs"] = {
        previewCreate: (input, options) => management.previewChanges(input.configId, [{ operation: "config.create", input }], options),
        create: (input, options) => management.applyChanges(input.configId, [{ operation: "config.create", input }], options),
        previewUpdate: (configId, patch, options) => management.previewChanges(configId, [{ operation: "config.update", patch }], options),
        update: (configId, patch, options) => management.applyChanges(configId, [{ operation: "config.update", patch }], options),
        get: (configId) => config.get(configId),
        list: (options) => config.list(options),
        previewRemove: (configId, input, options) => management.previewChanges(configId, [{ operation: "config.remove", ...(input === undefined ? {} : { input }) }], options),
        remove: (configId, input, options) => management.applyChanges(configId, [{ operation: "config.remove", ...(input === undefined ? {} : { input }) }], options),
    };
    Object.freeze(configs);
    const items: ScopedPermissionContext["menus"]["items"] = {
        previewCreate: (configId, input, options) => management.previewChanges(configId, [{ operation: "menu.create", input }], options),
        create: (configId, input, options) => management.applyChanges(configId, [{ operation: "menu.create", input }], options),
        previewUpdate: (configId, menuId, patch, options) => management.previewChanges(configId, [{ operation: "menu.update", menuId, patch }], options),
        update: (configId, menuId, patch, options) => management.applyChanges(configId, [{ operation: "menu.update", menuId, patch }], options),
        previewRemove: (configId, menuId, input, options) => management.previewChanges(configId, [{ operation: "menu.remove", menuId, ...(input === undefined ? {} : { input }) }], options),
        remove: (configId, menuId, input, options) => management.applyChanges(configId, [{ operation: "menu.remove", menuId, ...(input === undefined ? {} : { input }) }], options),
    };
    Object.freeze(items);
    const views: ScopedPermissionContext["menus"]["views"] = {
        previewCreate: (configId, menuId, input, options) => management.previewChanges(configId, [{ operation: "view.create", menuId, input }], options),
        create: (configId, menuId, input, options) => management.applyChanges(configId, [{ operation: "view.create", menuId, input }], options),
        previewUpdate: (configId, viewId, patch, options) => management.previewChanges(configId, [{ operation: "view.update", viewId, patch }], options),
        update: (configId, viewId, patch, options) => management.applyChanges(configId, [{ operation: "view.update", viewId, patch }], options),
        previewRemove: (configId, viewId, input, options) => management.previewChanges(configId, [{ operation: "view.remove", viewId, ...(input === undefined ? {} : { input }) }], options),
        remove: (configId, viewId, input, options) => management.applyChanges(configId, [{ operation: "view.remove", viewId, ...(input === undefined ? {} : { input }) }], options),
    };
    Object.freeze(views);
    const loadApis: ScopedPermissionContext["menus"]["loadApis"] = {
        previewAdd: (configId, viewId, input, options) => management.previewChanges(configId, [{ operation: "loadApi.add", viewId, input }], options),
        add: (configId, viewId, input, options) => management.applyChanges(configId, [{ operation: "loadApi.add", viewId, input }], options),
        previewUpdate: (configId, viewId, resource, patch, options) => management.previewChanges(configId, [{ operation: "loadApi.update", viewId, resource, patch }], options),
        update: (configId, viewId, resource, patch, options) => management.applyChanges(configId, [{ operation: "loadApi.update", viewId, resource, patch }], options),
        previewRemove: (configId, viewId, resource, input, options) => management.previewChanges(configId, [{ operation: "loadApi.remove", viewId, resource, ...(input === undefined ? {} : { input }) }], options),
        remove: (configId, viewId, resource, input, options) => management.applyChanges(configId, [{ operation: "loadApi.remove", viewId, resource, ...(input === undefined ? {} : { input }) }], options),
    };
    Object.freeze(loadApis);
    const actions: ScopedPermissionContext["menus"]["actions"] = {
        previewCreate: (configId, viewId, input, options) => management.previewChanges(configId, [{ operation: "action.create", viewId, input }], options),
        create: (configId, viewId, input, options) => management.applyChanges(configId, [{ operation: "action.create", viewId, input }], options),
        previewUpdate: (configId, viewId, actionId, patch, options) => management.previewChanges(configId, [{ operation: "action.update", viewId, actionId, patch }], options),
        update: (configId, viewId, actionId, patch, options) => management.applyChanges(configId, [{ operation: "action.update", viewId, actionId, patch }], options),
        previewRemove: (configId, viewId, actionId, input, options) => management.previewChanges(configId, [{ operation: "action.remove", viewId, actionId, ...(input === undefined ? {} : { input }) }], options),
        remove: (configId, viewId, actionId, input, options) => management.applyChanges(configId, [{ operation: "action.remove", viewId, actionId, ...(input === undefined ? {} : { input }) }], options),
    };
    Object.freeze(actions);
    const responses: ScopedPermissionContext["menus"]["responses"] = {
        previewSet: (configId, input, options) => management.previewChanges(configId, [{ operation: "response.set", input }], options),
        set: (configId, input, options) => management.applyChanges(configId, [{ operation: "response.set", input }], options),
        previewRemove: (configId, input, options) => management.previewChanges(configId, [{ operation: "response.remove", input }], options),
        remove: (configId, input, options) => management.applyChanges(configId, [{ operation: "response.remove", input }], options),
    };
    Object.freeze(responses);
    const menus = Object.freeze({ config, management, configs, items, views, loadApis, actions, responses });
    const facade = { roles, userRoles, menus } as ScopedPermissionContext;
    Object.defineProperty(facade, "withDefaults", {
        value: withDefaults,
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return Object.freeze(facade);
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
    const getVisibleTree = async (options?: { rootId?: string }) => {
        const rootId = normalizedTreeRootId(options);
        const loaded = await menuRuntime();
        const cached = semanticCache === undefined
            ? undefined
            : await semanticCache.getMenuTree(subject, context, loaded.reader.state, rootId);
        if (cached !== undefined) return cached;
        const result = await loaded.runtime.getVisibleTree(options);
        if (semanticCache !== undefined) {
            const filled = await semanticCache.setMenuTree(subject, context, loaded.reader.state, rootId, result);
            if (filled) await retainCacheFillOnlyWhileCurrent(semanticCache, subject, loaded.reader);
        }
        return result;
    };
    const getButtonMap = async (ownerNodeIdInput: string) => {
        const ownerNodeId = normalizeRbacId(ownerNodeIdInput, "ownerNodeId");
        const loaded = await menuRuntime();
        const cached = semanticCache === undefined
            ? undefined
            : await semanticCache.getButtonMap(subject, context, loaded.reader.state, ownerNodeId);
        if (cached !== undefined) return cached;
        const result = await loaded.runtime.getButtonMap(ownerNodeId);
        if (semanticCache !== undefined) {
            const filled = await semanticCache.setButtonMap(subject, context, loaded.reader.state, ownerNodeId, result);
            if (filled) await retainCacheFillOnlyWhileCurrent(semanticCache, subject, loaded.reader);
        }
        return result;
    };
    const getRouteState = async (pathInput: string) => {
        const path = normalizedRoutePath(pathInput);
        const loaded = await menuRuntime();
        const cached = semanticCache === undefined
            ? undefined
            : await semanticCache.getRouteState(subject, context, loaded.reader.state, path);
        if (cached !== undefined) return cached;
        const result = await loaded.runtime.getRouteState(path);
        if (semanticCache !== undefined) {
            const filled = await semanticCache.setRouteState(subject, context, loaded.reader.state, path, result);
            if (filled) await retainCacheFillOnlyWhileCurrent(semanticCache, subject, loaded.reader);
        }
        return result;
    };
    const menus = Object.freeze({
        getViewTree: (options: { configId: string }) => run(async () => (await menuRuntime()).runtime.getViewTree(options)),
        getActionMap: (input: { configId: string; viewId: string }) => run(async () => (await menuRuntime()).runtime.getActionMap(input)),
        getViewState: (input: { configId: string; viewId: string } | { path: string }) => run(async () => (await menuRuntime()).runtime.getViewState(input)),
        filterResponse: (apiResource: ApiResource, payload: unknown) => run(async () => (await menuRuntime()).runtime.filterResponse(apiResource, payload)),
        getVisibleTree: (options?: { rootId?: string }) => run(() => getVisibleTree(options)),
        getButtonMap: (ownerNodeId: string) => run(() => getButtonMap(ownerNodeId)),
        getRouteState: (path: string) => run(() => getRouteState(path)),
    }) as SubjectMenuRuntime;
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
