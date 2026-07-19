import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import {
    decodeApiBindingReplay,
    decodeBatchMutationSummaryReplay,
    decodeMenuNodeReplay,
} from "../../src/menu/views";
import { createSemanticKey } from "../../src/rbac/materialize";
import { DetailBudgetAllocator } from "../../src/rbac/result";
import {
    boundedDetails,
    completeDetails,
    completePermissionRuleView,
    decodePermissionRuleReplay,
    decodeRemovedRoleReplay,
    decodeRoleReplay,
    decodeRuleRevokeReplay,
    decodeUserRoleBindingReplay,
    permissionRuleView,
    roleView,
    userRoleBindingView,
} from "../../src/rbac/views";

const schemes = new ResourceSchemeRegistry();

function expectPersistedError(run: () => unknown) {
    expect(run).toThrowError(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
}

function menuNode(overrides: Record<string, unknown> = {}) {
    return {
        id: "root",
        parentId: null,
        type: "directory",
        title: "Root",
        order: 0,
        status: "enabled",
        hidden: false,
        revision: 1,
        createdAt: 10,
        updatedAt: 10,
        ...overrides,
    };
}

function apiBinding(overrides: Record<string, unknown> = {}) {
    return {
        id: "orders-read",
        method: "GET",
        path: "/api/orders",
        purpose: "entry",
        authorization: { mode: "all", permissions: [{ action: "read", resource: "api:GET:/api/orders" }] },
        owners: [],
        status: "enabled",
        revision: 1,
        createdAt: 10,
        updatedAt: 10,
        ...overrides,
    };
}

function role(overrides: Record<string, unknown> = {}) {
    return {
        id: "reader",
        label: "Reader",
        status: "enabled",
        parentId: null,
        revision: 1,
        createdAt: 10,
        updatedAt: 10,
        ...overrides,
    };
}

describe("menu replay decoders", () => {
    it("round-trips canonical menu nodes and API bindings", () => {
        expect(decodeMenuNodeReplay(menuNode(), schemes)).toEqual(menuNode());
        expect(decodeApiBindingReplay(apiBinding(), schemes)).toEqual(apiBinding());
        expect(Object.isFrozen(decodeMenuNodeReplay(menuNode(), schemes))).toBe(true);
    });

    it("rejects timestamp reversal and noncanonical default omission", () => {
        expect(() => decodeMenuNodeReplay(menuNode({ updatedAt: 9 }), schemes)).toThrow(TypeError);
        expect(() => decodeApiBindingReplay(apiBinding({ updatedAt: 9 }), schemes)).toThrow(TypeError);
        const incomplete: Record<string, unknown> = menuNode();
        delete incomplete.hidden;
        expect(() => decodeMenuNodeReplay(incomplete, schemes)).toThrow();
    });

    it("round-trips bounded batch summaries including conflicts", () => {
        const summary = {
            inserted: 1,
            updated: 0,
            unchanged: 0,
            deleted: 0,
            conflicted: 1,
            samples: {
                total: 2,
                items: [
                    { id: "orders", outcome: "conflicted", conflict: { code: "REVISION_CONFLICT", message: "stale", currentRevision: 2 } },
                    { id: "root", outcome: "inserted" },
                ],
                truncated: false,
                digest: digestCanonical(["summary"]),
            },
        };
        expect(decodeBatchMutationSummaryReplay(summary)).toEqual(summary);
    });

    it("rejects malformed sample metadata, items, conflict details, ordering, and counts", () => {
        const base = {
            inserted: 0,
            updated: 0,
            unchanged: 0,
            deleted: 0,
            conflicted: 0,
            samples: { total: 0, items: [], truncated: false, digest: "digest" },
        };
        const invalid = [
            { ...base, samples: { ...base.samples, truncated: "false" } },
            { ...base, samples: { total: 1, items: [{ id: 1, outcome: "inserted" }], truncated: false, digest: "digest" } },
            { ...base, samples: { total: 1, items: [{ id: "x", outcome: "inserted", conflict: {} }], truncated: false, digest: "digest" } },
            { ...base, samples: { total: 1, items: [{ id: "x", outcome: "conflicted", conflict: { code: 1, message: "bad" } }], truncated: false, digest: "digest" } },
            { ...base, samples: { total: 2, items: [{ id: "z", outcome: "inserted" }, { id: "a", outcome: "inserted" }], truncated: false, digest: "digest" } },
            { ...base, samples: { total: 1, items: [], truncated: false, digest: "digest" } },
        ];
        for (const value of invalid) expect(() => decodeBatchMutationSummaryReplay(value)).toThrow(TypeError);
    });
});

describe("RBAC public views and replay decoders", () => {
    it("builds bounded role, binding, and manual rule views", () => {
        expect(boundedDetails([1, 2], 1)).toMatchObject({ total: 2, items: [1], truncated: true });
        expect(completeDetails([1, 2])).toMatchObject({ total: 2, items: [1, 2], truncated: false });
        expect(roleView({
            roleId: "reader",
            label: "Reader",
            description: "Reads orders",
            status: "enabled",
            parentId: null,
            revision: 1,
            createdAt: 10,
            updatedAt: 10,
        } as never)).toMatchObject({ id: "reader", description: "Reads orders" });
        expect(userRoleBindingView({ userId: "user-1", roleIds: ["reader"], revision: 1, persisted: true, createdAt: 10, updatedAt: 10 } as never))
            .toMatchObject({ userId: "user-1", persisted: true, createdAt: 10 });
        expect(userRoleBindingView({ userId: "user-2", roleIds: [], revision: 0, persisted: false } as never))
            .toEqual({ userId: "user-2", roleIds: [], revision: 0, persisted: false });

        const semanticKey = createSemanticKey("allow", "read", "db:orders");
        const document = {
            effect: "allow",
            action: "read",
            resource: "db:orders",
            semanticKey,
            sources: [{ kind: "manual", sourceId: `manual:${semanticKey}` }],
        };
        expect(completePermissionRuleView(document as never).sources.items).toHaveLength(1);
        expect(permissionRuleView(document as never, new Map(), new DetailBudgetAllocator()).sources.items).toHaveLength(1);
        expectPersistedError(() => completePermissionRuleView({
            ...document,
            sources: [{ kind: "menu", sourceId: "missing" }],
        } as never));
    });

    it("round-trips canonical role, user-role, removal, and revoke payloads", () => {
        expect(decodeRoleReplay(role())).toEqual(role());
        expect(decodeRoleReplay(role({ description: "Reads orders" }))).toEqual(role({ description: "Reads orders" }));
        expect(decodeUserRoleBindingReplay({
            userId: "user-1",
            roleIds: ["reader", "writer"],
            revision: 1,
            persisted: true,
            createdAt: 10,
            updatedAt: 10,
        })).toMatchObject({ persisted: true, roleIds: ["reader", "writer"] });
        expect(decodeUserRoleBindingReplay({ userId: "user-2", roleIds: [], revision: 0, persisted: false }))
            .toMatchObject({ persisted: false });
        expect(decodeRemovedRoleReplay({ removedRoleId: "reader" })).toEqual({ removedRoleId: "reader" });
        const digest = digestCanonical([]);
        expect(decodeRuleRevokeReplay({ removed: 1, remainingCount: 0, remainingDigest: digest }))
            .toEqual({ removed: 1, remainingCount: 0, remainingDigest: digest });
    });

    it("rejects malformed role, user-role, removal, and revoke replay payloads", () => {
        const invalidRoles = [
            null,
            { ...role(), extra: true },
            role({ id: " reader " }),
            role({ label: " Reader " }),
            role({ status: "archived" }),
            role({ parentId: "reader" }),
            role({ updatedAt: 9 }),
        ];
        for (const value of invalidRoles) expectPersistedError(() => decodeRoleReplay(value));

        const invalidBindings = [
            { userId: "user-1", roleIds: "reader", revision: 1, persisted: true, createdAt: 1, updatedAt: 1 },
            { userId: "user-1", roleIds: ["writer", "reader"], revision: 1, persisted: true, createdAt: 1, updatedAt: 1 },
            { userId: "user-1", roleIds: [], revision: 0, persisted: true, createdAt: 1, updatedAt: 1 },
            { userId: "user-1", roleIds: [], revision: 0, persisted: false, createdAt: 1 },
            { userId: "user-1", roleIds: ["reader"], revision: 1, persisted: true, createdAt: 2, updatedAt: 1 },
        ];
        for (const value of invalidBindings) expectPersistedError(() => decodeUserRoleBindingReplay(value));
        expectPersistedError(() => decodeRemovedRoleReplay({ removedRoleId: " reader " }));
        expectPersistedError(() => decodeRuleRevokeReplay({ removed: 2, remainingCount: -1, remainingDigest: "bad" }));
    });

    it("round-trips a manual rule replay and rejects envelope/source drift", () => {
        const semanticKey = createSemanticKey("allow", "read", "db:orders");
        const sources = [{ kind: "manual", sourceId: `manual:${semanticKey}`, state: "active" }];
        const replay = {
            effect: "allow",
            action: "read",
            resource: "db:orders",
            semanticKey,
            sources: {
                total: 1,
                items: sources,
                truncated: false,
                digest: digestCanonical(sources),
            },
        };
        expect(decodePermissionRuleReplay(replay, schemes)).toEqual(replay);
        const invalid = [
            { ...replay, semanticKey: "bad" },
            { ...replay, sources: { ...replay.sources, total: 0 } },
            { ...replay, sources: { ...replay.sources, items: [{ kind: "manual", sourceId: "wrong", state: "active" }] } },
            { ...replay, sources: { ...replay.sources, items: [{ kind: "other" }] } },
            { ...replay, sources: { ...replay.sources, digest: "bad" } },
        ];
        for (const value of invalid) expectPersistedError(() => decodePermissionRuleReplay(value, schemes));
    });
});
