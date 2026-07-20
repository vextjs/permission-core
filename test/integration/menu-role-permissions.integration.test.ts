import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
    MenuManifestInput,
    MenuPermissionChange,
    MenuPermissionSelection,
    PermissionScope,
} from "../../src/types";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import {
    MenuManifestService,
    RoleMenuPermissionMutationService,
} from "../../src/menu";
import { PermissionRepository } from "../../src/persistence/repository";
import { PERSISTED_SCHEMA_VERSION } from "../../src/persistence/documents";
import {
    createSemanticKey,
    RoleMutationService,
    RuleMutationService,
} from "../../src/rbac";
import { normalizeScope } from "../../src/scope/scope";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;

function createRepository(context: RealMongoContext, prefix: string, schemes: ResourceSchemeRegistry) {
    const schemeContractDigest = schemes.schemeContractDigest;
    return new PermissionRepository(context.monsqlize, prefix, {
        schemeContractDigest,
        schemaContractKey: digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest,
        }),
    });
}

async function importManifest(
    service: MenuManifestService,
    scope: PermissionScope,
    input: MenuManifestInput,
) {
    const preview = await service.preview(scope, input, { actorId: "admin" });
    if (!preview.executable) throw new Error(`manifest conflicts: ${preview.conflicts.items.map((item) => item.code).join(",")}`);
    return service.import(scope, input, {
        ...preview.expected,
        previewToken: preview.previewToken,
        actorId: "admin",
        idempotencyKey: `manifest-${randomUUID()}`,
    });
}

describe("role menu permission writes on MonSQLize 3.1", () => {
    let context: RealMongoContext;

    beforeAll(async () => {
        context = await startRealMongo();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await context?.close();
    }, TEST_TIMEOUT);

    it("grants, refreshes, denies, revokes, and sets without deleting manual sources", async () => {
        const schemes = new ResourceSchemeRegistry();
        const repository = createRepository(
            context,
            `pc_b43_role_menu_${randomUUID().replaceAll("-", "")}`,
            schemes,
        );
        await repository.ensureIndexes();
        const scope = normalizeScope({ tenantId: "tenant-role-menu-write" });
        const tokens = new SignedTokenCodec(Buffer.alloc(32, 73), "role-menu-write");
        const roles = new RoleMutationService(repository, schemes);
        const rules = new RuleMutationService(repository, schemes);
        const manifests = new MenuManifestService(repository, schemes, tokens);
        const service = new RoleMenuPermissionMutationService(repository, schemes, tokens);

        await roles.create(scope, { id: "operator", label: "Operator" });
        await importManifest(manifests, scope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                {
                    id: "orders",
                    parentId: "root",
                    type: "page",
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission: { action: "read", resource: "ui:page:orders" },
                    order: 0,
                },
            ],
            apiBindings: [{
                id: "orders-read",
                method: "GET",
                path: "/api/orders",
                purpose: "entry",
                authorization: {
                    mode: "all",
                    permissions: [{ action: "read", resource: "api:GET:/api/orders" }],
                },
                owners: [{ type: "page", id: "orders", required: true }],
                canonicalOwner: { type: "page", id: "orders" },
            }],
        });
        await rules.allow(scope, "operator", { action: "read", resource: "ui:page:orders" });

        const selection: MenuPermissionSelection = {
            nodeIds: ["orders"],
            include: { descendants: false, buttons: false, apis: "required", dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        const execute = async (change: MenuPermissionChange, idempotencyKey: string) => {
            const preview = await service.preview(scope, "operator", change, { actorId: "admin" });
            if (!preview.executable) {
                throw new Error(`role menu conflicts: ${preview.conflicts.items.map((item) => item.code).join(",")}`);
            }
            const options = {
                ...preview.expected,
                previewToken: preview.previewToken,
                actorId: "admin",
                idempotencyKey,
            };
            if (change.operation === "grant") return service.grant(scope, "operator", change.selection, options);
            if (change.operation === "deny") return service.deny(scope, "operator", change.selection, options);
            if (change.operation === "revoke") return service.revoke(scope, "operator", { grantIds: change.grantIds }, options);
            if (change.operation === "set") return service.set(scope, "operator", change.assignments, options);
            throw new Error("Unsupported role menu permission change.");
        };

        const menuRevision = (await repository.scopeStates.read(scope)).menuRevision;
        const granted = await execute({ operation: "grant", selection }, "role-menu-grant");
        expect(granted).toMatchObject({ changed: true, data: { generatedSources: 2, removedSources: 0 } });
        const allowGrantId = "grantIds" in granted.data ? granted.data.grantIds.items[0]! : "";
        expect(allowGrantId).toMatch(/^grant_/u);

        const uiAllowKey = createSemanticKey("allow", "read", "ui:page:orders");
        const uiAllowRule = await repository.collections.roleRules.findOne({
            scopeKey: digestCanonical(scope),
            roleId: "operator",
            semanticKey: uiAllowKey,
        }, { cache: 0 });
        expect(uiAllowRule?.sources).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "manual", sourceId: `manual:${uiAllowKey}` }),
            expect.objectContaining({ kind: "menu", grantId: allowGrantId }),
        ]));

        const repeated = await execute({ operation: "grant", selection }, "role-menu-grant-noop");
        expect(repeated.changed).toBe(false);
        expect(await repository.collections.roleMenuGrants.count({
            scopeKey: digestCanonical(scope),
            roleId: "operator",
        }, { cache: 0 })).toBe(1);

        const denied = await execute({ operation: "deny", selection }, "role-menu-deny");
        expect(denied.changed).toBe(true);
        expect(await repository.collections.roleMenuGrants.count({
            scopeKey: digestCanonical(scope),
            roleId: "operator",
        }, { cache: 0 })).toBe(2);

        const revoked = await execute({ operation: "revoke", grantIds: [allowGrantId] }, "role-menu-revoke");
        expect(revoked.changed).toBe(true);
        const afterRevoke = await repository.collections.roleRules.findOne({
            scopeKey: digestCanonical(scope),
            roleId: "operator",
            semanticKey: uiAllowKey,
        }, { cache: 0 });
        expect(afterRevoke?.sources).toEqual([{ kind: "manual", sourceId: `manual:${uiAllowKey}` }]);

        const cleared = await execute({ operation: "set", assignments: [] }, "role-menu-set-empty");
        expect(cleared.changed).toBe(true);
        expect(await repository.collections.roleMenuGrants.count({
            scopeKey: digestCanonical(scope),
            roleId: "operator",
        }, { cache: 0 })).toBe(0);
        const remainingRules = await repository.collections.roleRules.find({
            scopeKey: digestCanonical(scope),
            roleId: "operator",
        }, { cache: 0 }).toArray();
        expect(remainingRules).toHaveLength(1);
        expect(remainingRules[0]?.sources).toEqual([{ kind: "manual", sourceId: `manual:${uiAllowKey}` }]);

        const role = await repository.collections.roles.findOne({
            scopeKey: digestCanonical(scope),
            roleId: "operator",
        }, { cache: 0 });
        expect(role).toMatchObject({ menuGrantCount: 0, menuSourceCount: 0 });
        expect((await repository.scopeStates.read(scope)).menuRevision).toBe(menuRevision);
    }, TEST_TIMEOUT);
});
