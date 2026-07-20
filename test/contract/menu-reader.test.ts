import { describe, expect, it, vi } from "vitest";
import type { AuthorizationCapacityAssessment, BoundedDetails, ManagementConflict } from "../../src/types";
import type { PermissionRepository } from "../../src/persistence/repository";
import type { ScopeStateView } from "../../src/persistence/scope-state";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { canonicalByteLength, compareUtf8, digestCanonical } from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import { buildMenuPreview, type PreparedMenuPlan } from "../../src/menu/mutations";
import {
    budgetSourceImpacts,
    sourceRewriteConflicts,
    sourceRewriteDecisionDetailCount,
    type PreparedSourceImpact,
} from "../../src/menu/source-rewrite";
import {
    apiBindingDocumentFromInput,
    apiBindingManifestItemFromDocument,
    MenuQueryService,
    MenuReadStore,
    menuNodeManifestItemFromDocument,
    menuNodeDocumentFromInput,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
    SubjectMenuAuthorizationRuntime,
} from "../../src/menu";
import type { SubjectAuthorizationRuntime } from "../../src/rbac/runtime";
import type { RbacScopeReader } from "../../src/rbac/store";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";

const scope = normalizeScope({ tenantId: "tenant-a" });
const scopeKey = createScopeKey(scope);
const schemes = new ResourceSchemeRegistry();

function compareValues(left: unknown, right: unknown) {
    if (left === right) return 0;
    if (left === null || left === undefined) return -1;
    if (right === null || right === undefined) return 1;
    if (typeof left === "number" && typeof right === "number") return left - right;
    return compareUtf8(String(left), String(right));
}

function valuesAtPath(value: unknown, path: string): unknown[] {
    let values = [value];
    for (const part of path.split(".")) {
        values = values.flatMap((entry) => {
            if (Array.isArray(entry)) return entry.flatMap((item) => valuesAtPath(item, part));
            if (entry === null || typeof entry !== "object") return [];
            return Object.hasOwn(entry, part) ? [(entry as Record<string, unknown>)[part]] : [];
        });
    }
    return values;
}

function matchesCondition(values: readonly unknown[], condition: unknown) {
    if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
        const operators = condition as Record<string, unknown>;
        if (Object.hasOwn(operators, "$gt")) return values.some((value) => compareValues(value, operators.$gt) > 0);
        if (Object.hasOwn(operators, "$ne")) return values.length === 0 || values.every((value) => value !== operators.$ne);
        if (Object.hasOwn(operators, "$in")) return values.some((value) => (operators.$in as unknown[]).includes(value));
    }
    return values.some((value) => value === condition);
}

function matches(row: Readonly<Record<string, unknown>>, filter: unknown): boolean {
    if (filter === null || typeof filter !== "object" || Array.isArray(filter)) return false;
    const record = filter as Record<string, unknown>;
    return Object.entries(record).every(([key, condition]) => {
        if (key === "$and") return (condition as unknown[]).every((entry) => matches(row, entry));
        if (key === "$or") return (condition as unknown[]).some((entry) => matches(row, entry));
        return matchesCondition(valuesAtPath(row, key), condition);
    });
}

function fakeCollection(initialRows: readonly Readonly<Record<string, unknown>>[]) {
    const rows = [...initialRows];
    const observations = {
        filters: [] as unknown[],
        options: [] as unknown[],
        sorts: [] as Readonly<Record<string, 1 | -1>>[],
        limits: [] as number[],
    };
    const find = vi.fn((filter: unknown, options?: unknown) => {
        observations.filters.push(filter);
        observations.options.push(options);
        let sort: Readonly<Record<string, 1 | -1>> = {};
        let limit = Number.POSITIVE_INFINITY;
        const chain = {
            sort: vi.fn((value: Readonly<Record<string, 1 | -1>>) => {
                sort = value;
                observations.sorts.push(value);
                return chain;
            }),
            limit: vi.fn((value: number) => {
                limit = value;
                observations.limits.push(value);
                return chain;
            }),
            toArray: vi.fn(async () => rows
                .filter((row) => matches(row, filter))
                .sort((left, right) => {
                    for (const [field, direction] of Object.entries(sort)) {
                        const compared = compareValues(valuesAtPath(left, field)[0], valuesAtPath(right, field)[0]);
                        if (compared !== 0) return compared * direction;
                    }
                    return 0;
                })
                .slice(0, limit)
                .map((row) => ({ ...row }))),
        };
        return chain;
    });
    return {
        handle: {
            find,
            findOne: vi.fn(async (filter: unknown) => rows.find((row) => matches(row, filter)) ?? null),
        },
        observations,
    };
}

function state(overrides: Partial<ScopeStateView> = {}): ScopeStateView {
    return Object.freeze({
        scopeKey,
        scope,
        schemaVersion: 2,
        schemeContractDigest: schemes.schemeContractDigest,
        schemaContractKey: digestCanonical({ schema: 2 }),
        revision: 3,
        rbacRevision: 2,
        menuRevision: 3,
        auditRevision: 3,
        menuNodeCount: 0,
        apiBindingCount: 0,
        replaceManifestBytes: canonicalByteLength({ schemaVersion: 2, mode: "replace", nodes: [], apiBindings: [] }),
        createdAt: 100,
        updatedAt: 100,
        persisted: true,
        ...overrides,
    });
}

function repositoryStub(options: {
    state: ScopeStateView;
    nodes?: readonly Readonly<Record<string, unknown>>[];
    bindings?: readonly Readonly<Record<string, unknown>>[];
    grants?: readonly Readonly<Record<string, unknown>>[];
    findMaxLimit?: number;
}) {
    let currentState = options.state;
    const menuNodes = fakeCollection(options.nodes ?? []);
    const apiBindings = fakeCollection(options.bindings ?? []);
    const roleMenuGrants = fakeCollection(options.grants ?? []);
    const read = vi.fn(async () => currentState);
    const repository = {
        findMaxLimit: options.findMaxLimit ?? 200,
        collections: {
            menuNodes: menuNodes.handle,
            apiBindings: apiBindings.handle,
            roleMenuGrants: roleMenuGrants.handle,
        },
        scopeStates: { read },
    } as unknown as PermissionRepository;
    return {
        repository,
        menuNodes,
        apiBindings,
        roleMenuGrants,
        read,
        setState(next: ScopeStateView) {
            currentState = next;
        },
    };
}

function menuNode(
    input: Parameters<typeof normalizeMenuNodeCreateInput>[0],
    order: number,
    mongoId = `mongo-${input.id}`,
) {
    return {
        ...menuNodeDocumentFromInput(
            scopeKey,
            scope,
            normalizeMenuNodeCreateInput(input, schemes),
            order,
            1,
            100,
        ),
        _id: mongoId,
    };
}

function apiBinding(
    input: Parameters<typeof normalizeApiBindingCreateInput>[0],
    mongoId = `mongo-${input.id}`,
) {
    return {
        ...apiBindingDocumentFromInput(
            scopeKey,
            scope,
            normalizeApiBindingCreateInput(input, schemes),
            1,
            100,
        ),
        _id: mongoId,
    };
}

function inventoryState(
    nodes: readonly Readonly<Record<string, unknown>>[],
    bindings: readonly Readonly<Record<string, unknown>>[] = [],
) {
    return state({
        menuNodeCount: nodes.length,
        apiBindingCount: bindings.length,
        replaceManifestBytes: canonicalByteLength({
            schemaVersion: 2,
            mode: "replace",
            nodes: nodes.map((node) => menuNodeManifestItemFromDocument(node as never)),
            apiBindings: bindings.map((binding) => apiBindingManifestItemFromDocument(binding as never)),
        }),
    });
}

function subjectMenuRuntime(
    currentState: ScopeStateView,
    repository: PermissionRepository,
    permission: (action: string, resource: string) => boolean = () => true,
) {
    const reader = {
        state: currentState,
        databaseSession: () => undefined,
    } as unknown as RbacScopeReader;
    const authorization = {
        ensurePolicyContextComplete: vi.fn(async () => undefined),
        can: vi.fn(async (action: string, resource: string) => permission(action, resource)),
    } as unknown as SubjectAuthorizationRuntime;
    return new SubjectMenuAuthorizationRuntime(repository, schemes, reader, authorization);
}

function roleMenuGrant(grantId: string) {
    return {
        scopeKey,
        scope,
        roleId: "operator",
        grantId,
        effect: "allow",
        intent: {
            anchorId: "orders",
            include: { descendants: false, buttons: false, apis: "none", dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        },
        snapshot: {
            contributionContractDigest: digestCanonical({ grantId, contract: 1 }),
            contributionDigest: digestCanonical({ grantId, contribution: 1 }),
            contributingAssetCount: 1,
            contributingBindingCount: 0,
            contributingAssetIds: ["orders"],
            contributingBindingIds: [],
        },
        grantRevision: 1,
        createdAt: 100,
        updatedAt: 100,
        _id: `mongo-${grantId}`,
    };
}

function queryService(repository: PermissionRepository) {
    return new MenuQueryService(
        repository,
        schemes,
        new SignedTokenCodec(Buffer.alloc(32, 7), "test-core-namespace"),
    );
}

interface DecisionBudgetPlan {
    decisions: BoundedDetails<string>;
    metadata: BoundedDetails<string>;
}

function decisionImpacts(count: number, candidateCounts: readonly number[] = []) {
    return Array.from({ length: count }, (_, index) => {
        const sourceId = `source-${String(index).padStart(3, "0")}`;
        const candidates = new Map(Array.from({ length: candidateCounts[index] ?? 0 }, (_, candidateIndex) => {
            const semanticKey = digestCanonical({ sourceId, candidateIndex });
            return [semanticKey, {
                action: "invoke" as const,
                resource: `api:GET:/candidate/${index}/${candidateIndex}`,
            }] as const;
        }));
        const publicCandidates = [...candidates.entries()].map(([semanticKey, rule]) => ({ semanticKey, rule }));
        return {
            public: {
                roleId: "role-a",
                grantId: "grant-a",
                sourceId,
                semanticKey: digestCanonical({ sourceId }),
                reason: "binding-change" as const,
                resolutions: ["replace", "revoke"] as const,
                replacementCandidates: {
                    total: publicCandidates.length,
                    items: publicCandidates,
                    truncated: false,
                    digest: digestCanonical(publicCandidates),
                },
            },
            record: { source: { sourceId } } as PreparedSourceImpact["record"],
            candidates,
        } satisfies PreparedSourceImpact;
    });
}

function completeDecision(count: number) {
    return {
        mode: "apply" as const,
        resolutions: Object.fromEntries(decisionImpacts(count).map((impact) => [
            impact.record.source.sourceId,
            { action: "revoke" as const },
        ])),
    };
}

function affectedCapacity(count: number): AuthorizationCapacityAssessment {
    const sampleIds = Array.from({ length: count }, (_, index) => `user-${String(index).padStart(3, "0")}`);
    const usage = { effectiveRoles: 1, semanticRules: 1, sourceRefs: 1, snapshotBytes: 256 };
    const limits = { effectiveRoles: 2_048, semanticRules: 2_048, sourceRefs: 16_384, snapshotBytes: 8 * 1024 * 1024 };
    return {
        accessDirection: "restrict",
        capacityDirection: "non-increasing",
        proof: "exact",
        affectedUsers: {
            total: count,
            sampleIds,
            truncated: false,
            digest: digestCanonical(sampleIds),
        },
        evaluatedUsers: count,
        unverifiedUsers: 0,
        violatingUsers: { total: 0, sampleIds: [], truncated: false, digest: digestCanonical([]) },
        maxEvaluated: usage,
        limits,
        disposition: "safe",
        digest: digestCanonical({ count, usage, limits }),
    };
}

function decisionPreview(
    count: number,
    capacity: AuthorizationCapacityAssessment | null,
    options: {
        metadataCount?: number;
        extraConflicts?: readonly ManagementConflict[];
    } = {},
): ReturnType<typeof buildMenuPreview<DecisionBudgetPlan>> {
    const impacts = decisionImpacts(count);
    const decisions = impacts.map((impact) => impact.record.source.sourceId);
    const metadata = Array.from({ length: options.metadataCount ?? 2 }, (_, index) => `metadata-${index}`);
    const conflicts = [
        ...sourceRewriteConflicts(impacts, completeDecision(count)),
        ...(options.extraConflicts ?? []),
    ];
    const prepared: PreparedMenuPlan<DecisionBudgetPlan> = {
        method: "menus.previewRemove",
        reader: { state: state() } as never,
        inputHash: digestCanonical({ count, input: true }),
        planHash: digestCanonical({ count, plan: true }),
        completePlan: { decisions, metadata },
        requiredDecisionDetailCount: count,
        publicPlan: (budget) => {
            const publicDecisions = budget.bounded(decisions);
            return {
                decisions: publicDecisions,
                metadata: budget.bounded(metadata),
            };
        },
        expectedRevisions: { global: 3, rbac: 2, menu: 3, entities: [] },
        revisionEntities: [],
        summaryCounts: { inserted: 0, updated: 0, unchanged: 0, deleted: 0, conflicted: conflicts.length },
        summarySamples: [],
        warnings: [],
        conflicts,
        capacity,
    };
    return buildMenuPreview({
        tokens: new SignedTokenCodec(Buffer.alloc(32, 9), "menu-decision-budget"),
        actor: { actorId: "admin" },
        issuedAt: 1_000,
        prepared,
    });
}

function nestedDecisionPreview(candidateCounts: readonly number[]) {
    const impacts = decisionImpacts(candidateCounts.length, candidateCounts);
    const conflicts = sourceRewriteConflicts(impacts, completeDecision(impacts.length));
    const prepared: PreparedMenuPlan<{ sourceImpacts: BoundedDetails<PreparedSourceImpact["public"]> }> = {
        method: "apiBindings.previewUpdate",
        reader: { state: state() } as never,
        inputHash: digestCanonical({ candidateCounts, input: true }),
        planHash: digestCanonical({ candidateCounts, plan: true }),
        completePlan: { sourceImpacts: impacts.map((impact) => impact.public) },
        requiredDecisionDetailCount: sourceRewriteDecisionDetailCount(impacts),
        publicPlan: (budget) => ({ sourceImpacts: budgetSourceImpacts(impacts, budget) }),
        expectedRevisions: { global: 3, rbac: 2, menu: 3, entities: [] },
        revisionEntities: [],
        summaryCounts: { inserted: 0, updated: 0, unchanged: 0, deleted: 0, conflicted: conflicts.length },
        summarySamples: [],
        warnings: [],
        conflicts,
        capacity: null,
    };
    return buildMenuPreview({
        tokens: new SignedTokenCodec(Buffer.alloc(32, 10), "menu-nested-decision-budget"),
        actor: { actorId: "admin" },
        issuedAt: 1_000,
        prepared,
    });
}

describe("v2 menu preview decision detail budget", () => {
    it("returns all 100 required decisions before capacity samples and signs the preview", () => {
        const preview = decisionPreview(100, affectedCapacity(100));
        expect(preview.executable).toBe(true);
        expect(preview.previewToken).toEqual(expect.any(String));
        expect(preview.plan.decisions).toMatchObject({ total: 100, truncated: false });
        expect(preview.plan.decisions.items).toHaveLength(100);
        expect(preview.capacity?.affectedUsers).toMatchObject({ total: 100, sampleIds: [], truncated: true });
        expect(preview.detailBudget).toMatchObject({ limit: 100, returned: 100, truncated: true });
    });

    it("reserves blocking context before ordinary plan samples after complete decisions", () => {
        const preview = decisionPreview(2, null, {
            metadataCount: 1_000,
            extraConflicts: [{
                id: "source-rewrite-required",
                code: "SOURCE_REWRITE_REQUIRED",
                message: "A source rewrite decision is required.",
            }],
        });
        expect(preview).toMatchObject({
            executable: false,
            previewToken: null,
            plan: {
                decisions: { total: 2, items: expect.any(Array), truncated: false },
                metadata: { total: 1_000, truncated: true },
            },
            conflicts: {
                total: 1,
                items: [{ id: "source-rewrite-required", code: "SOURCE_REWRITE_REQUIRED" }],
            },
            detailBudget: { limit: 100, returned: 100, truncated: true },
        });
        expect(preview.plan.decisions.items).toHaveLength(2);
        expect(preview.plan.metadata.items).toHaveLength(97);
    });

    it("rejects a complete 101-decision set without issuing an execution token", () => {
        const preview = decisionPreview(101, null);
        expect(preview).toMatchObject({
            executable: false,
            previewToken: null,
            expected: null,
            conflicts: {
                total: 1,
                items: [{ id: "source-rewrite-decision-details", code: "LIMIT_EXCEEDED" }],
            },
            plan: { decisions: { total: 101, truncated: true } },
        });
        expect(preview.plan.decisions.items).toHaveLength(99);
        expect(preview.detailBudget.returned).toBeLessThanOrEqual(100);
    });

    it("shares the exact 100-item budget with nested replacement candidates", () => {
        const preview = nestedDecisionPreview([24, 24, 24, 24]);
        expect(preview.executable).toBe(true);
        expect(preview.previewToken).toEqual(expect.any(String));
        expect(preview.plan.sourceImpacts).toMatchObject({ total: 4, truncated: false });
        expect(preview.plan.sourceImpacts.items.every((impact) => !impact.replacementCandidates.truncated)).toBe(true);
        expect(preview.detailBudget).toMatchObject({ limit: 100, returned: 100, truncated: false });
    });

    it("rejects 101 combined impact and replacement-candidate details before signing", () => {
        const preview = nestedDecisionPreview([25, 24, 24, 24]);
        expect(preview).toMatchObject({
            executable: false,
            previewToken: null,
            expected: null,
            conflicts: {
                total: 1,
                items: [{ id: "source-rewrite-decision-details", code: "LIMIT_EXCEEDED" }],
            },
        });
        expect(preview.plan.sourceImpacts.items.at(-1)?.replacementCandidates).toMatchObject({
            total: 24,
            items: expect.any(Array),
            truncated: true,
        });
        expect(preview.detailBudget).toMatchObject({ limit: 100, returned: 100, truncated: true });
    });
});

describe("v2 menu manager read model", () => {
    it("uses the frozen menu sort, a full anchor cursor, and the host page budget", async () => {
        const permission = { action: "read" as const, resource: "ui:page:orders" };
        const nodes = [
            menuNode({ id: "orders-page", parentId: "root-a", type: "page", title: "Orders", path: "/orders", name: "orders", component: "Orders", permission }, 0),
            menuNode({ id: "root-b", type: "directory", title: "Root B" }, 1),
            menuNode({ id: "root-a", type: "directory", title: "Root A" }, 0),
        ];
        const initial = state({ menuNodeCount: nodes.length });
        const stub = repositoryStub({ state: initial, nodes, findMaxLimit: 1 });
        const service = queryService(stub.repository);

        const first = await service.listMenus(scope, { first: 2 });
        expect(first.items.map((item) => item.id)).toEqual(["root-a", "root-b"]);
        expect(first.pageInfo).toMatchObject({ hasNext: true });
        expect(first.pageInfo.endCursor).toEqual(expect.any(String));
        expect(new Set(stub.menuNodes.observations.limits)).toEqual(new Set([1]));
        expect(stub.menuNodes.observations.sorts[0]).toEqual({ parentId: 1, order: 1, nodeId: 1, _id: 1 });

        const second = await service.listMenus(scope, { first: 1, after: first.pageInfo.endCursor! });
        expect(second.items.map((item) => item.id)).toEqual(["orders-page"]);
        expect(second.pageInfo).toEqual({ hasNext: false, endCursor: null });

        const token = first.pageInfo.endCursor!;
        const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
        await expect(service.listMenus(scope, { after: tampered })).rejects.toMatchObject({ code: "INVALID_CURSOR" });

        stub.setState(state({ revision: 4, menuRevision: 4, menuNodeCount: nodes.length }));
        await expect(service.listMenus(scope, { after: token })).rejects.toMatchObject({ code: "CURSOR_STALE" });
    });

    it("uses method, path, and binding ID order without binding page size into queryHash", async () => {
        const base = {
            purpose: "entry" as const,
            authorization: { mode: "all" as const, permissions: [{ action: "read" as const, resource: "api:GET:/orders" }] },
        };
        const bindings = [
            apiBinding({ id: "get-b", method: "GET", path: "/b", ...base }),
            apiBinding({ id: "delete-z", method: "DELETE", path: "/z", ...base }),
            apiBinding({ id: "get-a", method: "GET", path: "/a", ...base }),
        ];
        const stub = repositoryStub({ state: state({ apiBindingCount: bindings.length }), bindings });
        const service = queryService(stub.repository);

        const first = await service.listApiBindings(scope, { first: 2 });
        expect(first.items.map((item) => item.id)).toEqual(["delete-z", "get-a"]);
        const second = await service.listApiBindings(scope, { first: 1, after: first.pageInfo.endCursor! });
        expect(second.items.map((item) => item.id)).toEqual(["get-b"]);
        expect(stub.apiBindings.observations.sorts[0]).toEqual({ method: 1, path: 1, bindingId: 1, _id: 1 });
    });

    it("builds a stable tree and prunes the subtree below a hidden node", async () => {
        const nodes = [
            menuNode({ id: "root", type: "directory", title: "Root" }, 0),
            menuNode({ id: "hidden", parentId: "root", type: "directory", title: "Hidden", hidden: true }, 0),
            menuNode({ id: "child", parentId: "hidden", type: "directory", title: "Child" }, 0),
        ];
        const stub = repositoryStub({ state: state({ menuNodeCount: nodes.length }), nodes });
        const tree = await queryService(stub.repository).getTree(scope);
        expect(tree.data).toHaveLength(1);
        expect(tree.data[0]).toMatchObject({ id: "root", children: [] });
        expect(Object.isFrozen(tree.data[0]!.children)).toBe(true);
    });

    it("accepts exactly 5000 tree nodes and rejects the first node over the limit", async () => {
        const nodes = Array.from({ length: 5_001 }, (_, index) => menuNode({
            id: `node-${index}`,
            type: "directory",
            title: `Node ${index}`,
        }, index));
        const exactStub = repositoryStub({ state: state({ menuNodeCount: 5_000 }), nodes: nodes.slice(0, 5_000) });
        const exact = await queryService(exactStub.repository).getTree(scope);
        expect(exact.data).toHaveLength(5_000);

        const overStub = repositoryStub({ state: state({ menuNodeCount: 5_001 }), nodes });
        await expect(queryService(overStub.repository).getTree(scope)).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: { kind: "limit-exceeded", limitName: "menu-tree-nodes", current: 5_001, max: 5_000 },
        });
    }, 15_000);

    it("fails closed when a bounded tree still exceeds the public response budget", async () => {
        const payload = "x".repeat(30_000);
        const nodes = Array.from({ length: 300 }, (_, index) => menuNode({
            id: `large-${index}`,
            type: "directory",
            title: `Large ${index}`,
            meta: { payload },
        }, index));
        const stub = repositoryStub({ state: state({ menuNodeCount: nodes.length }), nodes });
        await expect(queryService(stub.repository).getTree(scope)).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: { kind: "limit-exceeded", max: 8 * 1024 * 1024, unit: "bytes" },
        });
    }, 30_000);
});

describe("v2 menu inventory and grant readers", () => {
    it("reads role grant pages in canonical order under findMaxLimit", async () => {
        const grants = [roleMenuGrant("grant_z"), roleMenuGrant("grant_a")];
        const stub = repositoryStub({ state: state(), grants, findMaxLimit: 1 });
        const reader = await new MenuReadStore(stub.repository, schemes).open(scope);
        const result = await reader.readGrantsForRole("operator");
        expect(result.map((grant) => grant.grantId)).toEqual(["grant_a", "grant_z"]);
        expect(new Set(stub.roleMenuGrants.observations.limits)).toEqual(new Set([1]));
    });

    it.each([
        ["missing owner", [apiBinding({
            id: "missing-owner",
            method: "GET",
            path: "/missing",
            purpose: "entry",
            authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/missing" }] },
            owners: [{ type: "menu", id: "missing", required: true }],
        })]],
        ["conflicting availability modes", [
            apiBinding({
                id: "orders-a",
                method: "GET",
                path: "/orders/a",
                purpose: "entry",
                authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/orders/a" }] },
                owners: [{ type: "menu", id: "orders", required: true, availabilityGroup: "entry", availabilityMode: "any" }],
            }),
            apiBinding({
                id: "orders-b",
                method: "GET",
                path: "/orders/b",
                purpose: "entry",
                authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/orders/b" }] },
                owners: [{ type: "menu", id: "orders", required: true, availabilityGroup: "entry", availabilityMode: "all" }],
            }),
        ]],
    ])("fails closed for %s across the complete inventory", async (_name, bindings) => {
        const nodes = [menuNode({
            id: "orders",
            type: "menu",
            title: "Orders",
            path: "/orders",
            name: "orders",
            permission: { action: "read", resource: "ui:menu:orders" },
        }, 0)];
        const stub = repositoryStub({
            state: state({ menuNodeCount: nodes.length, apiBindingCount: bindings.length }),
            nodes,
            bindings,
        });
        const reader = await new MenuReadStore(stub.repository, schemes).open(scope);
        await expect(reader.readCompleteInventory()).rejects.toBeInstanceOf(PermissionCoreError);
        await expect(reader.readCompleteInventory()).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    });
});

describe("subject menu projection limits and integrity", () => {
    it("keeps an allowed permission-bearing empty directory and removes an unguarded empty directory", async () => {
        const nodes = [
            menuNode({
                id: "guarded",
                type: "directory",
                title: "Guarded",
                permission: { action: "read", resource: "ui:directory:guarded" },
            }, 0),
            menuNode({ id: "unguarded", type: "directory", title: "Unguarded" }, 1),
        ];
        const currentState = inventoryState(nodes);
        const stub = repositoryStub({ state: currentState, nodes });
        const result = await subjectMenuRuntime(currentState, stub.repository).getVisibleTree();
        expect(result.data.map((node) => node.id)).toEqual(["guarded"]);
    });

    it("accepts exactly 5000 visible nodes and rejects the first node over", async () => {
        const nodes = Array.from({ length: 5_001 }, (_, index) => menuNode({
            id: `visible-${index}`,
            type: "page",
            title: `Visible ${index}`,
            path: `/visible-${index}`,
            name: `visible-${index}`,
            component: "VisiblePage",
            permission: { action: "read", resource: `ui:page:visible-${index}` },
        }, index));
        const exactNodes = nodes.slice(0, 5_000);
        const exactState = inventoryState(exactNodes);
        const exactStub = repositoryStub({ state: exactState, nodes: exactNodes });
        const exact = await subjectMenuRuntime(exactState, exactStub.repository).getVisibleTree();
        expect(exact.data).toHaveLength(5_000);

        const overState = inventoryState(nodes);
        const overStub = repositoryStub({ state: overState, nodes });
        await expect(subjectMenuRuntime(overState, overStub.repository).getVisibleTree()).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: {
                kind: "limit-exceeded",
                limitName: "subject-menu-tree-nodes",
                current: 5_001,
                max: 5_000,
            },
        });
    }, 20_000);

    it("accepts exactly 1000 direct buttons and rejects the first button over", async () => {
        const owner = menuNode({
            id: "owner",
            type: "page",
            title: "Owner",
            path: "/owner",
            name: "owner",
            component: "OwnerPage",
            permission: { action: "read", resource: "ui:page:owner" },
        }, 0);
        const buttons = Array.from({ length: 1_001 }, (_, index) => menuNode({
            id: `button-${index}`,
            parentId: "owner",
            type: "button",
            title: `Button ${index}`,
            code: `button.${String(index).padStart(4, "0")}`,
            permission: { action: "invoke", resource: `ui:button:${index}` },
        }, index));
        const exactNodes = [owner, ...buttons.slice(0, 1_000)];
        const exactState = inventoryState(exactNodes);
        const exactStub = repositoryStub({ state: exactState, nodes: exactNodes });
        const exact = await subjectMenuRuntime(exactState, exactStub.repository).getButtonMap("owner");
        expect(Object.keys(exact.data)).toHaveLength(1_000);
        expect(Object.isFrozen(exact.data)).toBe(true);

        const overNodes = [owner, ...buttons];
        const overState = inventoryState(overNodes);
        const overStub = repositoryStub({ state: overState, nodes: overNodes });
        await expect(subjectMenuRuntime(overState, overStub.repository).getButtonMap("owner")).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: {
                kind: "limit-exceeded",
                limitName: "subject-menu-buttons",
                current: 1_001,
                max: 1_000,
            },
        });
    }, 20_000);

    it("shares the 100-detail budget and digests the complete public risk tree", async () => {
        const nodes = [menuNode({
            id: "risk-owner",
            type: "page",
            title: "Risk owner",
            path: "/risks",
            name: "risks",
            component: "RiskPage",
            permission: { action: "read", resource: "ui:page:risks" },
        }, 0)];
        const bindings = Array.from({ length: 101 }, (_, index) => apiBinding({
            id: `risk-${String(index).padStart(3, "0")}`,
            method: "GET",
            path: `/api/risks/${index}`,
            purpose: "lookup",
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: `api:GET:/api/risks/${index}` }],
            },
            owners: [{ type: "page", id: "risk-owner", required: false }],
            canonicalOwner: { type: "page", id: "risk-owner" },
        }));
        const currentState = inventoryState(nodes, bindings);
        const stub = repositoryStub({ state: currentState, nodes, bindings });
        const result = await subjectMenuRuntime(
            currentState,
            stub.repository,
            (_action, resource) => resource === "ui:page:risks",
        ).getVisibleTree();
        const risks = bindings.map((binding) => ({
            bindingId: binding.bindingId as string,
            required: false,
            allowed: false,
        }));
        const projected = result.data[0]!;
        expect(projected.apiRisks).toMatchObject({
            total: 101,
            items: risks.slice(0, 100),
            truncated: true,
            digest: digestCanonical(risks),
        });
        expect(result.detailBudget).toMatchObject({ returned: 100, truncated: true });
        const completeTree = [{
            ...projected,
            apiRisks: {
                total: risks.length,
                items: risks,
                truncated: false,
                digest: digestCanonical(risks),
            },
        }];
        expect(result.detailBudget.digest).toBe(digestCanonical(completeTree));
    });

    it("maps corrupted button code to the stable integrity reason before returning any projection", async () => {
        const owner = menuNode({
            id: "owner-corrupt",
            type: "page",
            title: "Owner",
            path: "/owner-corrupt",
            name: "owner-corrupt",
            component: "OwnerPage",
            permission: { action: "read", resource: "ui:page:owner-corrupt" },
        }, 0);
        const validButton = menuNode({
            id: "button-corrupt",
            parentId: "owner-corrupt",
            type: "button",
            title: "Corrupt",
            code: "button.valid",
            permission: { action: "invoke", resource: "ui:button:corrupt" },
        }, 0);
        const corruptButton = { ...validButton, code: "__proto__" };
        const nodes = [owner, corruptButton];
        const currentState = state({ menuNodeCount: nodes.length });
        const stub = repositoryStub({ state: currentState, nodes });
        await expect(subjectMenuRuntime(currentState, stub.repository).getVisibleTree()).rejects.toMatchObject({
            code: "PERSISTED_STATE_INVALID",
            details: {
                kind: "persisted-state-invalid",
                stage: "load",
                reason: "invalid-menu-code",
            },
        });
    });
});
