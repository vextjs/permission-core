import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, compareUtf8, digestCanonical } from "../../src/internal/canonical";
import type {
    InternalRoleMenuGrantDocument,
    InternalRoleRuleDocument,
    InternalRoleRuleSource,
} from "../../src/persistence/documents";
import { PermissionRepository } from "../../src/persistence/repository";
import {
    menuNodeDocumentFromInput,
    normalizeMenuGrantIntent,
    normalizeMenuNodeCreateInput,
    planMenuAggregate,
    RoleMenuAuthorizationResolver,
} from "../../src/menu";
import {
    createRoleMenuAggregateFields,
    createRoleMenuGrantSnapshot,
} from "../../src/menu/source-rewrite";
import {
    createMenuSourceId,
    createSemanticKey,
    MAX_ROLE_CHAIN_DEPTH,
    MAX_RULE_SOURCES,
    MAX_RULES_PER_ROLE,
    RbacReadStore,
    RoleMutationService,
    RuleMutationService,
    UserRoleMutationService,
} from "../../src/rbac";
import { RbacScopeReader } from "../../src/rbac/store";
import { normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
let scopeSequence = 0;

function nextScope(label: string) {
    scopeSequence += 1;
    return { tenantId: `b3-${label}-${scopeSequence}` };
}

async function seedRealMenuSources(input: {
    repository: PermissionRepository;
    schemes: ResourceSchemeRegistry;
    scope: ReturnType<typeof nextScope>;
    roleId: string;
    sourceCount: number;
}) {
    const normalizedScope = normalizeScope(input.scope);
    const scopeKey = digestCanonical(normalizedScope);
    const semanticKey = createSemanticKey("allow", "read", "db:orders");
    const now = await input.repository.getDatabaseTime();
    await input.repository.withTransaction(async (transaction) => {
        const state = await input.repository.scopeStates.read(normalizedScope, transaction.session);
        const reader = new RbacScopeReader(
            input.repository,
            input.schemes,
            state,
            transaction.session,
        );
        const role = await reader.requireRole(input.roleId);
        const existing = await reader.readRule(input.roleId, semanticKey);
        const groupSizes: number[] = [];
        for (let remaining = input.sourceCount; remaining > 0; remaining -= 1_000) {
            groupSizes.push(Math.min(remaining, 1_000));
        }
        const nodes = groupSizes.flatMap((groupSize, groupIndex) => {
            const rootId = `asset-${groupIndex}-0`;
            return Array.from({ length: groupSize }, (_, index) => menuNodeDocumentFromInput(
                state.scopeKey,
                state.scope,
                normalizeMenuNodeCreateInput({
                    id: `asset-${groupIndex}-${index}`,
                    ...(index === 0 ? {} : { parentId: rootId }),
                    type: "directory",
                    title: `Asset ${groupIndex}-${index}`,
                    permission: { action: "read", resource: "db:orders" },
                }, input.schemes),
                index === 0 ? groupIndex : index - 1,
                1,
                now,
            ));
        });
        const sources = nodes.map((node, index): Extract<InternalRoleRuleSource, { kind: "menu" }> => {
            const groupIndex = groupSizes.findIndex((_size, candidate) => {
                const start = groupSizes.slice(0, candidate).reduce((total, size) => total + size, 0);
                return index >= start && index < start + groupSizes[candidate]!;
            });
            const intent = normalizeMenuGrantIntent({
                anchorId: `asset-${groupIndex}-0`,
                include: { descendants: true, buttons: false, apis: "none", dataPermissions: false },
                apiChoices: { bindingIds: [], permissionsByBinding: {} },
            });
            const grantId = `grant_${digestCanonical({
                scopeHash: scopeKey,
                roleId: input.roleId,
                effect: "allow",
                intent,
            })}`;
            return {
                kind: "menu",
                sourceId: createMenuSourceId({
                    grantId,
                    semanticKey,
                    contribution: "node",
                    assetId: node.nodeId,
                }),
                grantId,
                grantRevision: 1,
                effect: "allow",
                contribution: "node",
                assetId: node.nodeId,
            };
        }).sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
        const nextRule: InternalRoleRuleDocument = existing === null
            ? {
                scopeKey: state.scopeKey,
                scope: state.scope,
                roleId: input.roleId,
                effect: "allow",
                action: "read",
                resource: "db:orders",
                semanticKey,
                sources,
                revision: 1,
                createdAt: now,
                updatedAt: now,
            }
            : {
                ...existing,
                sources: [...existing.sources, ...sources].sort((left, right) => compareUtf8(left.sourceId, right.sourceId)),
                revision: existing.revision + 1,
                updatedAt: now,
            };
        const grants: InternalRoleMenuGrantDocument[] = groupSizes.map((_size, groupIndex) => {
            const intent = normalizeMenuGrantIntent({
                anchorId: `asset-${groupIndex}-0`,
                include: { descendants: true, buttons: false, apis: "none", dataPermissions: false },
                apiChoices: { bindingIds: [], permissionsByBinding: {} },
            });
            const grantId = `grant_${digestCanonical({
                scopeHash: scopeKey,
                roleId: input.roleId,
                effect: "allow",
                intent,
            })}`;
            const grantSources = sources.filter((source) => source.grantId === grantId);
            return {
                scopeKey: state.scopeKey,
                scope: state.scope,
                roleId: input.roleId,
                grantId,
                effect: "allow",
                intent,
                snapshot: createRoleMenuGrantSnapshot(
                    intent,
                    grantSources.map((source) => ({ rule: nextRule, source })),
                ),
                grantRevision: 1,
                createdAt: now,
                updatedAt: now,
            };
        });
        const menuAggregate = planMenuAggregate({ state, afterNodes: nodes });
        const roleAggregate = createRoleMenuAggregateFields(grants, [nextRule]);

        const insertedNodes = await input.repository.collections.menuNodes.insertMany(
            nodes.map((node) => ({ ...node })),
            { session: transaction.session, cache: { invalidate: false } },
        );
        expect(insertedNodes.insertedCount).toBe(nodes.length);
        const insertedGrants = await input.repository.collections.roleMenuGrants.insertMany(
            grants.map((grant) => ({ ...grant })),
            { session: transaction.session, cache: { invalidate: false } },
        );
        expect(insertedGrants.insertedCount).toBe(grants.length);
        if (existing === null) {
            await input.repository.collections.roleRules.insertOne(
                { ...nextRule, sources: nextRule.sources.map((source) => ({ ...source })) },
                { session: transaction.session, cache: { invalidate: false } },
            );
        } else {
            const result = await input.repository.collections.roleRules.updateOne(
                { scopeKey: state.scopeKey, roleId: input.roleId, semanticKey, revision: existing.revision },
                { $set: { sources: nextRule.sources, revision: nextRule.revision, updatedAt: now } },
                { session: transaction.session, cache: { invalidate: false } },
            );
            expect(result).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
        }
        const roleResult = await input.repository.collections.roles.updateOne(
            { scopeKey: state.scopeKey, roleId: input.roleId, revision: role.revision },
            { $set: { ...roleAggregate, revision: role.revision + 1, updatedAt: now } },
            { session: transaction.session, cache: { invalidate: false } },
        );
        expect(roleResult).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
        const stateResult = await input.repository.collections.scopeState.updateOne(
            {
                scopeKey: state.scopeKey,
                revision: state.revision,
                rbacRevision: state.rbacRevision,
                menuRevision: state.menuRevision,
            },
            {
                $set: {
                    ...menuAggregate,
                    revision: state.revision + 1,
                    rbacRevision: state.rbacRevision + 1,
                    menuRevision: state.menuRevision + 1,
                    updatedAt: now,
                },
            },
            { session: transaction.session, cache: { invalidate: false } },
        );
        expect(stateResult).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    });
    return semanticKey;
}

describe("B3 RBAC transactions on MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let repository: PermissionRepository;
    let schemes: ResourceSchemeRegistry;
    let roles: RoleMutationService;
    let rules: RuleMutationService;
    let userRoles: UserRoleMutationService;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 199 });
        schemes = new ResourceSchemeRegistry();
        repository = new PermissionRepository(context.monsqlize, "pc_b3", {
            schemeContractDigest: schemes.schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: 2,
                schemeContractDigest: schemes.schemeContractDigest,
            }),
        });
        await repository.ensureIndexes();
        await repository.probeTransaction();
        roles = new RoleMutationService(repository, schemes);
        rules = new RuleMutationService(
            repository,
            schemes,
            undefined,
            new RoleMenuAuthorizationResolver(repository, schemes),
        );
        userRoles = new UserRoleMutationService(repository, schemes);
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    });

    it("creates a role atomically and replays the original committed response", async () => {
        const scope = nextScope("create");
        const input = { id: "operator", label: "Operator" };
        const options = { actorId: "admin", idempotencyKey: "create-operator" };
        const first = await roles.create(scope, input, options);
        const replay = await roles.create(scope, input, options);

        expect(first).toMatchObject({
            committed: true,
            changed: true,
            data: { id: "operator", status: "enabled", parentId: null, revision: 1 },
            revision: 1,
            revisions: { global: 1, rbac: 1, menu: 0, audit: 1 },
            replayed: false,
            cache: { status: "bypassed" },
        });
        expect(replay).toMatchObject({
            operationId: first.operationId,
            auditId: first.auditId,
            changed: true,
            replayed: true,
            data: first.data,
            cache: { status: "bypassed" },
        });
        expect(await repository.collections.roles.count({ tenantId: "untrusted" }, { cache: 0 })).toBe(0);
        expect(await repository.collections.roles.count({}, { cache: 0 })).toBeGreaterThanOrEqual(1);
        expect(await repository.collections.auditEntries.count({ operationId: first.operationId }, { cache: 0 })).toBe(1);
        expect(await repository.scopeStates.read(scope)).toMatchObject({
            revision: 1,
            rbacRevision: 1,
            menuRevision: 0,
            auditRevision: 2,
        });

        await expect(roles.create(scope, input, { actorId: "admin" })).rejects.toMatchObject({
            code: "ROLE_ALREADY_EXISTS",
        });
    }, TEST_TIMEOUT);

    it("rolls back virgin scope state when the requested parent does not exist", async () => {
        const scope = nextScope("rollback");
        await expect(roles.create(scope, {
            id: "child",
            label: "Child",
            parentId: "missing",
        }, { actorId: "admin" })).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });

        expect(await repository.scopeStates.read(scope)).toMatchObject({ persisted: false, revision: 0, auditRevision: 0 });
        const scopeKey = digestCanonical(scope);
        expect(await repository.collections.roles.count({ scopeKey }, { cache: 0 })).toBe(0);
        expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(0);
    }, TEST_TIMEOUT);

    it("separates changed, no-op, and stale metadata updates", async () => {
        const scope = nextScope("update");
        await roles.create(scope, { id: "reader", label: "Reader" });

        const changed = await roles.update(scope, "reader", {
            label: "Order reader",
            description: "Reads orders",
        }, {
            expectedRevision: 1,
            actorId: "admin",
            idempotencyKey: "update-reader",
        });
        const unchanged = await roles.update(scope, "reader", {
            label: "Order reader",
            description: "Reads orders",
        }, {
            expectedRevision: 2,
            actorId: "admin",
        });

        expect(changed).toMatchObject({
            changed: true,
            revision: 2,
            data: { label: "Order reader", description: "Reads orders", revision: 2 },
            revisions: { global: 2, rbac: 2, audit: 3 },
        });
        expect(unchanged).toMatchObject({
            changed: false,
            revision: 2,
            data: changed.data,
            revisions: { global: 2, rbac: 2, audit: 5 },
            cache: { status: "not-needed" },
        });
        await expect(roles.update(scope, "reader", { label: "Stale" }, {
            expectedRevision: 1,
        })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
        expect(await repository.scopeStates.read(scope)).toMatchObject({
            revision: 2,
            rbacRevision: 2,
            auditRevision: 5,
        });
    }, TEST_TIMEOUT);

    it("protects role dependencies and removes only an empty role", async () => {
        const scope = nextScope("remove");
        const parent = await roles.create(scope, { id: "parent", label: "Parent" });
        const child = await roles.create(scope, { id: "child", label: "Child", parentId: "parent" });

        await expect(roles.remove(scope, "parent", {
            expectedRevision: parent.data.revision,
        })).rejects.toMatchObject({ code: "ROLE_IN_USE" });
        const childRemoved = await roles.remove(scope, "child", {
            expectedRevision: child.data.revision,
        });
        const parentRemoved = await roles.remove(scope, "parent", {
            expectedRevision: parent.data.revision,
        });
        expect(childRemoved).toMatchObject({ changed: true, data: { removedRoleId: "child" }, revision: 2 });
        expect(parentRemoved).toMatchObject({ changed: true, data: { removedRoleId: "parent" }, revision: 2 });

        const scopeKey = digestCanonical(scope);
        expect(await repository.collections.roles.count({ scopeKey }, { cache: 0 })).toBe(0);
        expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(4);
    }, TEST_TIMEOUT);

    it("adds semantic manual rules, preserves no-op revisions, and replays exact responses", async () => {
        const scope = nextScope("rules-upsert");
        await roles.create(scope, { id: "operator", label: "Operator" });
        const readRule = {
            action: "read" as const,
            resource: "db:orders",
            where: { field: "merchantId", op: "eq" as const, valueFrom: "claims.merchantId" },
        };
        const first = await rules.allow(scope, "operator", readRule, {
            actorId: "admin",
            idempotencyKey: "allow-orders",
        });
        const replay = await rules.allow(scope, "operator", readRule, {
            actorId: "admin",
            idempotencyKey: "allow-orders",
        });
        const duplicate = await rules.allow(scope, "operator", readRule, { actorId: "admin" });
        const denied = await rules.deny(scope, "operator", {
            action: "delete",
            resource: "db:orders",
        });

        expect(first).toMatchObject({
            changed: true,
            revision: 2,
            replayed: false,
            data: {
                effect: "allow",
                action: "read",
                resource: "db:orders",
                sources: {
                    total: 1,
                    truncated: false,
                    items: [{ kind: "manual", state: "active" }],
                },
            },
        });
        expect(replay).toMatchObject({
            operationId: first.operationId,
            auditId: first.auditId,
            changed: true,
            revision: 2,
            replayed: true,
            data: first.data,
        });
        expect(duplicate).toMatchObject({
            changed: false,
            revision: 2,
            replayed: false,
            cache: { status: "not-needed" },
            data: first.data,
        });
        expect(denied).toMatchObject({ changed: true, revision: 3, data: { effect: "deny" } });

        const scopeKey = digestCanonical(scope);
        expect(await repository.collections.roleRules.count({ scopeKey, roleId: "operator" }, { cache: 0 })).toBe(2);
        expect(await repository.collections.roles.findOne({ scopeKey, roleId: "operator" }, { cache: 0 })).toMatchObject({
            revision: 3,
        });
        expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(4);
    }, TEST_TIMEOUT);

    it("revokes only the selected manual source and returns a bounded aggregate", async () => {
        const scope = nextScope("rules-revoke");
        await roles.create(scope, { id: "reader", label: "Reader" });
        const rule = { action: "read" as const, resource: "db:orders" };
        const allowed = await rules.allow(scope, "reader", rule);
        const missing = await rules.revoke(scope, "reader", {
            effect: "deny",
            action: "read",
            resource: "db:missing",
        });
        const removed = await rules.revoke(scope, "reader", {
            effect: "allow",
            ...rule,
            semanticKey: allowed.data.semanticKey,
        }, {
            actorId: "admin",
            idempotencyKey: "revoke-orders",
        });
        const replay = await rules.revoke(scope, "reader", {
            effect: "allow",
            ...rule,
            semanticKey: allowed.data.semanticKey,
        }, {
            actorId: "admin",
            idempotencyKey: "revoke-orders",
        });

        expect(missing).toMatchObject({
            changed: false,
            revision: 2,
            data: { removed: 0, remainingCount: 1 },
            cache: { status: "not-needed" },
        });
        expect(missing.data.remainingDigest).toBe(digestCanonical([allowed.data.semanticKey]));
        expect(removed).toMatchObject({
            changed: true,
            revision: 3,
            data: { removed: 1, remainingCount: 0, remainingDigest: digestCanonical([]) },
        });
        expect(replay).toMatchObject({
            operationId: removed.operationId,
            auditId: removed.auditId,
            replayed: true,
            data: removed.data,
        });

        const scopeKey = digestCanonical(scope);
        expect(await repository.collections.roleRules.count({ scopeKey, roleId: "reader" }, { cache: 0 })).toBe(0);
        expect(await repository.collections.roles.findOne({ scopeKey, roleId: "reader" }, { cache: 0 })).toMatchObject({
            revision: 3,
        });
        expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(4);
    }, TEST_TIMEOUT);

    it("rolls back invalid manual rule writes and isolates identical role identities by scope", async () => {
        const virgin = nextScope("rules-unknown");
        await expect(rules.allow(virgin, "missing", {
            action: "read",
            resource: "db:orders",
        })).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
        expect(await repository.scopeStates.read(virgin)).toMatchObject({ persisted: false, revision: 0, auditRevision: 0 });

        const deprecatedScope = nextScope("rules-deprecated");
        await roles.create(deprecatedScope, {
            id: "retired",
            label: "Retired",
            status: "deprecated",
        });
        await expect(rules.allow(deprecatedScope, "retired", {
            action: "read",
            resource: "db:orders",
        })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(roles.update(deprecatedScope, "retired", { label: "Still retired" }, {
            expectedRevision: 1,
        })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(rules.revoke(deprecatedScope, "retired", {
            effect: "allow",
            action: "read",
            resource: "db:orders",
        })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        const deprecatedScopeKey = digestCanonical(deprecatedScope);
        expect(await repository.collections.roleRules.count({ scopeKey: deprecatedScopeKey }, { cache: 0 })).toBe(0);
        expect(await repository.collections.auditEntries.count({ scopeKey: deprecatedScopeKey }, { cache: 0 })).toBe(1);

        const firstScope = nextScope("rules-tenant-a");
        const secondScope = nextScope("rules-tenant-b");
        await roles.create(firstScope, { id: "reader", label: "Reader A" });
        await roles.create(secondScope, { id: "reader", label: "Reader B" });
        await rules.allow(firstScope, "reader", { action: "read", resource: "db:orders" });
        expect(await repository.collections.roleRules.count({
            scopeKey: digestCanonical(firstScope),
            roleId: "reader",
        }, { cache: 0 })).toBe(1);
        expect(await repository.collections.roleRules.count({
            scopeKey: digestCanonical(secondScope),
            roleId: "reader",
        }, { cache: 0 })).toBe(0);
    }, TEST_TIMEOUT);

    it("maintains user role aggregate revisions across assign, set, revoke, and clear", async () => {
        const scope = nextScope("user-lifecycle");
        await roles.create(scope, { id: "z-role", label: "Z role" });
        await roles.create(scope, { id: "a-role", label: "A role" });

        const first = await userRoles.assign(scope, "u-1", "z-role", {
            actorId: "admin",
            idempotencyKey: "assign-z",
        });
        const replay = await userRoles.assign(scope, "u-1", "z-role", {
            actorId: "admin",
            idempotencyKey: "assign-z",
        });
        const duplicate = await userRoles.assign(scope, "u-1", "z-role");
        const second = await userRoles.assign(scope, "u-1", "a-role");
        const sameSet = await userRoles.set(scope, "u-1", ["z-role", "a-role"], {
            expectedRevision: 2,
        });
        const reduced = await userRoles.set(scope, "u-1", ["z-role"], {
            expectedRevision: 2,
        });
        const cleared = await userRoles.clear(scope, "u-1", { expectedRevision: 3 });
        const clearAgain = await userRoles.clear(scope, "u-1", { expectedRevision: 4 });

        expect(first).toMatchObject({
            changed: true,
            revision: 1,
            replayed: false,
            data: { userId: "u-1", roleIds: ["z-role"], revision: 1, persisted: true },
        });
        expect(first.data.createdAt).toBeTypeOf("number");
        expect(first.data.updatedAt).toBeTypeOf("number");
        expect(replay).toMatchObject({
            operationId: first.operationId,
            auditId: first.auditId,
            replayed: true,
            data: first.data,
        });
        expect(duplicate).toMatchObject({
            changed: false,
            revision: 1,
            cache: { status: "not-needed" },
        });
        expect(second).toMatchObject({
            changed: true,
            revision: 2,
            data: { roleIds: ["a-role", "z-role"], persisted: true },
        });
        expect(sameSet).toMatchObject({ changed: false, revision: 2, data: second.data });
        expect(reduced).toMatchObject({ changed: true, revision: 3, data: { roleIds: ["z-role"] } });
        expect(cleared).toMatchObject({
            changed: true,
            revision: 4,
            data: { roleIds: [], revision: 4, persisted: true },
        });
        expect(clearAgain).toMatchObject({
            changed: false,
            revision: 4,
            data: cleared.data,
            cache: { status: "not-needed" },
        });
        await expect(userRoles.set(scope, "u-1", ["a-role"], {
            expectedRevision: 3,
        })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

        const scopeKey = digestCanonical(scope);
        expect(await repository.collections.userRoleSets.findOne({ scopeKey, userId: "u-1" }, { cache: 0 })).toMatchObject({
            roleIds: [],
            revision: 4,
        });
        expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(9);
    }, TEST_TIMEOUT);

    it("keeps virgin user sets virtual and rejects unknown or inactive role assignments without residue", async () => {
        const scope = nextScope("user-virtual");
        const clear = await userRoles.clear(scope, "never-seen", { expectedRevision: 0 });
        const emptySet = await userRoles.set(scope, "also-new", [], { expectedRevision: 0 });
        const missingRevoke = await userRoles.revoke(scope, "never-seen", "unknown-role");

        expect(clear).toMatchObject({
            changed: false,
            revision: 0,
            data: { userId: "never-seen", roleIds: [], revision: 0, persisted: false },
        });
        expect(clear.data).not.toHaveProperty("createdAt");
        expect(clear.data).not.toHaveProperty("updatedAt");
        expect(emptySet).toMatchObject({ changed: false, revision: 0, data: { persisted: false } });
        expect(missingRevoke).toMatchObject({ changed: false, revision: 0, data: { persisted: false } });

        await roles.create(scope, { id: "disabled", label: "Disabled", status: "disabled" });
        await expect(userRoles.assign(scope, "u-1", "missing")).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
        await expect(userRoles.assign(scope, "u-1", "disabled")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(userRoles.set(scope, "u-1", ["disabled"], {
            expectedRevision: 0,
        })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

        const scopeKey = digestCanonical(scope);
        expect(await repository.collections.userRoleSets.count({ scopeKey }, { cache: 0 })).toBe(0);
        expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(4);
    }, TEST_TIMEOUT);

    it("merges concurrent first assignments and preserves tenant isolation", async () => {
        const scope = nextScope("user-concurrent");
        await roles.create(scope, { id: "reader", label: "Reader" });
        await roles.create(scope, { id: "operator", label: "Operator" });
        const results = await Promise.all([
            userRoles.assign(scope, "u-concurrent", "reader"),
            userRoles.assign(scope, "u-concurrent", "operator"),
        ]);
        expect(results.every((result) => result.changed)).toBe(true);
        expect(results.map((result) => result.revision).sort((left, right) => left - right)).toEqual([1, 2]);
        expect(await repository.collections.userRoleSets.findOne({
            scopeKey: digestCanonical(scope),
            userId: "u-concurrent",
        }, { cache: 0 })).toMatchObject({
            roleIds: ["operator", "reader"],
            revision: 2,
        });

        const otherScope = nextScope("user-concurrent-other");
        await roles.create(otherScope, { id: "reader", label: "Other reader" });
        await userRoles.assign(otherScope, "u-concurrent", "reader");
        expect(await repository.collections.userRoleSets.findOne({
            scopeKey: digestCanonical(otherScope),
            userId: "u-concurrent",
        }, { cache: 0 })).toMatchObject({ roleIds: ["reader"], revision: 1 });
        expect(await repository.collections.userRoleSets.findOne({
            scopeKey: digestCanonical(scope),
            userId: "u-concurrent",
        }, { cache: 0 })).toMatchObject({ roleIds: ["operator", "reader"], revision: 2 });
    }, TEST_TIMEOUT);

    it("round-trips 24-hex permission identities without changing host collection conversion", async () => {
        const tenantId = "a".repeat(24);
        const roleId = "b".repeat(24);
        const userId = "c".repeat(24);
        const actorId = "d".repeat(24);
        const requestId = "e".repeat(24);
        const scope = { tenantId };
        const created = await roles.create(scope, { id: roleId, label: "Hex role" }, {
            actorId,
            requestId,
            idempotencyKey: "create-hex-role",
        });
        await userRoles.assign(scope, userId, roleId, {
            actorId,
            idempotencyKey: "assign-hex-role",
        });

        const schemes = new ResourceSchemeRegistry();
        const restarted = new PermissionRepository(context.monsqlize, "pc_b3", {
            schemeContractDigest: schemes.schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: 2,
                schemeContractDigest: schemes.schemeContractDigest,
            }),
        });
        const reader = await new RbacReadStore(restarted, schemes).open(scope);
        await expect(reader.requireRole(roleId)).resolves.toMatchObject({ roleId });
        await expect(reader.readUserRoleSet(userId)).resolves.toMatchObject({ userId, roleIds: [roleId] });
        const audit = await restarted.collections.auditEntries.findOne(
            { operationId: created.operationId },
            { cache: 0 },
        );
        expect(audit).toMatchObject({ actorId, requestId, scope: { tenantId } });
        expect(typeof audit!.actorId).toBe("string");
        expect(typeof (audit!.scope as Record<string, unknown>).tenantId).toBe("string");

        const hostCollection = context.monsqlize.collection<Record<string, unknown>>(
            `host_object_id_probe_${scopeSequence}`,
        );
        await hostCollection.insertOne({ roleId, nested: { actorId } });
        const hostRaw = hostCollection.raw() as {
            findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
        };
        const hostDocument = await hostRaw.findOne({});
        const convertedRoleId = hostDocument!.roleId as { toHexString(): string };
        const convertedActorId = (hostDocument!.nested as Record<string, unknown>).actorId as { toHexString(): string };
        expect(convertedRoleId.toHexString()).toBe(roleId);
        expect(convertedActorId.toHexString()).toBe(actorId);
    }, TEST_TIMEOUT);

    it("preserves a real menu source when revoking the manual source", async () => {
        const scope = nextScope("menu-source-revoke");
        const created = await roles.create(scope, { id: "reader", label: "Reader" });
        const allowed = await rules.allow(scope, "reader", { action: "read", resource: "db:orders" });
        const semanticKey = allowed.data.semanticKey;
        await seedRealMenuSources({ repository, schemes, scope, roleId: "reader", sourceCount: 1 });

        const revoked = await rules.revoke(scope, "reader", {
            effect: "allow",
            action: "read",
            resource: "db:orders",
            semanticKey,
        });
        expect(revoked).toMatchObject({
            changed: true,
            revision: created.data.revision + 3,
            data: { removed: 1, remainingCount: 0, remainingDigest: digestCanonical([]) },
        });
        const scopeKey = digestCanonical(scope);
        const postImage = await repository.collections.roleRules.findOne(
            { scopeKey, roleId: "reader", semanticKey },
            { cache: 0 },
        );
        expect(postImage).toMatchObject({ revision: 3 });
        expect(postImage!.sources).toHaveLength(1);
        expect((postImage!.sources as Array<{ kind: string }>).every((source) => source.kind === "menu")).toBe(true);
    }, TEST_TIMEOUT);

    it("accepts exact rule and source limits and rejects one over", async () => {
        const schemes = new ResourceSchemeRegistry();

        const ruleScope = nextScope("rule-boundary");
        await roles.create(ruleScope, { id: "boundary-role", label: "Boundary role" });
        const ruleScopeKey = digestCanonical(ruleScope);
        const now = Date.now();
        const ruleDocuments = Array.from({ length: MAX_RULES_PER_ROLE }, (_, index) => {
            const action = `boundary.${index}`;
            const resource = "db:orders";
            const semanticKey = createSemanticKey("allow", action, resource);
            return {
                scopeKey: ruleScopeKey,
                scope: ruleScope,
                roleId: "boundary-role",
                effect: "allow",
                action,
                resource,
                semanticKey,
                sources: [{ kind: "manual", sourceId: `manual:${semanticKey}` }],
                revision: 1,
                createdAt: now,
                updatedAt: now,
            };
        });
        await repository.withTransaction(async (transaction) => {
            const result = await repository.collections.roleRules.insertMany(ruleDocuments, {
                session: transaction.session,
                cache: { invalidate: false },
            });
            expect(result.insertedCount).toBe(MAX_RULES_PER_ROLE);
        });
        const ruleReader = await new RbacReadStore(repository, schemes).open(ruleScope);
        await expect(ruleReader.readRulesForRole("boundary-role")).resolves.toHaveLength(MAX_RULES_PER_ROLE);
        await expect(rules.allow(ruleScope, "boundary-role", {
            action: "boundary.one-over",
            resource: "db:orders",
        })).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "rules-per-role", current: 2049, max: 2048 }),
        });

        const sourceScope = nextScope("source-boundary");
        await roles.create(sourceScope, { id: "source-role", label: "Source role" });
        const semanticKey = await seedRealMenuSources({
            repository,
            schemes,
            scope: sourceScope,
            roleId: "source-role",
            sourceCount: MAX_RULE_SOURCES,
        });
        const sourceReader = await new RbacReadStore(repository, schemes).open(sourceScope);
        await expect(sourceReader.readRule("source-role", semanticKey)).resolves.toMatchObject({
            sources: expect.arrayContaining([expect.objectContaining({ kind: "menu" })]),
        });
        await expect(rules.allow(sourceScope, "source-role", {
            action: "read",
            resource: "db:orders",
        })).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "rule-sources", current: 1025, max: 1024 }),
        });
    }, TEST_TIMEOUT);

    it("accepts role depth 32 and rejects depth 33 without residue", async () => {
        const scope = nextScope("depth-boundary");
        let parentId: string | undefined;
        for (let depth = 1; depth <= MAX_ROLE_CHAIN_DEPTH; depth += 1) {
            const roleId = `depth-${String(depth).padStart(2, "0")}`;
            await roles.create(scope, {
                id: roleId,
                label: `Depth ${depth}`,
                ...(parentId === undefined ? {} : { parentId }),
            });
            parentId = roleId;
        }
        await expect(roles.create(scope, {
            id: "depth-33",
            label: "Depth 33",
            parentId,
        })).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "role-chain-depth", current: 33, max: 32 }),
        });
        const scopeKey = digestCanonical(scope);
        expect(await repository.collections.roles.count({ scopeKey }, { cache: 0 })).toBe(MAX_ROLE_CHAIN_DEPTH);
        expect(await repository.collections.roles.findOne({ scopeKey, roleId: "depth-33" }, { cache: 0 })).toBeNull();
    }, TEST_TIMEOUT);

    it("cleans stale disabled bindings and serializes concurrent manual allow/deny", async () => {
        const staleScope = nextScope("stale-cleanup");
        await roles.create(staleScope, { id: "reader", label: "Reader", status: "disabled" });
        await roles.create(staleScope, { id: "operator", label: "Operator", status: "disabled" });
        const staleScopeKey = digestCanonical(staleScope);
        const staleNow = Date.now();
        await repository.collections.userRoleSets.insertOne({
            scopeKey: staleScopeKey,
            scope: staleScope,
            userId: "u-stale",
            roleIds: ["operator", "reader"],
            revision: 2,
            createdAt: staleNow,
            updatedAt: staleNow,
        });
        const revoked = await userRoles.revoke(staleScope, "u-stale", "reader");
        const cleared = await userRoles.clear(staleScope, "u-stale", { expectedRevision: 3 });
        expect(revoked).toMatchObject({ changed: true, data: { roleIds: ["operator"], revision: 3 } });
        expect(cleared).toMatchObject({ changed: true, data: { roleIds: [], revision: 4, persisted: true } });

        const concurrentScope = nextScope("rule-concurrent");
        await roles.create(concurrentScope, { id: "operator", label: "Operator" });
        const results = await Promise.all([
            rules.allow(concurrentScope, "operator", { action: "read", resource: "db:orders" }),
            rules.deny(concurrentScope, "operator", { action: "delete", resource: "db:orders" }),
        ]);
        expect(results.map((result) => result.revision).sort((left, right) => left - right)).toEqual([2, 3]);
        expect(await repository.collections.roleRules.count({
            scopeKey: digestCanonical(concurrentScope),
            roleId: "operator",
        }, { cache: 0 })).toBe(2);
    }, TEST_TIMEOUT);

    it("blocks removal when authoritative menu aggregates declare missing dependencies", async () => {
        const scope = nextScope("aggregate-remove");
        const created = await roles.create(scope, { id: "aggregate-role", label: "Aggregate role" });
        const scopeKey = digestCanonical(scope);
        await repository.collections.roles.updateOne(
            { scopeKey, roleId: "aggregate-role", revision: created.data.revision },
            {
                $set: {
                    menuGrantCount: 1,
                    menuGrantDigest: digestCanonical(["grant-missing"]),
                },
            },
        );

        await expect(roles.remove(scope, "aggregate-role", {
            expectedRevision: created.data.revision,
        })).rejects.toMatchObject({ code: "ROLE_IN_USE" });
        expect(await repository.collections.roles.findOne({
            scopeKey,
            roleId: "aggregate-role",
        }, { cache: 0 })).not.toBeNull();
    }, TEST_TIMEOUT);
});
