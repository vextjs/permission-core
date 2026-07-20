import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import { PermissionRepository } from "../../src/persistence/repository";
import { PERSISTED_SCHEMA_VERSION } from "../../src/persistence/documents";
import { normalizeMutationOptions, RoleMutationService, RuleMutationService } from "../../src/rbac";
import { normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;

function repositoryFixture(context: RealMongoContext, label: string) {
    const schemes = new ResourceSchemeRegistry();
    const schemeContractDigest = schemes.schemeContractDigest;
    const repository = new PermissionRepository(
        context.monsqlize,
        `pc_rbac_boundary_${label}_${randomUUID().replaceAll("-", "")}`,
        {
            schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: PERSISTED_SCHEMA_VERSION,
                schemeContractDigest,
            }),
        },
    );
    return { repository, schemes };
}

async function withRoles<T>(
    repository: PermissionRepository,
    overrides: Partial<PermissionRepository["collections"]["roles"]>,
    work: () => Promise<T>,
) {
    const original = repository.collections;
    Object.defineProperty(repository, "collections", {
        value: Object.freeze({
            ...original,
            roles: Object.freeze({ ...original.roles, ...overrides }),
        }),
        writable: true,
        configurable: true,
    });
    try {
        return await work();
    } finally {
        Object.defineProperty(repository, "collections", {
            value: original,
            writable: true,
            configurable: true,
        });
    }
}

async function withRoleRules<T>(
    repository: PermissionRepository,
    overrides: Partial<PermissionRepository["collections"]["roleRules"]>,
    work: () => Promise<T>,
) {
    const original = repository.collections;
    Object.defineProperty(repository, "collections", {
        value: Object.freeze({
            ...original,
            roleRules: Object.freeze({ ...original.roleRules, ...overrides }),
        }),
        writable: true,
        configurable: true,
    });
    try {
        return await work();
    } finally {
        Object.defineProperty(repository, "collections", {
            value: original,
            writable: true,
            configurable: true,
        });
    }
}

describe("role mutation failure-closed boundaries on MonSQLize 3.1", () => {
    let context: RealMongoContext;

    beforeAll(async () => {
        context = await startRealMongo();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    it("rolls create and metadata anomalies back and preserves nullable description semantics", async () => {
        const { repository, schemes } = repositoryFixture(context, "metadata");
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-role-boundary-metadata" });
        const roles = new RoleMutationService(repository, schemes);
        const originalRoles = repository.collections.roles;

        await expect(withRoles(repository, {
            async insertOne(...args) {
                const result = await originalRoles.insertOne(...args);
                return { ...result, acknowledged: false };
            },
        }, () => roles.create(scope, { id: "unacknowledged", label: "Unacknowledged" }, {
            actorId: "admin",
            idempotencyKey: "role-insert-unacknowledged",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        await expect(withRoles(repository, {
            async insertOne() {
                throw Object.assign(new Error("E11000 pc_roles_scope_role_uq duplicate"), { code: 11_000 });
            },
        }, () => roles.create(scope, { id: "duplicate", label: "Duplicate" }, {
            actorId: "admin",
            idempotencyKey: "role-insert-duplicate",
        }))).rejects.toMatchObject({ code: "ROLE_ALREADY_EXISTS" });

        await expect(withRoles(repository, {
            async findOne(...args) {
                const row = await originalRoles.findOne(...args);
                const filter = args[0] as Readonly<Record<string, unknown>>;
                return filter.roleId === "bad-post-image" && row !== null
                    ? { ...row, updatedAt: Number(row.updatedAt) + 1 }
                    : row;
            },
        }, () => roles.create(scope, { id: "bad-post-image", label: "Bad post-image" }, {
            actorId: "admin",
            idempotencyKey: "role-insert-post-image",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        const created = await roles.create(scope, {
            id: "reader",
            label: "Reader",
            description: "Reads orders",
        }, { actorId: "admin", idempotencyKey: "create-reader" });
        expect(created.data).toMatchObject({ revision: 1, description: "Reads orders" });

        await expect(withRoles(repository, {
            async updateOne() {
                return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
            },
        }, () => roles.update(scope, "reader", { label: "Reader conflict" }, {
            actorId: "admin",
            idempotencyKey: "role-update-conflict",
            expectedRevision: 1,
        }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

        await expect(withRoles(repository, {
            async updateOne(...args) {
                const result = await originalRoles.updateOne(...args);
                return { ...result, modifiedCount: 0 };
            },
        }, () => roles.update(scope, "reader", { label: "Reader no modification" }, {
            actorId: "admin",
            idempotencyKey: "role-update-no-modification",
            expectedRevision: 1,
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        let reads = 0;
        await expect(withRoles(repository, {
            async findOne(...args) {
                const row = await originalRoles.findOne(...args);
                const filter = args[0] as Readonly<Record<string, unknown>>;
                if (filter.roleId === "reader" && row !== null) {
                    reads += 1;
                    if (reads > 1) return { ...row, updatedAt: Number(row.updatedAt) + 1 };
                }
                return row;
            },
        }, () => roles.update(scope, "reader", { label: "Reader post-image" }, {
            actorId: "admin",
            idempotencyKey: "role-update-post-image",
            expectedRevision: 1,
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        const withoutDescription = await roles.update(scope, "reader", { description: null }, {
            actorId: "admin",
            idempotencyKey: "role-remove-description",
            expectedRevision: 1,
        });
        expect(withoutDescription).toMatchObject({ changed: true, data: { id: "reader", revision: 2 } });
        expect(withoutDescription.data).not.toHaveProperty("description");
        await expect(roles.update(scope, "reader", { label: "Reader" }, {
            actorId: "admin",
            idempotencyKey: "role-update-noop",
            expectedRevision: 2,
        })).resolves.toMatchObject({ changed: false, data: { revision: 2 } });
    }, TEST_TIMEOUT);

    it("validates access recovery and fails closed when deletion CAS or post-image checks fail", async () => {
        const { repository, schemes } = repositoryFixture(context, "access-remove");
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-role-boundary-access" });
        const roles = new RoleMutationService(repository, schemes);
        const validation = async () => ({
            validatedPlanHash: digestCanonical({ plan: "role-access" }),
            capacity: { proof: "exact" },
        });

        await roles.create(scope, { id: "operator", label: "Operator" }, {
            actorId: "admin",
            idempotencyKey: "create-operator",
        });
        await expect(roles.executeAccessUpdate(
            scope,
            "operator",
            { status: "enabled" },
            normalizeMutationOptions({ actorId: "admin", idempotencyKey: "access-noop" }),
            { status: "enabled" },
            validation,
        )).resolves.toMatchObject({ changed: false, data: { status: "enabled", revision: 1 } });

        const deprecated = await roles.executeAccessUpdate(
            scope,
            "operator",
            { status: "deprecated" },
            normalizeMutationOptions({ actorId: "admin", idempotencyKey: "access-deprecate" }),
            { status: "deprecated" },
            validation,
        );
        expect(deprecated.data).toMatchObject({ status: "deprecated", revision: 2 });
        await expect(roles.executeAccessUpdate(
            scope,
            "operator",
            { parentId: null },
            normalizeMutationOptions({ actorId: "admin", idempotencyKey: "access-invalid-deprecated" }),
            { parentId: null },
            validation,
        )).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(roles.executeAccessUpdate(
            scope,
            "operator",
            { status: "enabled" },
            normalizeMutationOptions({ actorId: "admin", idempotencyKey: "access-restore" }),
            { status: "enabled" },
            validation,
        )).resolves.toMatchObject({ changed: true, data: { status: "enabled", revision: 3 } });

        const removable = await roles.create(scope, { id: "removable", label: "Removable" }, {
            actorId: "admin",
            idempotencyKey: "create-removable",
        });
        const originalRoles = repository.collections.roles;
        await expect(withRoles(repository, {
            async deleteOne() {
                return { acknowledged: true, deletedCount: 0 };
            },
        }, () => roles.remove(scope, "removable", {
            actorId: "admin",
            idempotencyKey: "remove-conflict",
            expectedRevision: removable.data.revision,
        }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

        await expect(withRoles(repository, {
            async deleteOne() {
                return { acknowledged: true, deletedCount: 1 };
            },
        }, () => roles.remove(scope, "removable", {
            actorId: "admin",
            idempotencyKey: "remove-surviving",
            expectedRevision: removable.data.revision,
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        await expect(originalRoles.findOne({
            scopeKey: (await repository.scopeStates.read(scope)).scopeKey,
            roleId: "removable",
        }, { cache: 0 })).resolves.toMatchObject({ roleId: "removable", revision: 1 });
    }, TEST_TIMEOUT);

    it("rolls manual-rule insert, role bump, post-image, and revoke anomalies back atomically", async () => {
        const { repository, schemes } = repositoryFixture(context, "rules");
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-rule-boundaries" });
        const roles = new RoleMutationService(repository, schemes);
        const rules = new RuleMutationService(repository, schemes);
        await roles.create(scope, { id: "reader", label: "Reader" }, {
            actorId: "admin",
            idempotencyKey: "create-reader",
        });
        const rule = { action: "read" as const, resource: "db:orders" };
        const originalRules = repository.collections.roleRules;
        const originalRoles = repository.collections.roles;

        await expect(withRoleRules(repository, {
            async insertOne(...args) {
                const result = await originalRules.insertOne(...args);
                return { ...result, acknowledged: false };
            },
        }, () => rules.allow(scope, "reader", rule, {
            actorId: "admin",
            idempotencyKey: "rule-insert-unacknowledged",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        await expect(withRoles(repository, {
            async updateOne() {
                return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
            },
        }, () => rules.allow(scope, "reader", rule, {
            actorId: "admin",
            idempotencyKey: "rule-role-bump-conflict",
        }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

        let roleReads = 0;
        await expect(withRoles(repository, {
            async findOne(...args) {
                const row = await originalRoles.findOne(...args);
                const filter = args[0] as Readonly<Record<string, unknown>>;
                if (filter.roleId === "reader" && row !== null) {
                    roleReads += 1;
                    if (roleReads > 1) return { ...row, updatedAt: Number(row.updatedAt) + 1 };
                }
                return row;
            },
        }, () => rules.allow(scope, "reader", rule, {
            actorId: "admin",
            idempotencyKey: "rule-role-post-image",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        await expect(withRoleRules(repository, {
            async findOne(...args) {
                const row = await originalRules.findOne(...args);
                return row === null ? null : { ...row, updatedAt: Number(row.updatedAt) + 1 };
            },
        }, () => rules.allow(scope, "reader", rule, {
            actorId: "admin",
            idempotencyKey: "rule-post-image",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        const allowed = await rules.allow(scope, "reader", rule, {
            actorId: "admin",
            idempotencyKey: "rule-allow",
        });
        expect(allowed).toMatchObject({ changed: true, data: { effect: "allow" } });
        await expect(rules.allow(scope, "reader", rule, { actorId: "admin" }))
            .resolves.toMatchObject({ changed: false });

        await expect(withRoleRules(repository, {
            async deleteOne() {
                return { acknowledged: true, deletedCount: 0 };
            },
        }, () => rules.revoke(scope, "reader", { effect: "allow", ...rule }, {
            actorId: "admin",
            idempotencyKey: "rule-revoke-conflict",
        }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

        const state = await repository.scopeStates.read(scope);
        const persistedRule = await originalRules.findOne({
            scopeKey: state.scopeKey,
            roleId: "reader",
        }, { cache: 0 });
        await expect(withRoleRules(repository, {
            async findOne(...args) {
                const row = await originalRules.findOne(...args);
                return row ?? persistedRule;
            },
        }, () => rules.revoke(scope, "reader", { effect: "allow", ...rule }, {
            actorId: "admin",
            idempotencyKey: "rule-revoke-post-image",
        }))).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

        await expect(rules.revoke(scope, "reader", { effect: "allow", ...rule }, {
            actorId: "admin",
            idempotencyKey: "rule-revoke",
        })).resolves.toMatchObject({ changed: true, data: { removed: 1 } });
    }, TEST_TIMEOUT);
});
