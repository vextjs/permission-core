import type {
    ActionPermissionState,
    ApiResource,
    BoundedDetails,
    ButtonPermissionState,
    MenuRuntimeApiRisk,
    RoutePermissionState,
    SubjectRuntimeResult,
    VisibleMenuTreeNode,
    ViewPermissionState,
    ViewTreeNode,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../persistence/documents";
import type { PermissionRepository } from "../persistence/repository";
import type { SubjectAuthorizationRuntime } from "../rbac/runtime";
import {
    DetailBudgetAllocator,
    assertAuthorizationResponseBudget,
} from "../rbac/result";
import type { RbacScopeReader } from "../rbac/store";
import { normalizeRbacId } from "../rbac/validation";
import {
    evaluateApiBindingAvailability,
    evaluateOwnerApiAvailability,
    type ApiBindingAvailabilityDecision,
    type OwnerApiAvailabilityDecision,
} from "./availability";
import { validateMenuGraph } from "./queries";
import { MAX_MENU_TREE_NODES, MenuScopeReader } from "./store";
import { exactMenuRecord, normalizeDeclaredPath } from "./validation";
import {
    aggregateCompiledMenuConfigs,
} from "./config-aggregate";
import {
    compileMenuConfigSnapshot,
    type CompiledMenuConfig,
    type CompiledResponseDefinition,
} from "./config-compiler";
import { readScopedMenuConfigDocuments } from "./config-service";

const MAX_BUTTONS_PER_OWNER = 1_000;
const BUTTON_CODE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const FORBIDDEN_BUTTON_CODES = new Set(["__proto__", "prototype", "constructor"]);

type MenuGraph = ReturnType<typeof validateMenuGraph>;
type RuntimeOwnerType = "menu" | "page" | "button";
type CompleteVisibleNode = Omit<VisibleMenuTreeNode, "children"> & {
    children: VisibleMenuTreeNode[];
};

interface SubjectMenuSnapshot {
    readonly nodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly graph: MenuGraph;
    readonly nodesByPath: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>;
    readonly bindingsByOwner: ReadonlyMap<string, readonly Readonly<InternalApiBindingDocument>[]>;
    readonly configById: ReadonlyMap<string, CompiledMenuConfig>;
    readonly responsesByApi: ReadonlyMap<ApiResource, readonly CompiledResponseDefinition[]>;
}

interface BusinessGrantFieldState {
    readonly effect: "allow" | "deny";
    readonly apiResource: ApiResource;
    readonly targetDigest: string;
    readonly field: string;
    readonly roleId: string;
    readonly depth: number;
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted subject menu state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function hasInvalidMenuCodeCause(error: unknown) {
    let current = error;
    for (let depth = 0; depth < 6; depth += 1) {
        if (current === null || typeof current !== "object") return false;
        if (
            current instanceof PermissionCoreError
            && current.details?.kind === "validation"
            && current.details.field === "menu.code"
        ) {
            return true;
        }
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

function limitExceeded(limitName: string, current: number, max: number): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", "The subject menu response exceeds its model limit.", {
        details: {
            kind: "limit-exceeded",
            origin: "persisted-authorization-state",
            limitName,
            current,
            max,
            unit: "items",
        },
    });
}

function completeDetails<T>(items: readonly T[]): BoundedDetails<T> {
    const complete = [...items];
    return deepFreeze({
        total: complete.length,
        items: complete,
        truncated: false,
        digest: digestCanonical(complete),
    });
}

function ownerKey(type: RuntimeOwnerType, id: string) {
    return `${type}\u0000${id}`;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(value: unknown, path: string): unknown {
    let current = value;
    for (const segment of path.split(".")) {
        if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) return undefined;
        current = current[segment];
    }
    return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
    const segments = path.split(".");
    let current = target;
    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index]!;
        const next = current[segment];
        if (!isPlainRecord(next)) {
            const created: Record<string, unknown> = {};
            current[segment] = created;
            current = created;
        } else {
            current = next as Record<string, unknown>;
        }
    }
    current[segments[segments.length - 1]!] = value;
}

function pickFields(value: unknown, fields: ReadonlySet<string>): unknown {
    if (Array.isArray(value)) return value.map((item) => pickFields(item, fields));
    if (!isPlainRecord(value)) return null;
    const output: Record<string, unknown> = {};
    for (const field of [...fields].sort(compareUtf8)) {
        const fieldValue = getPath(value, field);
        if (fieldValue !== undefined) setPath(output, field, fieldValue);
    }
    return output;
}

function clonePreserved(payload: unknown, preserve: readonly string[]) {
    const output: Record<string, unknown> = {};
    for (const path of preserve) {
        const value = getPath(payload, path);
        if (value !== undefined) setPath(output, path, value);
    }
    return output;
}

function mergeProjected(target: Record<string, unknown>, patch: unknown) {
    if (!isPlainRecord(patch)) return;
    for (const [key, value] of Object.entries(patch)) target[key] = value;
}

function projectResponseTarget(
    payload: unknown,
    response: CompiledResponseDefinition,
    allowed: ReadonlySet<string>,
) {
    if (response.target === undefined) return pickFields(payload, allowed);
    const output = clonePreserved(payload, response.preserve);
    const targetValue = getPath(payload, response.target);
    setPath(output, response.target, pickFields(targetValue, allowed));
    return output;
}

function runtimeOwnerType(node: Readonly<InternalMenuNodeDocument>): RuntimeOwnerType | null {
    return node.type === "menu" || node.type === "page" || node.type === "button"
        ? node.type
        : null;
}

function assertButtonCode(code: unknown): asserts code is string {
    if (typeof code !== "string" || !BUTTON_CODE.test(code) || FORBIDDEN_BUTTON_CODES.has(code)) {
        persistedInvalid("invalid-menu-code");
    }
}

function navigationNodeBase(
    node: Readonly<InternalMenuNodeDocument>,
    availability: OwnerApiAvailabilityDecision,
): Omit<VisibleMenuTreeNode, "children"> {
    if (node.type === "button") persistedInvalid("button entered the visible navigation projection");
    return {
        id: node.nodeId,
        parentId: node.parentId,
        type: node.type,
        title: node.title,
        ...(node.path === undefined ? {} : { path: node.path }),
        ...(node.name === undefined ? {} : { name: node.name }),
        ...(node.component === undefined ? {} : { component: node.component }),
        ...(node.url === undefined ? {} : { url: node.url }),
        ...(node.icon === undefined ? {} : { icon: node.icon }),
        order: node.order,
        ...(node.i18nKey === undefined ? {} : { i18nKey: node.i18nKey }),
        ...(node.meta === undefined ? {} : { meta: node.meta }),
        ...(node.permission === undefined ? {} : { permission: node.permission }),
        visible: true,
        enabled: availability.enabled,
        reason: availability.enabled ? "allowed" : "api-unavailable",
        apiRisks: completeDetails(availability.risks),
    };
}

export class SubjectMenuAuthorizationRuntime {
    private snapshotPromise?: Promise<SubjectMenuSnapshot>;
    private businessFieldStatePromise?: Promise<readonly BusinessGrantFieldState[]>;
    private readonly permissionDecisions = new Map<string, Promise<boolean>>();
    private readonly bindingDecisions = new Map<string, Promise<boolean>>();
    private readonly ownerDecisions = new Map<string, Promise<OwnerApiAvailabilityDecision>>();

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly rbacReader: RbacScopeReader,
        private readonly authorization: SubjectAuthorizationRuntime,
    ) {}

    private loadSnapshot() {
        if (!this.snapshotPromise) {
            this.snapshotPromise = (async () => {
                await this.authorization.ensurePolicyContextComplete();
                const reader = new MenuScopeReader(
                    this.repository,
                    this.schemes,
                    this.rbacReader.state,
                    this.rbacReader.databaseSession(),
                );
                let inventory;
                try {
                    inventory = await reader.readCompleteInventory();
                } catch (error) {
                    if (hasInvalidMenuCodeCause(error)) persistedInvalid("invalid-menu-code");
                    throw error;
                }
                const configDocuments = await readScopedMenuConfigDocuments(this.repository, this.schemes, reader, this.rbacReader.databaseSession());
                const compiledConfigs = configDocuments.map((document) => compileMenuConfigSnapshot(document.config, this.schemes));
                const responseDefinitions = compiledConfigs.length === 0
                    ? []
                    : aggregateCompiledMenuConfigs(compiledConfigs, this.schemes).responseDefinitions;
                const mutableResponsesByApi = new Map<ApiResource, CompiledResponseDefinition[]>();
                for (const response of responseDefinitions) {
                    const group = mutableResponsesByApi.get(response.apiResource) ?? [];
                    group.push(response);
                    mutableResponsesByApi.set(response.apiResource, group);
                }
                const responsesByApi = new Map<ApiResource, readonly CompiledResponseDefinition[]>();
                for (const [apiResource, responses] of mutableResponsesByApi) {
                    responses.sort((left, right) => compareUtf8(left.targetDigest, right.targetDigest));
                    responsesByApi.set(apiResource, Object.freeze(responses));
                }
                const graph = validateMenuGraph(inventory.nodes);
                const nodesByPath = new Map<string, Readonly<InternalMenuNodeDocument>>();
                for (const node of inventory.nodes) {
                    if (node.path === undefined) continue;
                    if (nodesByPath.has(node.path)) persistedInvalid("duplicate declared menu path");
                    nodesByPath.set(node.path, node);
                }
                const mutableBindings = new Map<string, Readonly<InternalApiBindingDocument>[]>();
                for (const binding of inventory.bindings) {
                    for (const owner of binding.owners) {
                        const key = ownerKey(owner.type, owner.id);
                        const group = mutableBindings.get(key) ?? [];
                        group.push(binding);
                        mutableBindings.set(key, group);
                    }
                }
                const bindingsByOwner = new Map<string, readonly Readonly<InternalApiBindingDocument>[]>();
                for (const [key, bindings] of mutableBindings) {
                    bindings.sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
                    bindingsByOwner.set(key, Object.freeze(bindings));
                }
                await reader.verifyMenuAuthorizationUnchanged();
                return Object.freeze({
                    nodes: inventory.nodes,
                    graph,
                    nodesByPath,
                    bindingsByOwner,
                    configById: new Map(compiledConfigs.map((config) => [config.configId, config] as const)),
                    responsesByApi,
                });
            })();
        }
        return this.snapshotPromise;
    }

    private checkPermission(action: string, resource: string) {
        const key = canonicalString({ action, resource });
        let decision = this.permissionDecisions.get(key);
        if (!decision) {
            decision = this.authorization.can(action, resource);
            this.permissionDecisions.set(key, decision);
        }
        return decision;
    }

    private permissionAllowed(node: Readonly<InternalMenuNodeDocument>) {
        if (node.permission === undefined) {
            if (node.type !== "directory") persistedInvalid(`menu node ${node.nodeId} is missing its permission requirement`);
            return Promise.resolve(true);
        }
        return this.checkPermission(node.permission.action, node.permission.resource);
    }

    private bindingAllowed(binding: Readonly<InternalApiBindingDocument>) {
        let decision = this.bindingDecisions.get(binding.bindingId);
        if (!decision) {
            decision = evaluateApiBindingAvailability(
                { status: binding.status, authorization: binding.authorization },
                (permission) => this.checkPermission(permission.action, permission.resource),
            );
            this.bindingDecisions.set(binding.bindingId, decision);
        }
        return decision;
    }

    private ownerAvailability(
        snapshot: SubjectMenuSnapshot,
        node: Readonly<InternalMenuNodeDocument>,
    ): Promise<OwnerApiAvailabilityDecision> {
        const type = runtimeOwnerType(node);
        if (type === null) return Promise.resolve(deepFreeze({ enabled: true, risks: [] }));
        return this.ownerAvailabilityByOwner(snapshot, type, node.nodeId);
    }

    private ownerAvailabilityByOwner(
        snapshot: SubjectMenuSnapshot,
        type: RuntimeOwnerType,
        id: string,
    ): Promise<OwnerApiAvailabilityDecision> {
        const key = ownerKey(type, id);
        let decision = this.ownerDecisions.get(key);
        if (!decision) {
            decision = (async () => {
                const bindings = snapshot.bindingsByOwner.get(key) ?? [];
                const bindingDecisions: ApiBindingAvailabilityDecision[] = [];
                for (const binding of bindings) {
                    bindingDecisions.push({
                        binding: {
                            id: binding.bindingId,
                            owners: binding.owners.map((owner) => ({ ...owner })),
                        },
                        allowed: await this.bindingAllowed(binding),
                    });
                }
                return evaluateOwnerApiAvailability({ type, id }, bindingDecisions);
            })();
            this.ownerDecisions.set(key, decision);
        }
        return decision;
    }

    private async visibleNode(
        snapshot: SubjectMenuSnapshot,
        node: Readonly<InternalMenuNodeDocument>,
    ) {
        if (node.type === "button" || node.status !== "enabled" || node.hidden) return null;
        if (!(await this.permissionAllowed(node))) return null;
        const availability = await this.ownerAvailability(snapshot, node);
        return navigationNodeBase(node, availability);
    }

    private requireConfig(snapshot: SubjectMenuSnapshot, configIdInput: unknown) {
        const configId = normalizeRbacId(configIdInput, "configId");
        const config = snapshot.configById.get(configId);
        if (config === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu config ${configId} was not found.`);
        return config;
    }

    private compiledNodePermission(config: CompiledMenuConfig, nodeId: string) {
        return config.nodes.find((node) => node.id === nodeId)?.permission;
    }

    private async compiledNodeAllowed(config: CompiledMenuConfig, nodeId: string) {
        const permission = this.compiledNodePermission(config, nodeId);
        return permission === undefined
            ? true
            : this.checkPermission(permission.action, permission.resource);
    }

    private allViews(config: CompiledMenuConfig) {
        const views: {
            readonly menu: CompiledMenuConfig["snapshot"]["menus"][number];
            readonly view: CompiledMenuConfig["snapshot"]["menus"][number]["views"][number];
        }[] = [];
        const visit = (menu: CompiledMenuConfig["snapshot"]["menus"][number]) => {
            for (const view of menu.views) views.push({ menu, view });
            for (const child of menu.children) visit(child);
        };
        for (const menu of config.snapshot.menus) visit(menu);
        return views;
    }

    private findView(config: CompiledMenuConfig, viewId: string) {
        return this.allViews(config).find((entry) => entry.view.id === viewId);
    }

    private async viewDecision(
        snapshot: SubjectMenuSnapshot,
        config: CompiledMenuConfig,
        viewId: string,
    ): Promise<{
        readonly allowed: boolean;
        readonly reason: ViewPermissionState["reason"];
        readonly view?: CompiledMenuConfig["snapshot"]["menus"][number]["views"][number];
        readonly menu?: CompiledMenuConfig["snapshot"]["menus"][number];
    }> {
        const found = this.findView(config, viewId);
        if (found === undefined) return { allowed: false, reason: "not-found" };
        const ref = config.viewIndex.get(viewId);
        if (ref === undefined) return { allowed: false, reason: "not-found" };
        if (!found.view.enabled) return { allowed: false, reason: "disabled", view: found.view, menu: found.menu };
        if (!(await this.compiledNodeAllowed(config, ref.nodeId))) {
            return { allowed: false, reason: "permission-denied", view: found.view, menu: found.menu };
        }
        const availability = await this.ownerAvailabilityByOwner(snapshot, "page", ref.apiOwnerNodeId);
        if (!availability.enabled) return { allowed: false, reason: "load-unavailable", view: found.view, menu: found.menu };
        return { allowed: true, reason: "allowed", view: found.view, menu: found.menu };
    }

    private async menuNavigationAllowed(config: CompiledMenuConfig, menu: CompiledMenuConfig["snapshot"]["menus"][number]) {
        const ref = config.menuIndex.get(menu.id);
        return ref === undefined ? false : this.compiledNodeAllowed(config, ref.nodeId);
    }

    private async navigationReason(
        config: CompiledMenuConfig,
        view: CompiledMenuConfig["snapshot"]["menus"][number]["views"][number],
    ): Promise<ViewPermissionState["navigationReason"]> {
        if (!view.navigation) return "navigation-disabled";
        const ancestors: CompiledMenuConfig["snapshot"]["menus"][number][] = [];
        const visit = (menus: readonly CompiledMenuConfig["snapshot"]["menus"][number][], stack: CompiledMenuConfig["snapshot"]["menus"][number][]): boolean => {
            for (const menu of menus) {
                if (menu.views.some((candidate) => candidate.id === view.id)) {
                    ancestors.push(...stack, menu);
                    return true;
                }
                if (visit(menu.children, [...stack, menu])) return true;
            }
            return false;
        };
        visit(config.snapshot.menus, []);
        for (const menu of ancestors) {
            if (!menu.enabled || !menu.navigation) return "disabled-ancestor";
            if (!(await this.menuNavigationAllowed(config, menu))) return "permission-denied-ancestor";
        }
        return "reachable";
    }

    async getViewTree(optionsInput: { configId: string }): Promise<SubjectRuntimeResult<readonly ViewTreeNode[]>> {
        const options = exactMenuRecord(optionsInput, ["configId"], "options");
        const snapshot = await this.loadSnapshot();
        const config = this.requireConfig(snapshot, options.configId);
        const buildView = async (view: CompiledMenuConfig["snapshot"]["menus"][number]["views"][number]): Promise<ViewTreeNode | null> => {
            if (view.type === "tab" || view.type === "dialog" || view.type === "drawer" || !view.navigation) return null;
            const decision = await this.viewDecision(snapshot, config, view.id);
            if (decision.reason === "permission-denied" || decision.reason === "not-found") return null;
            return deepFreeze({
                id: view.id,
                type: view.type,
                title: view.title,
                ...(view.path === undefined ? {} : { path: view.path }),
                ...(view.component === undefined ? {} : { component: view.component }),
                ...(view.url === undefined ? {} : { url: view.url }),
                ...(view.i18nKey === undefined ? {} : { i18nKey: view.i18nKey }),
                ...(view.meta === undefined ? {} : { meta: view.meta }),
                enabled: decision.reason === "allowed",
                reason: decision.reason === "allowed" ? "allowed" as const
                    : decision.reason === "load-unavailable" ? "load-unavailable" as const : "disabled" as const,
                children: Object.freeze([]),
            });
        };
        const buildMenu = async (menu: CompiledMenuConfig["snapshot"]["menus"][number]): Promise<ViewTreeNode | null> => {
            const childMenus: ViewTreeNode[] = [];
            for (const child of menu.children) {
                const node = await buildMenu(child);
                if (node !== null) childMenus.push(node);
            }
            const views: ViewTreeNode[] = [];
            for (const view of menu.views) {
                const node = await buildView(view);
                if (node !== null) views.push(node);
            }
            const children = Object.freeze([...childMenus, ...views]);
            if (!menu.navigation || !menu.enabled || !(await this.menuNavigationAllowed(config, menu))) {
                return children.length === 0 ? null : deepFreeze({
                    id: menu.id,
                    type: "menu" as const,
                    title: menu.title,
                    ...(menu.icon === undefined ? {} : { icon: menu.icon }),
                    ...(menu.i18nKey === undefined ? {} : { i18nKey: menu.i18nKey }),
                    ...(menu.meta === undefined ? {} : { meta: menu.meta }),
                    enabled: false,
                    reason: "disabled" as const,
                    children,
                });
            }
            if (children.length === 0) return null;
            return deepFreeze({
                id: menu.id,
                type: "menu" as const,
                title: menu.title,
                ...(menu.icon === undefined ? {} : { icon: menu.icon }),
                ...(menu.i18nKey === undefined ? {} : { i18nKey: menu.i18nKey }),
                ...(menu.meta === undefined ? {} : { meta: menu.meta }),
                enabled: true,
                reason: "allowed" as const,
                children,
            });
        };
        const nodes: ViewTreeNode[] = [];
        for (const menu of config.snapshot.menus) {
            const node = await buildMenu(menu);
            if (node !== null) nodes.push(node);
        }
        const data = deepFreeze(nodes);
        const detailBudget = new DetailBudgetAllocator().finish(data);
        const result = deepFreeze({ data, detailBudget });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async getActionMap(
        inputValue: { configId: string; viewId: string },
    ): Promise<SubjectRuntimeResult<Readonly<Record<string, ActionPermissionState>>>> {
        const input = exactMenuRecord(inputValue, ["configId", "viewId"], "input");
        const snapshot = await this.loadSnapshot();
        const config = this.requireConfig(snapshot, input.configId);
        const viewId = normalizeRbacId(input.viewId, "input.viewId");
        const found = this.findView(config, viewId);
        if (found === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `View ${viewId} was not found.`);
        const data: Record<string, ActionPermissionState> = {};
        for (const action of [...found.view.actions].sort((left, right) => compareUtf8(left.actionId, right.actionId))) {
            const ref = config.actionIndex.get(canonicalString([found.view.id, action.resource]));
            const permissionAllowed = ref === undefined ? false : await this.compiledNodeAllowed(config, ref.nodeId);
            const availability = ref !== undefined && action.resource.startsWith("api:")
                ? await this.ownerAvailabilityByOwner(snapshot, "button", ref.nodeId)
                : deepFreeze({ enabled: true, risks: [] });
            const target = action.opens === undefined
                ? null
                : await this.viewDecision(snapshot, config, action.opens);
            const reason: ActionPermissionState["reason"] = action.enabled === false
                ? "disabled"
                : !permissionAllowed ? "permission-denied"
                    : target !== null && !target.allowed ? "target-denied"
                        : !availability.enabled ? "load-unavailable" : "allowed";
            data[action.actionId] = deepFreeze({
                visible: reason === "allowed" || reason === "load-unavailable",
                enabled: reason === "allowed",
                reason,
                resource: action.resource,
                ...(action.opens === undefined ? {} : { opens: action.opens }),
            });
        }
        deepFreeze(data);
        const detailBudget = new DetailBudgetAllocator().finish(data);
        const result = deepFreeze({ data, detailBudget });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async getViewState(inputValue: { configId: string; viewId: string } | { path: string }): Promise<SubjectRuntimeResult<ViewPermissionState>> {
        const input = exactMenuRecord(inputValue, ["configId", "viewId", "path"], "input");
        const snapshot = await this.loadSnapshot();
        let config: CompiledMenuConfig | undefined;
        let viewId: string | undefined;
        let path: string | undefined;
        if (Object.hasOwn(input, "path")) {
            path = normalizeDeclaredPath(input.path, "input.path");
            for (const candidate of snapshot.configById.values()) {
                const found = this.allViews(candidate).find((entry) => entry.view.path === path);
                if (found !== undefined) {
                    config = candidate;
                    viewId = found.view.id;
                    break;
                }
            }
        } else if (Object.hasOwn(input, "configId") && Object.hasOwn(input, "viewId")) {
            config = this.requireConfig(snapshot, input.configId);
            viewId = normalizeRbacId(input.viewId, "input.viewId");
        } else {
            throw validationError("INVALID_ARGUMENT", "input", "requires either path or configId and viewId");
        }
        if (config === undefined || viewId === undefined) {
            const data: ViewPermissionState = deepFreeze({
                allowed: false,
                ...(path === undefined ? {} : { path }),
                reason: "not-found",
                navigationReachable: false,
                navigationReason: "not-found",
            });
            const result = deepFreeze({ data, detailBudget: new DetailBudgetAllocator().finish(data) });
            assertAuthorizationResponseBudget(result);
            return result;
        }
        const decision = await this.viewDecision(snapshot, config, viewId);
        const navigationReason = decision.view === undefined
            ? "not-found"
            : await this.navigationReason(config, decision.view);
        const data: ViewPermissionState = deepFreeze({
            allowed: decision.allowed,
            viewId,
            configId: config.configId,
            ...(decision.view?.path === undefined ? {} : { path: decision.view.path }),
            reason: decision.reason,
            navigationReachable: decision.allowed && navigationReason === "reachable",
            navigationReason,
        });
        const result = deepFreeze({ data, detailBudget: new DetailBudgetAllocator().finish(data) });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    private loadBusinessFieldState() {
        if (!this.businessFieldStatePromise) {
            this.businessFieldStatePromise = (async () => {
                const state = await this.authorization.loadState();
                const roleIds = state.roles.filter((role) => role.included).map((role) => role.document.roleId);
                if (roleIds.length === 0) return Object.freeze([]) as readonly BusinessGrantFieldState[];
                const reader = new MenuScopeReader(
                    this.repository,
                    this.schemes,
                    this.rbacReader.state,
                    this.rbacReader.databaseSession(),
                );
                const grants = await reader.readGrantsForRoles(roleIds);
                const roleDepth = new Map(state.roles.map((role) => [role.document.roleId, role.depth] as const));
                const fields: BusinessGrantFieldState[] = [];
                for (const grant of grants) {
                    const business = grant.snapshot.business;
                    if (business === undefined) continue;
                    for (const field of business.responseFields) {
                        fields.push(deepFreeze({
                            effect: grant.effect,
                            apiResource: field.apiResource,
                            targetDigest: field.targetDigest,
                            field: field.field,
                            roleId: grant.roleId,
                            depth: roleDepth.get(grant.roleId) ?? 0,
                        }));
                    }
                }
                await reader.verifyMenuAuthorizationUnchanged();
                return Object.freeze(fields.sort((left, right) =>
                    left.depth - right.depth
                    || compareUtf8(left.roleId, right.roleId)
                    || compareUtf8(left.apiResource, right.apiResource)
                    || compareUtf8(left.field, right.field)));
            })();
        }
        return this.businessFieldStatePromise;
    }

    async filterResponse(apiResourceInput: ApiResource, payload: unknown): Promise<SubjectRuntimeResult<unknown>> {
        const apiResource = apiResourceInput;
        await this.authorization.assert("invoke", apiResource);
        const snapshot = await this.loadSnapshot();
        const responses = snapshot.responsesByApi.get(apiResource) ?? [];
        const fields = await this.loadBusinessFieldState();
        const relevantFields = fields.filter((field) => field.apiResource === apiResource);
        if (responses.length === 0) {
            const data = relevantFields.length === 0 ? payload : {};
            const result = deepFreeze({ data, detailBudget: new DetailBudgetAllocator().finish({ apiResource, mode: relevantFields.length === 0 ? "unconfigured" : "stale-response-grants" }) });
            assertAuthorizationResponseBudget(result);
            return result;
        }
        const projected: Record<string, unknown> = {};
        let rootProjection: unknown;
        const detailResponses = responses.map((response) => {
            const configuredFields = new Set(response.fields.map((field) => field.field));
            const denied = new Set(relevantFields
                .filter((field) => field.effect === "deny" && field.targetDigest === response.targetDigest)
                .map((field) => field.field)
                .filter((field) => configuredFields.has(field)));
            const allowed = new Set(relevantFields
                .filter((field) => field.effect === "allow" && field.targetDigest === response.targetDigest)
                .map((field) => field.field)
                .filter((field) => configuredFields.has(field) && !denied.has(field)));
            const partial = projectResponseTarget(payload, response, allowed);
            if (response.target === undefined && !isPlainRecord(partial)) rootProjection = partial;
            else mergeProjected(projected, partial);
            return {
                targetDigest: response.targetDigest,
                ...(response.target === undefined ? {} : { target: response.target }),
                allowed: [...allowed].sort(compareUtf8),
                denied: [...denied].sort(compareUtf8),
            };
        });
        const filtered = rootProjection === undefined ? projected : rootProjection;
        const data = deepFreeze(filtered);
        const detailBudget = new DetailBudgetAllocator().finish({
            apiResource,
            responses: detailResponses,
        });
        const result = deepFreeze({ data, detailBudget });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async getVisibleTree(optionsInput?: { rootId?: string }): Promise<SubjectRuntimeResult<VisibleMenuTreeNode[]>> {
        const options = exactMenuRecord(optionsInput ?? {}, ["rootId"], "options");
        const rootId = Object.hasOwn(options, "rootId")
            ? normalizeRbacId(options.rootId, "options.rootId")
            : undefined;
        const snapshot = await this.loadSnapshot();
        const root = rootId === undefined ? undefined : snapshot.graph.nodes.get(rootId);
        if (rootId !== undefined && root === undefined) {
            throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${rootId} was not found.`);
        }
        if (root?.type === "button") {
            throw validationError("INVALID_ARGUMENT", "options.rootId", "must reference a navigation node");
        }
        const roots = root === undefined ? snapshot.graph.children.get(null) ?? [] : [root];
        const candidates = new Map<string, {
            document: Readonly<InternalMenuNodeDocument>;
            base: Omit<VisibleMenuTreeNode, "children">;
        }>();
        const stack = [...roots].reverse();
        while (stack.length > 0) {
            const node = stack.pop()!;
            const base = await this.visibleNode(snapshot, node);
            if (base === null) continue;
            candidates.set(node.nodeId, { document: node, base });
            const children = snapshot.graph.children.get(node.nodeId) ?? [];
            for (let index = children.length - 1; index >= 0; index -= 1) {
                if (children[index]!.type !== "button") stack.push(children[index]!);
            }
        }

        const kept = new Set<string>();
        const deepestFirst = [...candidates.values()].sort((left, right) => (
            snapshot.graph.depths.get(right.document.nodeId)! - snapshot.graph.depths.get(left.document.nodeId)!
            || compareUtf8(left.document.nodeId, right.document.nodeId)
        ));
        for (const candidate of deepestFirst) {
            const hasVisibleChild = (snapshot.graph.children.get(candidate.document.nodeId) ?? [])
                .some((child) => kept.has(child.nodeId));
            if (
                candidate.document.type !== "directory"
                || candidate.document.permission !== undefined
                || hasVisibleChild
            ) {
                kept.add(candidate.document.nodeId);
            }
        }

        const startNodes = roots.filter((node) => kept.has(node.nodeId));
        const orderedIds: string[] = [];
        const orderedStack = [...startNodes].reverse();
        while (orderedStack.length > 0) {
            const node = orderedStack.pop()!;
            orderedIds.push(node.nodeId);
            const children = snapshot.graph.children.get(node.nodeId) ?? [];
            for (let index = children.length - 1; index >= 0; index -= 1) {
                if (kept.has(children[index]!.nodeId)) orderedStack.push(children[index]!);
            }
        }
        if (orderedIds.length > MAX_MENU_TREE_NODES) {
            limitExceeded("subject-menu-tree-nodes", orderedIds.length, MAX_MENU_TREE_NODES);
        }

        const budget = new DetailBudgetAllocator();
        const completeById = new Map<string, CompleteVisibleNode>();
        const projectedById = new Map<string, CompleteVisibleNode>();
        for (const nodeId of orderedIds) {
            const base = candidates.get(nodeId)!.base;
            completeById.set(nodeId, { ...base, children: [] });
            projectedById.set(nodeId, {
                ...base,
                apiRisks: budget.bounded(base.apiRisks.items),
                children: [],
            });
        }
        for (const nodeId of orderedIds) {
            const document = candidates.get(nodeId)!.document;
            if (document.parentId === null || !kept.has(document.parentId)) continue;
            completeById.get(document.parentId)!.children.push(completeById.get(nodeId)!);
            projectedById.get(document.parentId)!.children.push(projectedById.get(nodeId)!);
        }
        const completeData = deepFreeze(startNodes.map((node) => completeById.get(node.nodeId)!));
        const data = deepFreeze(startNodes.map((node) => projectedById.get(node.nodeId)!));
        const detailBudget = budget.finish(completeData);
        const result = deepFreeze({ data, detailBudget });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    async getButtonMap(
        ownerNodeIdInput: string,
    ): Promise<SubjectRuntimeResult<Readonly<Record<string, ButtonPermissionState>>>> {
        const ownerNodeId = normalizeRbacId(ownerNodeIdInput, "ownerNodeId");
        const snapshot = await this.loadSnapshot();
        const owner = snapshot.graph.nodes.get(ownerNodeId);
        if (owner === undefined) throw new PermissionCoreError("MENU_NOT_FOUND", `Menu node ${ownerNodeId} was not found.`);
        if (owner.type !== "menu" && owner.type !== "page") {
            throw validationError("INVALID_ARGUMENT", "ownerNodeId", "must reference a menu or page node");
        }
        const buttons = (snapshot.graph.children.get(ownerNodeId) ?? [])
            .filter((node) => node.type === "button")
            .map((node) => {
                assertButtonCode(node.code);
                return { node, code: node.code };
            })
            .sort((left, right) => compareUtf8(left.code, right.code));
        if (buttons.length > MAX_BUTTONS_PER_OWNER) {
            limitExceeded("subject-menu-buttons", buttons.length, MAX_BUTTONS_PER_OWNER);
        }

        const budget = new DetailBudgetAllocator();
        const internal = Object.create(null) as Record<string, {
            complete: ButtonPermissionState;
            projected: ButtonPermissionState;
        }>;
        for (const { node, code } of buttons) {
            if (node.permission === undefined) persistedInvalid(`button ${node.nodeId} is missing its permission requirement`);
            const availability = await this.ownerAvailability(snapshot, node);
            const permissionAllowed = node.status === "enabled" && !node.hidden
                ? await this.permissionAllowed(node)
                : false;
            const reason: ButtonPermissionState["reason"] = node.status !== "enabled"
                ? "disabled"
                : node.hidden ? "hidden"
                    : !permissionAllowed ? "permission-denied"
                        : !availability.enabled ? "api-unavailable" : "allowed";
            const complete: ButtonPermissionState = {
                visible: reason === "allowed" || reason === "api-unavailable",
                enabled: reason === "allowed",
                reason,
                action: node.permission.action,
                resource: node.permission.resource,
                apiRisks: completeDetails(availability.risks),
            };
            internal[code] = {
                complete,
                projected: {
                    ...complete,
                    apiRisks: budget.bounded(complete.apiRisks.items),
                },
            };
        }
        const completeData: Record<string, ButtonPermissionState> = {};
        const data: Record<string, ButtonPermissionState> = {};
        for (const { code } of buttons) {
            completeData[code] = internal[code]!.complete;
            data[code] = internal[code]!.projected;
        }
        deepFreeze(completeData);
        deepFreeze(data);
        const detailBudget = budget.finish(completeData);
        const result = deepFreeze({ data, detailBudget });
        assertAuthorizationResponseBudget(result);
        return result;
    }

    private async ancestorNavigationReason(
        snapshot: SubjectMenuSnapshot,
        target: Readonly<InternalMenuNodeDocument>,
    ): Promise<RoutePermissionState["navigationReason"]> {
        const ancestors: Readonly<InternalMenuNodeDocument>[] = [];
        let parentId = target.parentId;
        while (parentId !== null) {
            const parent = snapshot.graph.nodes.get(parentId);
            if (parent === undefined) persistedInvalid("route ancestor is missing");
            ancestors.push(parent);
            parentId = parent.parentId;
        }
        ancestors.reverse();
        for (const ancestor of ancestors) {
            if (ancestor.status !== "enabled") return "disabled-ancestor";
            if (ancestor.hidden) return "hidden-ancestor";
            if (!(await this.permissionAllowed(ancestor))) return "denied-ancestor";
        }
        return "reachable";
    }

    async getRouteState(pathInput: string): Promise<SubjectRuntimeResult<RoutePermissionState>> {
        const path = normalizeDeclaredPath(pathInput, "path");
        if (path !== pathInput) {
            throw validationError("INVALID_ARGUMENT", "path", "must be a canonical declared route path");
        }
        const snapshot = await this.loadSnapshot();
        const target = snapshot.nodesByPath.get(path);
        const budget = new DetailBudgetAllocator();
        if (target === undefined) {
            const data: RoutePermissionState = deepFreeze({
                allowed: false,
                reason: "not-found",
                apiRisks: budget.bounded([]),
                navigationReachable: false,
                navigationReason: "not-found",
            });
            const detailBudget = budget.finish(data);
            const result = deepFreeze({ data, detailBudget });
            assertAuthorizationResponseBudget(result);
            return result;
        }
        if (target.type === "button" || target.permission === undefined) {
            persistedInvalid(`declared route ${target.nodeId} is not a valid route-bearing node`);
        }
        const availability = await this.ownerAvailability(snapshot, target);
        const permissionAllowed = await this.permissionAllowed(target);
        const reason: RoutePermissionState["reason"] = target.status !== "enabled"
            ? "disabled"
            : !permissionAllowed ? "permission-denied"
                : !availability.enabled ? "api-unavailable" : "allowed";
        let navigationReason: RoutePermissionState["navigationReason"];
        if (reason !== "allowed") navigationReason = "self-unavailable";
        else if (target.hidden) navigationReason = "self-hidden";
        else navigationReason = await this.ancestorNavigationReason(snapshot, target);
        const completeData: RoutePermissionState = deepFreeze({
            allowed: reason === "allowed",
            reason,
            nodeId: target.nodeId,
            action: target.permission.action,
            resource: target.permission.resource,
            matchedPath: path,
            apiRisks: completeDetails(availability.risks),
            navigationReachable: navigationReason === "reachable",
            navigationReason,
        });
        const data: RoutePermissionState = deepFreeze({
            ...completeData,
            apiRisks: budget.bounded(completeData.apiRisks.items),
        });
        const detailBudget = budget.finish(completeData);
        const result = deepFreeze({ data, detailBudget });
        assertAuthorizationResponseBudget(result);
        return result;
    }
}
