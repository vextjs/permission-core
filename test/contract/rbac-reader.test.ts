import { describe, expect, it, vi } from "vitest";
import type { PermissionRepository } from "../../src/persistence/repository";
import type { ScopeStateView } from "../../src/persistence/scope-state";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { compareUtf8, digestCanonical } from "../../src/internal/canonical";
import { PERSISTED_SCHEMA_VERSION } from "../../src/persistence/documents";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";
import {
    createSemanticKey,
    materializeRoleDocument,
    materializeRoleRuleDocument,
    materializeUserRoleSetDocument,
    RbacReadStore,
} from "../../src/rbac";
import { PermissionCoreError } from "../../src";

const scope = normalizeScope({ tenantId: "tenant-a" });
const scopeKey = createScopeKey(scope);
const emptyDigest = digestCanonical([]);
const resourceSchemes = new ResourceSchemeRegistry();

function roleDocument(overrides: Record<string, unknown> = {}) {
    return {
        scopeKey,
        scope,
        roleId: "operator",
        label: "Operator",
        status: "enabled",
        parentId: null,
        revision: 1,
        menuGrantCount: 0,
        menuGrantDigest: emptyDigest,
        menuSourceCount: 0,
        menuSourceDigest: emptyDigest,
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    };
}

function ruleDocument(overrides: Record<string, unknown> = {}) {
    const effect = (overrides.effect ?? "allow") as "allow" | "deny";
    const action = (overrides.action ?? "read") as string;
    const resource = (overrides.resource ?? "db:orders") as string;
    const where = overrides.where as undefined | Record<string, unknown>;
    const semanticKey = createSemanticKey(effect, action, resource, where as never);
    return {
        scopeKey,
        scope,
        roleId: "operator",
        effect,
        action,
        resource,
        ...(where === undefined ? {} : { where }),
        semanticKey,
        sources: [{ kind: "manual", sourceId: `manual:${semanticKey}` }],
        revision: 1,
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    };
}

function userRoleDocument(overrides: Record<string, unknown> = {}) {
    return {
        scopeKey,
        scope,
        userId: "u-1",
        roleIds: ["operator", "reader"],
        revision: 1,
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    };
}

function state(persisted = true): ScopeStateView {
    return Object.freeze({
        scopeKey,
        scope,
        schemaVersion: PERSISTED_SCHEMA_VERSION,
        schemeContractDigest: resourceSchemes.schemeContractDigest,
        schemaContractKey: digestCanonical({ test: "schema" }),
        revision: persisted ? 1 : 0,
        rbacRevision: persisted ? 1 : 0,
        menuRevision: 0,
        auditRevision: persisted ? 1 : 0,
        menuConfigCount: 0,
        menuConfigBytes: 0,
        menuNodeCount: 0,
        apiBindingCount: 0,
        responseFieldCount: 0,
        responseFieldOwnerCount: 0,
        replaceManifestBytes: 49,
        createdAt: persisted ? 100 : 0,
        updatedAt: persisted ? 100 : 0,
        persisted,
    });
}

function repositoryStub(
    scopeState: ScopeStateView,
    role: Record<string, unknown> | null,
    findMaxLimit = 10_000,
) {
    const roleFindOne = vi.fn(async () => role);
    const emptyFindOne = vi.fn(async () => null);
    const readState = vi.fn(async () => scopeState);
    return {
        repository: {
            findMaxLimit,
            collections: {
                roles: { findOne: roleFindOne },
                roleRules: { find: vi.fn() },
                userRoleSets: { findOne: emptyFindOne },
            },
            scopeStates: { read: readState },
        } as unknown as PermissionRepository,
        roleFindOne,
        emptyFindOne,
        readState,
    };
}

describe("RBAC persisted materializers", () => {
    it("returns immutable canonical role, rule, and user-role snapshots", () => {
        const role = materializeRoleDocument(roleDocument(), scope, scopeKey);
        const rule = materializeRoleRuleDocument(ruleDocument({
            where: { field: "merchantId", op: "eq", valueFrom: "claims.merchantId" },
        }), scope, scopeKey, resourceSchemes);
        const userRoles = materializeUserRoleSetDocument(userRoleDocument(), scope, scopeKey);

        expect(role).toMatchObject({ roleId: "operator", parentId: null, revision: 1 });
        expect(rule).toMatchObject({ effect: "allow", action: "read", resource: "db:orders" });
        expect(rule.sources).toEqual([{ kind: "manual", sourceId: `manual:${rule.semanticKey}` }]);
        expect(userRoles).toMatchObject({ userId: "u-1", roleIds: ["operator", "reader"], persisted: true });
        expect(Object.isFrozen(role)).toBe(true);
        expect(Object.isFrozen(rule.sources)).toBe(true);
        expect(Object.isFrozen(userRoles.roleIds)).toBe(true);
    });

    it.each([
        ["unexpected role field", () => materializeRoleDocument(roleDocument({ injected: true }), scope, scopeKey)],
        ["cross-scope role", () => materializeRoleDocument(roleDocument({ scopeKey: "x".repeat(43) }), scope, scopeKey)],
        ["non-canonical role id", () => materializeRoleDocument(roleDocument({ roleId: " operator " }), scope, scopeKey)],
        ["self parent", () => materializeRoleDocument(roleDocument({ parentId: "operator" }), scope, scopeKey)],
        ["undefined description", () => materializeRoleDocument(roleDocument({ description: undefined }), scope, scopeKey)],
        ["bad empty aggregate digest", () => materializeRoleDocument(roleDocument({ menuSourceDigest: digestCanonical(["forged"]) }), scope, scopeKey)],
        ["non-empty aggregate with empty digest", () => materializeRoleDocument(roleDocument({ menuGrantCount: 1 }), scope, scopeKey)],
        ["aggregate above hard limit", () => materializeRoleDocument(roleDocument({ menuSourceCount: 20_001, menuSourceDigest: digestCanonical(["source"]) }), scope, scopeKey)],
        ["bad semantic digest", () => materializeRoleRuleDocument(ruleDocument({ semanticKey: "x".repeat(43) }), scope, scopeKey, resourceSchemes)],
        ["undefined where", () => materializeRoleRuleDocument(ruleDocument({ where: undefined }), scope, scopeKey, resourceSchemes)],
        ["bad manual source", () => materializeRoleRuleDocument(ruleDocument({ sources: [{ kind: "manual", sourceId: "manual:wrong" }] }), scope, scopeKey, resourceSchemes)],
        ["legacy top-level API source kind", () => materializeRoleRuleDocument(ruleDocument({ sources: [{ kind: "api", sourceId: "legacy" }] }), scope, scopeKey, resourceSchemes)],
        ["duplicate user role", () => materializeUserRoleSetDocument(userRoleDocument({ roleIds: ["operator", "operator"] }), scope, scopeKey)],
        ["unsorted user roles", () => materializeUserRoleSetDocument(userRoleDocument({ roleIds: ["reader", "operator"] }), scope, scopeKey)],
    ])("fails closed for %s", (_name, operation) => {
        expect(operation).toThrowError(PermissionCoreError);
        try {
            operation();
        } catch (error) {
            expect(error).toMatchObject({ code: "PERSISTED_STATE_INVALID" });
        }
    });

    it("rejects Proxy documents before invoking traps", () => {
        let traps = 0;
        const role = new Proxy(roleDocument(), {
            ownKeys() {
                traps += 1;
                return [];
            },
        });
        expect(() => materializeRoleDocument(role, scope, scopeKey)).toThrowError(PermissionCoreError);
        expect(traps).toBe(0);
    });

    it("rejects exotic snapshots, invalid timestamps, and non-positive revisions", () => {
        const role = roleDocument();
        const symbol = { ...role, [Symbol("injected")]: true };
        const hidden = { ...role };
        Object.defineProperty(hidden, "label", { value: "Operator", enumerable: false });
        for (const value of [null, [], new Date(), symbol, hidden]) {
            expect(() => materializeRoleDocument(value, scope, scopeKey)).toThrowError(PermissionCoreError);
        }
        for (const override of [
            { scope: null },
            { createdAt: -1 },
            { updatedAt: 99 },
            { revision: 0 },
            { status: "unknown" },
            { label: "" },
        ]) {
            expect(() => materializeRoleDocument(roleDocument(override), scope, scopeKey)).toThrowError(PermissionCoreError);
        }
        for (const override of [
            { scope: null },
            { createdAt: -1 },
            { updatedAt: 99 },
            { revision: 0 },
            { effect: "audit" },
            { action: " read " },
        ]) {
            expect(() => materializeRoleRuleDocument(ruleDocument(override), scope, scopeKey, resourceSchemes))
                .toThrowError(PermissionCoreError);
        }
        for (const override of [
            { scope: null },
            { createdAt: -1 },
            { updatedAt: 99 },
            { revision: 0 },
            { userId: " user " },
        ]) {
            expect(() => materializeUserRoleSetDocument(userRoleDocument(override), scope, scopeKey))
                .toThrowError(PermissionCoreError);
        }
    });

    it("preserves valid optional role metadata and deny conditions", () => {
        const role = materializeRoleDocument(roleDocument({
            description: "Operates orders",
            parentId: "staff",
            status: "disabled",
        }), scope, scopeKey);
        expect(role).toMatchObject({ description: "Operates orders", parentId: "staff", status: "disabled" });
        const rule = materializeRoleRuleDocument(ruleDocument({
            effect: "deny",
            where: { field: "status", op: "eq", value: "blocked" },
        }), scope, scopeKey, resourceSchemes);
        expect(rule).toMatchObject({ effect: "deny", where: { field: "status", op: "eq", value: "blocked" } });
    });
});

describe("RbacReadStore scope binding", () => {
    it("queries by canonical scope first and returns a virtual empty user relation", async () => {
        const stub = repositoryStub(state(), roleDocument());
        const store = new RbacReadStore(stub.repository, resourceSchemes);
        const reader = await store.open(scope);
        const role = await reader.requireRole(" operator ");
        const userRoles = await reader.readUserRoleSet("u-1");

        expect(role.roleId).toBe("operator");
        expect(stub.roleFindOne).toHaveBeenCalledWith(
            { scopeKey, roleId: "operator" },
            expect.objectContaining({ cache: 0 }),
        );
        expect(userRoles).toEqual({
            scopeKey,
            scope,
            userId: "u-1",
            roleIds: [],
            revision: 0,
            persisted: false,
        });
        expect(userRoles).not.toHaveProperty("createdAt");
    });

    it("rejects orphan RBAC rows under a virtual scope", async () => {
        const stub = repositoryStub(state(false), roleDocument());
        const reader = await new RbacReadStore(stub.repository, resourceSchemes).open(scope);
        await expect(reader.readRole("operator")).rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    });

    it("detects domain revision drift after a read", async () => {
        const initial = state();
        const changed = Object.freeze({ ...initial, revision: 2, rbacRevision: 2, auditRevision: 2 });
        const stub = repositoryStub(initial, null);
        stub.readState.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
        const reader = await new RbacReadStore(stub.repository, resourceSchemes).open(scope);
        await expect(reader.verifyRbacUnchanged()).rejects.toMatchObject({ code: "READ_CONFLICT" });
    });

    it("classifies unknown database execution failures as database errors", async () => {
        const stub = repositoryStub(state(), null);
        stub.roleFindOne.mockRejectedValueOnce(new Error("offline"));
        const reader = await new RbacReadStore(stub.repository, resourceSchemes).open(scope);
        await expect(reader.readRole("operator")).rejects.toMatchObject({
            code: "DATABASE_ERROR",
            details: { kind: "database-failure", stage: "read" },
        });
    });

    it("classifies explicit MongoDB network timeouts as database unavailable", async () => {
        const stub = repositoryStub(state(), null);
        const timeout = Object.assign(new Error("network timeout"), { name: "MongoNetworkTimeoutError" });
        stub.roleFindOne.mockRejectedValueOnce(timeout);
        const reader = await new RbacReadStore(stub.repository, resourceSchemes).open(scope);
        await expect(reader.readRole("operator")).rejects.toMatchObject({
            code: "DATABASE_UNAVAILABLE",
            retryable: true,
            details: { kind: "database-failure", stage: "read" },
        });
    });

    it("reads rules through bounded monotonic keyset pages", async () => {
        const rows = Array.from({ length: 201 }, (_, index) => ruleDocument({
            action: `custom.${index}`,
        })).sort((left, right) => compareUtf8(
            left.semanticKey as string,
            right.semanticKey as string,
        ));
        const pages = [rows.slice(0, 200), rows.slice(200)];
        const find = vi.fn((_filter: unknown) => {
            const page = pages.shift() ?? [];
            const chain = {
                sort: vi.fn(() => chain),
                limit: vi.fn((value: number) => {
                    expect(value).toBe(200);
                    return chain;
                }),
                toArray: vi.fn(async () => page),
            };
            return chain;
        });
        const stub = repositoryStub(state(), roleDocument());
        (stub.repository.collections.roleRules as unknown as { find: typeof find }).find = find;
        const reader = await new RbacReadStore(stub.repository, resourceSchemes).open(scope);
        const result = await reader.readRulesForRole("operator");

        expect(result).toHaveLength(201);
        expect(find).toHaveBeenCalledTimes(2);
        expect(find.mock.calls[0]?.[0]).toEqual({ scopeKey, roleId: { $in: ["operator"] } });
        expect(find.mock.calls[1]?.[0]).toEqual({
            $and: [
                { scopeKey, roleId: { $in: ["operator"] } },
                {
                    $or: [
                        { roleId: { $gt: "operator" } },
                        {
                            roleId: "operator",
                            semanticKey: { $gt: rows[199]!.semanticKey },
                        },
                    ],
                },
            ],
        });
        expect(Object.isFrozen(result)).toBe(true);
    });

    it.each([1, 2, 199, 200])(
        "honors a host findMaxLimit of %i for rule keyset pages",
        async (findMaxLimit) => {
            const rows = Array.from({ length: 201 }, (_, index) => ruleDocument({
                action: `budget.${index}`,
            })).sort((left, right) => compareUtf8(
                left.semanticKey as string,
                right.semanticKey as string,
            ));
            let offset = 0;
            const observedLimits: number[] = [];
            const find = vi.fn(() => {
                let requested = 0;
                const chain = {
                    sort: vi.fn(() => chain),
                    limit: vi.fn((value: number) => {
                        requested = value;
                        observedLimits.push(value);
                        return chain;
                    }),
                    toArray: vi.fn(async () => {
                        const page = rows.slice(offset, offset + requested);
                        offset += page.length;
                        return page;
                    }),
                };
                return chain;
            });
            const stub = repositoryStub(state(), roleDocument(), findMaxLimit);
            (stub.repository.collections.roleRules as unknown as { find: typeof find }).find = find;
            const reader = await new RbacReadStore(stub.repository, resourceSchemes).open(scope);

            await expect(reader.readRulesForRole("operator")).resolves.toHaveLength(201);
            expect(observedLimits.length).toBeGreaterThan(0);
            expect(new Set(observedLimits)).toEqual(new Set([Math.min(200, findMaxLimit)]));
        },
    );

    it("chunks role batch reads under the host query budget", async () => {
        const observedLimits: number[] = [];
        const find = vi.fn(() => {
            const chain = {
                limit: vi.fn((value: number) => {
                    observedLimits.push(value);
                    return chain;
                }),
                toArray: vi.fn(async () => []),
            };
            return chain;
        });
        const stub = repositoryStub(state(), roleDocument(), 2);
        (stub.repository.collections.roles as unknown as { find: typeof find }).find = find;
        const reader = await new RbacReadStore(stub.repository, resourceSchemes).open(scope);

        const roles = await reader.readRoles(["r-1", "r-2", "r-3", "r-4", "r-5"]);
        expect(roles.size).toBe(0);
        expect(observedLimits).toEqual([2, 2, 1]);
    });
});
