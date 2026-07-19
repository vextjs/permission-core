import type { StaleReference } from "../types";
import { compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../persistence/documents";
import { MAX_MENU_DEPTH } from "./store";

export type StructuralStaleRecord = ParentStaleRecord | ApiOwnerStaleRecord;

export interface ParentStaleRecord {
    readonly kind: "parent";
    readonly reference: Readonly<StaleReference>;
    readonly node: Readonly<InternalMenuNodeDocument>;
}

export interface ApiOwnerStaleRecord {
    readonly kind: "api-owner";
    readonly reference: Readonly<StaleReference>;
    readonly binding: Readonly<InternalApiBindingDocument>;
    readonly owner: Readonly<InternalApiBindingDocument["owners"][number]>;
}

export function menuParentAllows(
    parentType: InternalMenuNodeDocument["type"],
    childType: InternalMenuNodeDocument["type"],
) {
    if (parentType === "directory") return childType !== "button";
    if (parentType === "menu") return childType !== "directory";
    if (parentType === "page") return childType === "button";
    return false;
}

function parentReferenceId(node: Readonly<InternalMenuNodeDocument>) {
    return `stale_parent_${digestCanonical({
        type: "parent",
        nodeId: node.nodeId,
        parentId: node.parentId,
    })}`;
}

function apiOwnerReferenceId(
    binding: Readonly<InternalApiBindingDocument>,
    owner: Readonly<InternalApiBindingDocument["owners"][number]>,
) {
    return `stale_api_owner_${digestCanonical({
        type: "api-owner",
        bindingId: binding.bindingId,
        ownerType: owner.type,
        ownerId: owner.id,
    })}`;
}

function cycleNodeIds(nodesById: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>) {
    const complete = new Set<string>();
    const cycles = new Set<string>();
    const orderedIds = [...nodesById.keys()].sort(compareUtf8);
    for (const startId of orderedIds) {
        if (complete.has(startId)) continue;
        const path: string[] = [];
        const positions = new Map<string, number>();
        let currentId: string | null = startId;
        while (currentId !== null && nodesById.has(currentId) && !complete.has(currentId)) {
            const position = positions.get(currentId);
            if (position !== undefined) {
                for (const nodeId of path.slice(position)) cycles.add(nodeId);
                break;
            }
            positions.set(currentId, path.length);
            path.push(currentId);
            currentId = nodesById.get(currentId)!.parentId;
        }
        for (const nodeId of path) complete.add(nodeId);
    }
    return cycles;
}

function validChainDepth(
    node: Readonly<InternalMenuNodeDocument>,
    nodesById: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>,
    depthByNodeId: Map<string, number | null>,
) {
    if (depthByNodeId.has(node.nodeId)) return depthByNodeId.get(node.nodeId)!;
    const path: Readonly<InternalMenuNodeDocument>[] = [];
    const positions = new Set<string>();
    let current: Readonly<InternalMenuNodeDocument> | undefined = node;
    let terminalDepth: number | null = null;
    while (current !== undefined) {
        if (depthByNodeId.has(current.nodeId)) {
            terminalDepth = depthByNodeId.get(current.nodeId)!;
            break;
        }
        if (positions.has(current.nodeId)) {
            terminalDepth = null;
            break;
        }
        positions.add(current.nodeId);
        path.push(current);
        if (current.parentId === null) {
            terminalDepth = current.type === "button" ? null : 0;
            break;
        }
        const parent = nodesById.get(current.parentId);
        if (parent === undefined || !menuParentAllows(parent.type, current.type)) {
            terminalDepth = null;
            break;
        }
        current = parent;
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
        const pathNode = path[index]!;
        if (terminalDepth !== null) terminalDepth += 1;
        depthByNodeId.set(pathNode.nodeId, terminalDepth);
    }
    return depthByNodeId.get(node.nodeId) ?? null;
}

function parentReason(
    node: Readonly<InternalMenuNodeDocument>,
    nodesById: ReadonlyMap<string, Readonly<InternalMenuNodeDocument>>,
    cycles: ReadonlySet<string>,
    depthByNodeId: Map<string, number | null>,
) {
    if (node.parentId === null) return node.type === "button" ? "button-root" : null;
    const parent = nodesById.get(node.parentId);
    if (parent === undefined) return "parent-missing";
    if (!menuParentAllows(parent.type, node.type)) return "parent-type-mismatch";
    if (cycles.has(node.nodeId)) return "parent-cycle";
    const depth = validChainDepth(node, nodesById, depthByNodeId);
    return depth !== null && depth > MAX_MENU_DEPTH ? "parent-depth-exceeded" : null;
}

export function collectStructuralStaleReferences(input: {
    readonly nodes: readonly Readonly<InternalMenuNodeDocument>[];
    readonly bindings: readonly Readonly<InternalApiBindingDocument>[];
}) {
    const nodesById = new Map(input.nodes.map((node) => [node.nodeId, node] as const));
    const cycles = cycleNodeIds(nodesById);
    const depthByNodeId = new Map<string, number | null>();
    const records: StructuralStaleRecord[] = [];

    for (const node of input.nodes) {
        const reason = parentReason(node, nodesById, cycles, depthByNodeId);
        if (reason === null) continue;
        records.push(deepFreeze({
            kind: "parent" as const,
            reference: {
                type: "parent" as const,
                id: parentReferenceId(node),
                assetId: node.nodeId,
                reason,
            },
            node,
        }));
    }

    for (const binding of input.bindings) {
        for (const owner of binding.owners) {
            const node = nodesById.get(owner.id);
            const reason = node === undefined
                ? "api-owner-missing"
                : node.type !== owner.type ? "api-owner-type-mismatch" : null;
            if (reason === null) continue;
            records.push(deepFreeze({
                kind: "api-owner" as const,
                reference: {
                    type: "api-owner" as const,
                    id: apiOwnerReferenceId(binding, owner),
                    assetId: binding.bindingId,
                    reason,
                },
                binding,
                owner,
            }));
        }
    }

    records.sort((left, right) =>
        compareUtf8(left.reference.type, right.reference.type)
        || compareUtf8(left.reference.id, right.reference.id));
    return Object.freeze(records);
}
