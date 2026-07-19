import { describe, expect, it } from "vitest";
import { digestCanonical } from "../../src/internal/canonical";
import type { InternalRoleDocument, InternalRoleRuleDocument, InternalRoleRuleSource } from "../../src/persistence/documents";
import { loadEffectiveAuthorization } from "../../src/rbac/effective";
import type { InternalUserRoleSetView } from "../../src/rbac/materialize";
import {
    DetailBudgetAllocator,
    assertAuthorizationResponseBudget,
    fitAuthorizationPage,
} from "../../src/rbac/result";
import {
    MAX_EFFECTIVE_ROLES,
    MAX_EFFECTIVE_RULES,
    MAX_EFFECTIVE_SNAPSHOT_BYTES,
    MAX_EFFECTIVE_SOURCES,
    type RbacScopeReader,
} from "../../src/rbac/store";
import { completePermissionRuleView, permissionRuleView } from "../../src/rbac/views";

const scope = Object.freeze({ tenantId: "effective-limit-tenant" });
const scopeKey = digestCanonical(scope);
const emptyDigest = digestCanonical([]);

function role(roleId: string, parentId: string | null = null, status: InternalRoleDocument["status"] = "enabled"): InternalRoleDocument {
    return Object.freeze({
        scopeKey,
        scope,
        roleId,
        label: roleId,
        status,
        parentId,
        revision: 1,
        menuGrantCount: 0,
        menuGrantDigest: emptyDigest,
        menuSourceCount: 0,
        menuSourceDigest: emptyDigest,
        createdAt: 1,
        updatedAt: 1,
    });
}

function source(id: string): InternalRoleRuleSource {
    return { kind: "manual", sourceId: id };
}

function rule(
    roleId: string,
    index: number,
    sources: readonly InternalRoleRuleSource[] = [source(`source-${roleId}-${index}`)],
    resource = `db:resource-${index}`,
): InternalRoleRuleDocument {
    return Object.freeze({
        scopeKey,
        scope,
        roleId,
        effect: "allow",
        action: `read.${index}`,
        resource,
        semanticKey: digestCanonical({ roleId, index, resource }),
        sources: Object.freeze([...sources]),
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
    });
}

function user(roleIds: readonly string[]): InternalUserRoleSetView {
    return Object.freeze({
        scopeKey,
        scope,
        userId: "u-effective",
        roleIds: Object.freeze([...roleIds]),
        revision: 1,
        persisted: true,
        createdAt: 1,
        updatedAt: 1,
    });
}

function reader(
    roles: readonly InternalRoleDocument[],
    rules: readonly InternalRoleRuleDocument[] = [],
): RbacScopeReader {
    const byId = new Map(roles.map((entry) => [entry.roleId, entry]));
    return {
        readRoles: async (roleIds: readonly string[]) => new Map(
            roleIds.flatMap((roleId) => {
                const entry = byId.get(roleId);
                return entry ? [[roleId, entry] as const] : [];
            }),
        ),
        readRulesForRoles: async (roleIds: readonly string[]) => {
            const included = new Set(roleIds);
            return Object.freeze(rules.filter((entry) => included.has(entry.roleId)));
        },
    } as unknown as RbacScopeReader;
}

function roleChains(lengths: readonly number[]) {
    const roles: InternalRoleDocument[] = [];
    const directRoleIds: string[] = [];
    for (let chain = 0; chain < lengths.length; chain += 1) {
        const length = lengths[chain]!;
        directRoleIds.push(`chain-${chain}-0`);
        for (let depth = 0; depth < length; depth += 1) {
            roles.push(role(
                `chain-${chain}-${depth}`,
                depth + 1 < length ? `chain-${chain}-${depth + 1}` : null,
            ));
        }
    }
    return { roles, directRoleIds };
}

describe("effective authorization integrity and hard limits", () => {
    it("merges a shared ancestor once while preserving every direct path", async () => {
        const roles = [
            role("root"),
            role("child-a", "root"),
            role("child-b", "root"),
        ];
        const rootRule = rule("root", 1);
        const state = await loadEffectiveAuthorization(
            reader(roles, [rootRule]),
            user(["child-a", "child-b"]),
        );

        expect(state.roles).toEqual(expect.arrayContaining([
            expect.objectContaining({ document: expect.objectContaining({ roleId: "child-a" }), direct: true, depth: 0 }),
            expect.objectContaining({ document: expect.objectContaining({ roleId: "child-b" }), direct: true, depth: 0 }),
            expect.objectContaining({
                document: expect.objectContaining({ roleId: "root" }),
                direct: false,
                depth: 1,
                viaRoleIds: ["child-a", "child-b"],
            }),
        ]));
        expect(state.rules).toHaveLength(1);
        expect(state.rules[0]).toMatchObject({ sourceRoleId: "root", inherited: true, depth: 1 });
    });

    it("accepts a 32-role parent chain and rejects one over", async () => {
        const exact = roleChains([32]);
        await expect(loadEffectiveAuthorization(reader(exact.roles), user(exact.directRoleIds))).resolves.toMatchObject({
            usage: { effectiveRoles: 32 },
        });

        const oneOver = roleChains([33]);
        await expect(loadEffectiveAuthorization(reader(oneOver.roles), user(oneOver.directRoleIds))).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "role-chain-depth", current: 33, max: 32 }),
        });
    });

    it.each(["disabled", "deprecated"] as const)("stops inheritance at a %s role", async (status) => {
        const roles = [
            role("child", "blocked-parent"),
            role("blocked-parent", "unreachable-root", status),
            role("unreachable-root"),
        ];
        const state = await loadEffectiveAuthorization(reader(roles), user(["child"]));

        expect(state.roles).toEqual([
            expect.objectContaining({ document: expect.objectContaining({ roleId: "blocked-parent" }), included: false, excludedReason: status }),
            expect.objectContaining({ document: expect.objectContaining({ roleId: "child" }), included: true }),
        ]);
        expect(state.roles.some((entry) => entry.document.roleId === "unreachable-root")).toBe(false);
    });

    it("fails closed for missing roles and circular parent chains", async () => {
        await expect(loadEffectiveAuthorization(reader([]), user(["missing"]))).rejects.toMatchObject({
            code: "PERSISTED_STATE_INVALID",
        });
        await expect(loadEffectiveAuthorization(reader([
            role("cycle-a", "cycle-b"),
            role("cycle-b", "cycle-a"),
        ]), user(["cycle-a"]))).rejects.toMatchObject({ code: "CIRCULAR_INHERITANCE" });
    });

    it("accepts exactly 1024 effective roles and rejects one over", async () => {
        const exact = roleChains(Array.from({ length: 128 }, () => 8));
        const exactState = await loadEffectiveAuthorization(reader(exact.roles), user(exact.directRoleIds));
        expect(exactState.usage.effectiveRoles).toBe(MAX_EFFECTIVE_ROLES);

        const oneOver = roleChains([9, ...Array.from({ length: 127 }, () => 8)]);
        await expect(loadEffectiveAuthorization(reader(oneOver.roles), user(oneOver.directRoleIds))).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "effective-roles", current: MAX_EFFECTIVE_ROLES + 1 }),
        });
    });

    it("accepts exactly 20000 effective rules and rejects one over", async () => {
        const roles = Array.from({ length: 10 }, (_, index) => role(`rule-role-${index}`));
        const rules = roles.flatMap((entry, roleIndex) => Array.from(
            { length: 2_000 },
            (_, index) => rule(entry.roleId, roleIndex * 2_000 + index),
        ));
        const exact = await loadEffectiveAuthorization(reader(roles, rules), user(roles.map((entry) => entry.roleId)));
        expect(exact.usage.semanticRules).toBe(MAX_EFFECTIVE_RULES);

        await expect(loadEffectiveAuthorization(
            reader(roles, [...rules, rule(roles[0]!.roleId, MAX_EFFECTIVE_RULES)]),
            user(roles.map((entry) => entry.roleId)),
        )).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "effective-rules", current: MAX_EFFECTIVE_RULES + 1 }),
        });
    });

    it("accepts exactly 50000 source refs and rejects one over", async () => {
        const roles = Array.from({ length: 50 }, (_, index) => role(`source-role-${index}`));
        const rules = roles.map((entry, roleIndex) => rule(
            entry.roleId,
            roleIndex,
            Array.from({ length: 1_000 }, (_, index) => source(`source-${roleIndex}-${index}`)),
        ));
        const directRoleIds = roles.map((entry) => entry.roleId);
        const exact = await loadEffectiveAuthorization(reader(roles, rules), user(directRoleIds));
        expect(exact.usage.sourceRefs).toBe(MAX_EFFECTIVE_SOURCES);

        const oneOver = [
            rule(roles[0]!.roleId, 0, [...rules[0]!.sources, source("source-one-over")]),
            ...rules.slice(1),
        ];
        await expect(loadEffectiveAuthorization(reader(roles, oneOver), user(directRoleIds))).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "effective-sources", current: MAX_EFFECTIVE_SOURCES + 1 }),
        });
    });

    it("accepts an exact 8 MiB canonical snapshot and rejects one byte over", async () => {
        const onlyRole = role("snapshot-role");
        const baseRule = rule(onlyRole.roleId, 0, undefined, "");
        const base = await loadEffectiveAuthorization(
            reader([onlyRole], [baseRule]),
            user([onlyRole.roleId]),
            { enforceLimits: false },
        );
        const exactResource = "x".repeat(MAX_EFFECTIVE_SNAPSHOT_BYTES - base.usage.snapshotBytes);
        const exact = await loadEffectiveAuthorization(
            reader([onlyRole], [rule(onlyRole.roleId, 0, undefined, exactResource)]),
            user([onlyRole.roleId]),
        );
        expect(exact.usage.snapshotBytes).toBe(MAX_EFFECTIVE_SNAPSHOT_BYTES);

        await expect(loadEffectiveAuthorization(
            reader([onlyRole], [rule(onlyRole.roleId, 0, undefined, `${exactResource}x`)]),
            user([onlyRole.roleId]),
        )).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "effective-snapshot-bytes", current: MAX_EFFECTIVE_SNAPSHOT_BYTES + 1 }),
        });
    }, 15_000);

    it("fits manager pages to the largest prefix within the public response byte limit", () => {
        const entries = Array.from({ length: 40 }, (_, index) => ({
            id: index,
            payload: "x".repeat(300_000),
        }));
        const fitted = fitAuthorizationPage(entries.length, (itemCount) => {
            const result = { itemCount, items: entries.slice(0, itemCount) };
            assertAuthorizationResponseBudget(result);
            return result;
        });

        expect(fitted.itemCount).toBeGreaterThan(0);
        expect(fitted.itemCount).toBeLessThan(entries.length);
        expect(() => assertAuthorizationResponseBudget({
            items: entries.slice(0, fitted.itemCount + 1),
        })).toThrowError(expect.objectContaining({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "public-response-bytes" }),
        }));
        expect(fitAuthorizationPage(0, (itemCount) => ({ itemCount }))).toEqual({ itemCount: 0 });
        expect(() => fitAuthorizationPage(1, () => {
            const result = { payload: "x".repeat(MAX_EFFECTIVE_SNAPSHOT_BYTES) };
            assertAuthorizationResponseBudget(result);
            return result;
        })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    });

    it("derives detail digests from complete public rule projections", () => {
        const document = rule(
            "detail-role",
            1,
            Array.from({ length: 101 }, (_, index) => source(`source-${String(index).padStart(3, "0")}`)),
        );
        const budget = new DetailBudgetAllocator();
        const projected = permissionRuleView(document, new Map(), budget);
        const complete = completePermissionRuleView(document);
        const detailBudget = budget.finish([complete]);

        expect(projected.sources).toMatchObject({ total: 101, truncated: true });
        expect(projected.sources.items).toHaveLength(100);
        expect(complete.sources).toMatchObject({ total: 101, truncated: false });
        expect(complete.sources.items).toHaveLength(101);
        expect(detailBudget).toMatchObject({ returned: 100, truncated: true });
        expect(detailBudget.digest).toBe(digestCanonical([complete]));
        expect(detailBudget.digest).not.toBe(digestCanonical([projected]));
    });
});
