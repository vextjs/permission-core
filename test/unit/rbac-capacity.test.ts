import { describe, expect, it } from "vitest";
import { digestCanonical } from "../../src/internal/canonical";
import type { InternalRoleDocument, InternalRoleRuleDocument } from "../../src/persistence/documents";
import type { PermissionRepository } from "../../src/persistence/repository";
import { assessAuthorizationCapacity, type AffectedUsers } from "../../src/rbac/capacity";
import type { InternalUserRoleSetView } from "../../src/rbac/materialize";
import type { RbacScopeReader } from "../../src/rbac/store";

const scope = Object.freeze({ tenantId: "capacity-tenant" });
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

function rule(roleId: string, index: number, effect: "allow" | "deny" = "allow"): InternalRoleRuleDocument {
    const semanticKey = digestCanonical({ roleId, index, effect });
    return Object.freeze({
        scopeKey,
        scope,
        roleId,
        effect,
        action: `action.${index}`,
        resource: "db:orders",
        semanticKey,
        sources: Object.freeze([{ kind: "manual" as const, sourceId: `manual:${semanticKey}` }]),
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
    });
}

function user(roleIds: readonly string[], userId = "u-capacity"): InternalUserRoleSetView {
    return Object.freeze({
        scopeKey,
        scope,
        userId,
        roleIds: Object.freeze([...roleIds]),
        revision: 1,
        persisted: true,
        createdAt: 1,
        updatedAt: 1,
    });
}

function countingReader(
    roles: readonly InternalRoleDocument[],
    rules: readonly InternalRoleRuleDocument[],
) {
    const counts = { roles: 0, rules: 0 };
    const base = reader(roles, rules);
    const value = {
        readRoles: async (ids: readonly string[]) => {
            counts.roles += 1;
            return base.readRoles(ids);
        },
        readRulesForRoles: async (ids: readonly string[]) => {
            counts.rules += 1;
            return base.readRulesForRoles(ids);
        },
    } as unknown as RbacScopeReader;
    return { counts, value };
}

function reader(roles: readonly InternalRoleDocument[], rules: readonly InternalRoleRuleDocument[]): RbacScopeReader {
    const byId = new Map(roles.map((entry) => [entry.roleId, entry]));
    return {
        readRoles: async (ids: readonly string[]) => new Map(ids.flatMap((id) => {
            const entry = byId.get(id);
            return entry ? [[id, entry] as const] : [];
        })),
        readRulesForRoles: async (ids: readonly string[]) => {
            const included = new Set(ids);
            return Object.freeze(rules.filter((entry) => included.has(entry.roleId)));
        },
    } as unknown as RbacScopeReader;
}

function affected(entry: InternalUserRoleSetView, total = 1): AffectedUsers {
    return Object.freeze({
        total,
        evaluated: Object.freeze([entry]),
        sampleIds: Object.freeze([entry.userId]),
        digest: digestCanonical({ total, userId: entry.userId }),
    });
}

describe("authorization capacity assessment", () => {
    it("reuses role and rule reads across a bounded affected-user assessment", async () => {
        const sharedRole = role("shared-reader");
        const allow = rule(sharedRole.roleId, 1);
        const measured = countingReader([sharedRole], [allow]);
        const evaluated = Object.freeze(Array.from(
            { length: 100 },
            (_, index) => user([sharedRole.roleId], `u-${String(index).padStart(3, "0")}`),
        ));

        await expect(assessAuthorizationCapacity({
            repository: {} as PermissionRepository,
            reader: measured.value,
            affectedUsers: Object.freeze({
                total: evaluated.length,
                evaluated,
                sampleIds: Object.freeze(evaluated.map((entry) => entry.userId)),
                digest: digestCanonical(evaluated.map((entry) => entry.userId)),
            }),
            overlay: { rulesByRoleId: new Map([[sharedRole.roleId, [allow]]]) },
            structuralCapacityNonIncreasing: false,
            knownCapacityRiskMayBeAcknowledged: false,
            accessHint: "expand",
        })).resolves.toMatchObject({ proof: "exact", evaluatedUsers: 100 });

        expect(measured.counts).toEqual({ roles: 1, rules: 1 });
    });

    it("distinguishes exact, partial, and conservative proofs", async () => {
        const onlyRole = role("reader");
        const direct = user([onlyRole.roleId]);
        const allow = rule(onlyRole.roleId, 1);
        const common = {
            repository: {} as PermissionRepository,
            reader: reader([onlyRole], []),
            affectedUsers: affected(direct),
            overlay: { rulesByRoleId: new Map([[onlyRole.roleId, [allow]]]) },
            structuralCapacityNonIncreasing: false,
            knownCapacityRiskMayBeAcknowledged: false,
            accessHint: "expand" as const,
        };
        await expect(assessAuthorizationCapacity(common)).resolves.toMatchObject({
            proof: "exact",
            disposition: "safe",
            accessDirection: "expand",
            capacityDirection: "expanding",
            evaluatedUsers: 1,
            unverifiedUsers: 0,
        });

        await expect(assessAuthorizationCapacity({
            ...common,
            affectedUsers: affected(direct, 1_001),
        })).resolves.toMatchObject({
            proof: "partial",
            disposition: "ack-required",
            evaluatedUsers: 1,
            unverifiedUsers: 1_000,
        });

        await expect(assessAuthorizationCapacity({
            ...common,
            reader: reader([onlyRole], [allow]),
            affectedUsers: affected(direct, 1_001),
            overlay: { rulesByRoleId: new Map([[onlyRole.roleId, []]]) },
            structuralCapacityNonIncreasing: true,
            accessHint: "restrict",
        })).resolves.toMatchObject({
            proof: "conservative",
            disposition: "safe",
            accessDirection: "restrict",
            capacityDirection: "non-increasing",
            unverifiedUsers: 1_000,
        });
    });

    it("compares distinct before and after readers for availability-only changes", async () => {
        const onlyRole = role("availability-reader");
        const allow = rule(onlyRole.roleId, 1);
        const direct = user([onlyRole.roleId]);

        await expect(assessAuthorizationCapacity({
            repository: {} as PermissionRepository,
            reader: reader([onlyRole], [allow]),
            beforeReader: reader([onlyRole], [allow]),
            afterReader: reader([onlyRole], []),
            affectedUsers: affected(direct),
            overlay: {},
            structuralCapacityNonIncreasing: true,
            knownCapacityRiskMayBeAcknowledged: false,
            accessHint: "restrict",
        })).resolves.toMatchObject({
            proof: "exact",
            disposition: "safe",
            accessDirection: "restrict",
            capacityDirection: "non-increasing",
        });
    });

    it("blocks a known expansion over capacity but permits explicit deny acknowledgement", async () => {
        const roles = Array.from({ length: 10 }, (_, index) => role(`capacity-role-${index}`));
        const beforeRules = roles.flatMap((entry, roleIndex) => Array.from(
            { length: 2_000 },
            (_, index) => rule(entry.roleId, roleIndex * 2_000 + index),
        ));
        const direct = user(roles.map((entry) => entry.roleId));
        const targetRules = beforeRules.filter((entry) => entry.roleId === roles[0]!.roleId);
        const common = {
            repository: {} as PermissionRepository,
            reader: reader(roles, beforeRules),
            affectedUsers: affected(direct),
            structuralCapacityNonIncreasing: false,
        };

        await expect(assessAuthorizationCapacity({
            ...common,
            overlay: { rulesByRoleId: new Map([[
                roles[0]!.roleId,
                [...targetRules, rule(roles[0]!.roleId, 20_000, "allow")],
            ]]) },
            knownCapacityRiskMayBeAcknowledged: false,
            accessHint: "expand",
        })).resolves.toMatchObject({
            proof: "exact",
            disposition: "blocked",
            violatingUsers: { total: 1 },
            maxEvaluated: { semanticRules: 20_001 },
        });

        await expect(assessAuthorizationCapacity({
            ...common,
            overlay: { rulesByRoleId: new Map([[
                roles[0]!.roleId,
                [...targetRules, rule(roles[0]!.roleId, 20_000, "deny")],
            ]]) },
            knownCapacityRiskMayBeAcknowledged: true,
            accessHint: "restrict",
        })).resolves.toMatchObject({
            proof: "exact",
            disposition: "ack-required",
            accessDirection: "restrict",
            violatingUsers: { total: 1 },
        });

        const overLimitRules = [...beforeRules, rule(roles[0]!.roleId, 20_000, "allow")];
        await expect(assessAuthorizationCapacity({
            ...common,
            reader: reader(roles, overLimitRules),
            overlay: { rulesByRoleId: new Map([[roles[0]!.roleId, targetRules]]) },
            structuralCapacityNonIncreasing: true,
            knownCapacityRiskMayBeAcknowledged: false,
            accessHint: "restrict",
        })).resolves.toMatchObject({
            proof: "exact",
            disposition: "safe",
            accessDirection: "restrict",
            maxEvaluated: { semanticRules: 20_000 },
            violatingUsers: { total: 0 },
        });
    }, 15_000);
});
