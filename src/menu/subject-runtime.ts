import type {
    BoundedDetails,
    ButtonPermissionState,
    MenuRuntimeApiRisk,
    RoutePermissionState,
    SubjectRuntimeResult,
    VisibleMenuTreeNode,
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
        const key = ownerKey(type, node.nodeId);
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
                return evaluateOwnerApiAvailability({ type, id: node.nodeId }, bindingDecisions);
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
