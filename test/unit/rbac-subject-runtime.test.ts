import { describe, expect, it } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { canonicalByteLength, digestCanonical } from "../../src/internal/canonical";
import type { InternalRoleDocument, InternalRoleRuleDocument } from "../../src/persistence/documents";
import type { PermissionRepository } from "../../src/persistence/repository";
import { createSubjectPermissionContext } from "../../src/rbac/public-context";
import type { RbacQueryService } from "../../src/rbac/queries";
import type { InternalUserRoleSetView } from "../../src/rbac/materialize";
import type { RbacScopeReader } from "../../src/rbac/store";
import { MAX_EFFECTIVE_SNAPSHOT_BYTES } from "../../src/rbac/store";
import { assertAuthorizationResponseBudget } from "../../src/rbac/result";
import {
    subjectPermissionSnapshot,
    type EffectiveAuthorizationState,
} from "../../src/rbac/effective";

const scope = Object.freeze({ tenantId: "subject-runtime-tenant" });
const scopeKey = digestCanonical(scope);
const emptyDigest = digestCanonical([]);

function role(roleId: string): InternalRoleDocument {
    return Object.freeze({
        scopeKey,
        scope,
        roleId,
        label: roleId,
        status: "enabled",
        parentId: null,
        revision: 1,
        menuGrantCount: 0,
        menuGrantDigest: emptyDigest,
        menuSourceCount: 0,
        menuSourceDigest: emptyDigest,
        createdAt: 1,
        updatedAt: 1,
    });
}

function rule(roleId: string, index: number): InternalRoleRuleDocument {
    const semanticKey = digestCanonical({ roleId, index });
    return Object.freeze({
        scopeKey,
        scope,
        roleId,
        effect: "allow",
        action: "read",
        resource: "db:orders",
        semanticKey,
        sources: Object.freeze([{ kind: "manual" as const, sourceId: `manual:${semanticKey}` }]),
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
    });
}

describe("bound subject runtime", () => {
    it("distinguishes the public response byte budget from the internal snapshot budget", () => {
        const baseBytes = canonicalByteLength({ data: "" });
        const exact = { data: "x".repeat(MAX_EFFECTIVE_SNAPSHOT_BYTES - baseBytes) };
        expect(() => assertAuthorizationResponseBudget(exact)).not.toThrow();
        expect(() => assertAuthorizationResponseBudget({ data: `${exact.data}x` })).toThrowError(
            expect.objectContaining({
                code: "LIMIT_EXCEEDED",
                details: expect.objectContaining({
                    limitName: "public-response-bytes",
                    current: MAX_EFFECTIVE_SNAPSHOT_BYTES + 1,
                    max: MAX_EFFECTIVE_SNAPSHOT_BYTES,
                }),
            }),
        );
    });

    it("shares one lazy snapshot and enforces one response-wide detail budget", async () => {
        const roles = Array.from({ length: 101 }, (_, index) => role(`role-${String(index).padStart(3, "0")}`));
        const rules = roles.map((entry, index) => rule(entry.roleId, index));
        const byRoleId = new Map(roles.map((entry) => [entry.roleId, entry]));
        const direct: InternalUserRoleSetView = Object.freeze({
            scopeKey,
            scope,
            userId: "u-runtime",
            roleIds: Object.freeze(roles.map((entry) => entry.roleId)),
            revision: 1,
            persisted: true,
            createdAt: 1,
            updatedAt: 1,
        });
        const calls = { open: 0, user: 0, roles: 0, rules: 0, verify: 0 };
        const reader = {
            state: {
                rbacRevision: 1,
                menuRevision: 1,
            },
            readUserRoleSet: async () => {
                calls.user += 1;
                return direct;
            },
            readRoles: async (roleIds: readonly string[]) => {
                calls.roles += 1;
                return new Map(roleIds.flatMap((roleId) => {
                    const entry = byRoleId.get(roleId);
                    return entry === undefined ? [] : [[roleId, entry] as const];
                }));
            },
            readRulesForRoles: async (roleIds: readonly string[]) => {
                calls.rules += 1;
                const included = new Set(roleIds);
                return Object.freeze(rules.filter((entry) => included.has(entry.roleId)));
            },
            verifyAuthorizationUnchanged: async () => {
                calls.verify += 1;
            },
        } as unknown as RbacScopeReader;
        const queryService = {
            open: async () => {
                calls.open += 1;
                return reader;
            },
        } as unknown as RbacQueryService;
        const bound = createSubjectPermissionContext(
            {} as PermissionRepository,
            queryService,
            new ResourceSchemeRegistry(),
            Object.freeze({ userId: direct.userId, scope }),
            Object.freeze({}),
            (operation) => operation(),
        );

        const [allowed, blocked, asserted, permissions, resources, explanation] = await Promise.all([
            bound.can("read", "db:orders"),
            bound.cannot("read", "db:orders"),
            bound.assert("read", "db:orders"),
            bound.getPermissions(),
            bound.getResources("read"),
            bound.explain("read", "db:orders"),
        ]);

        expect({ allowed, blocked, asserted }).toEqual({ allowed: true, blocked: false, asserted: undefined });
        expect(calls).toEqual({ open: 1, user: 1, roles: 1, rules: 1, verify: 1 });
        expect(permissions.detailBudget).toMatchObject({ limit: 100, returned: 100, truncated: true });
        expect(permissions.data.roles).toMatchObject({ total: 101, items: expect.any(Array), truncated: true });
        expect(permissions.data.roles.items).toHaveLength(100);
        expect(permissions.data.rules).toMatchObject({ total: 101, items: [], truncated: true });
        expect(resources.data).toHaveLength(1);
        expect(resources.data[0]!.sourceRoleIds).toMatchObject({ total: 101, truncated: true });
        expect(resources.data[0]!.sourceRoleIds.items).toHaveLength(100);
        expect(resources.detailBudget).toMatchObject({ returned: 100, truncated: true });
        expect(explanation.data).toMatchObject({ allowed: true, reason: "allow" });
        expect(explanation.data.evaluations[0]!.evaluatedAllows).toMatchObject({ total: 101, truncated: true });
        expect(explanation.detailBudget).toMatchObject({ returned: 100, truncated: true });
        expect(Object.isFrozen(permissions.data.roles.items)).toBe(true);
        expect(Object.isFrozen(resources.data[0]!.sourceRoleIds.items)).toBe(true);
        expect(Object.isFrozen(explanation.data.evaluations[0]!.evaluatedAllows.items)).toBe(true);
        expect(JSON.stringify(permissions.data)).not.toMatch(/revision|semanticKey|sourceId|grantId|auditId|createdAt|updatedAt/u);
    });

    it("keeps conditional state local to each canonical conflict group", () => {
        const sourceRole = role("role-conflict");
        const direct: InternalUserRoleSetView = Object.freeze({
            scopeKey,
            scope,
            userId: "u-conflict",
            roleIds: Object.freeze([sourceRole.roleId]),
            revision: 1,
            persisted: true,
            createdAt: 1,
            updatedAt: 1,
        });
        const conditionalWhere = Object.freeze({ field: "status", op: "eq" as const, value: "paid" });
        const documents = [
            rule(sourceRole.roleId, 1),
            Object.freeze({ ...rule(sourceRole.roleId, 2), effect: "deny" as const }),
            Object.freeze({ ...rule(sourceRole.roleId, 3), where: conditionalWhere }),
            Object.freeze({ ...rule(sourceRole.roleId, 4), effect: "deny" as const, where: conditionalWhere }),
        ];
        const state: EffectiveAuthorizationState = Object.freeze({
            direct,
            roles: Object.freeze([Object.freeze({
                document: sourceRole,
                direct: true,
                viaRoleIds: Object.freeze([sourceRole.roleId]),
                depth: 0,
                included: true,
            })]),
            rules: Object.freeze(documents.map((document) => Object.freeze({
                document,
                sourceRoleId: sourceRole.roleId,
                inherited: false,
                depth: 0,
            }))),
            sourceViews: new Map(),
            usage: Object.freeze({ effectiveRoles: 1, semanticRules: 4, sourceRefs: 4, snapshotBytes: 0 }),
        });

        const { snapshot } = subjectPermissionSnapshot(scope, state);

        expect(snapshot.conflicts.total).toBe(2);
        expect(snapshot.conflicts.items.map((entry) => entry.conditional).sort()).toEqual([false, true]);
    });
});
