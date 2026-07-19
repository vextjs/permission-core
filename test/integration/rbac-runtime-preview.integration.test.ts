import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionCore } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import { MenuManifestService } from "../../src/menu";
import type { MenuManifestInput, MenuPermissionSelection } from "../../src/types";
import { PermissionRepository } from "../../src/persistence/repository";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const COLLECTION_PREFIX = "pc_b33";
const TOKEN_SECRET = "permission-core-b33-integration-token-secret";

let scopeSequence = 0;

function nextScope(label: string) {
    scopeSequence += 1;
    return { tenantId: `b33-${label}-${scopeSequence}` };
}

function corruptToken(token: string) {
    const separator = token.lastIndexOf(".");
    const signature = token.slice(separator + 1);
    const replacement = signature[0] === "A" ? "B" : "A";
    return `${token.slice(0, separator + 1)}${replacement}${signature.slice(1)}`;
}

describe("B3.3 public RBAC runtime and previews on MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let core: PermissionCore;
    let repository: PermissionRepository;
    let manifests: MenuManifestService;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 97 });
        core = new PermissionCore({
            monsqlize: context.monsqlize,
            collectionPrefix: COLLECTION_PREFIX,
            tokenSecret: TOKEN_SECRET,
        });
        await core.init();

        const schemes = new ResourceSchemeRegistry();
        repository = new PermissionRepository(context.monsqlize, COLLECTION_PREFIX, {
            schemeContractDigest: schemes.schemeContractDigest,
            schemaContractKey: digestCanonical({
                canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
                schemaVersion: 2,
                schemeContractDigest: schemes.schemeContractDigest,
            }),
        });
        manifests = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 73), "rbac-runtime-preview-manifest"),
        );
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await core?.close();
        await context?.close();
    });

    it("keeps a bound subject snapshot stable and applies deny-first to one-off checks", async () => {
        const scope = nextScope("runtime");
        const scoped = core.scope(scope);
        await scoped.roles.create({ id: "orders-base", label: "Orders base" });
        await scoped.roles.allow("orders-base", { action: "read", resource: "db:orders" });
        await scoped.roles.create({ id: "orders-reader", label: "Orders reader", parentId: "orders-base" });
        await scoped.userRoles.assign("u-runtime", "orders-reader");

        const mutableSubject = {
            userId: "u-runtime",
            scope: { ...scope },
            claims: { merchantId: "merchant-1" },
        };
        const bound = core.forSubject(mutableSubject);
        mutableSubject.userId = "mutated-user";
        mutableSubject.scope.tenantId = "mutated-tenant";
        mutableSubject.claims.merchantId = "mutated-merchant";

        await expect(bound.can("read", "db:orders")).resolves.toBe(true);
        const permissions = await bound.getPermissions();
        const serialized = JSON.stringify(permissions.data);
        expect(Object.isFrozen(permissions)).toBe(true);
        expect(Object.isFrozen(permissions.data)).toBe(true);
        expect(permissions.data.subject).toEqual({ userId: "u-runtime", scope });
        expect(serialized).not.toMatch(/"(?:revision|semanticKey|sourceId|grantId|auditId|createdAt|updatedAt)":/u);

        await scoped.roles.deny("orders-reader", { action: "read", resource: "db:orders" });

        await expect(bound.can("read", "db:orders")).resolves.toBe(true);
        await expect(core.can({ userId: "u-runtime", scope }, "read", "db:orders")).resolves.toBe(false);
        await expect(core.cannot({ userId: "u-runtime", scope }, "read", "db:orders")).resolves.toBe(true);
        await expect(core.assert({ userId: "u-runtime", scope }, "read", "db:orders")).rejects.toMatchObject({
            code: "PERMISSION_DENIED",
        });

        const explanation = await core.explain({ userId: "u-runtime", scope }, "read", "db:orders");
        expect(explanation.data).toMatchObject({ allowed: false, reason: "explicit-deny" });
        const deniedPermissions = await core.getPermissions({ userId: "u-runtime", scope });
        expect(deniedPermissions.data.conflicts).toMatchObject({
            total: 1,
            items: [expect.objectContaining({
                action: "read",
                resource: "db:orders",
                allowCount: 1,
                denyCount: 1,
                resolution: "deny",
            })],
        });
        const resources = await core.getResources({ userId: "u-runtime", scope }, "read");
        expect(resources.data).toEqual(expect.arrayContaining([
            expect.objectContaining({ action: "read", resource: "db:orders" }),
        ]));

        const direct = await scoped.userRoles.getDirect("u-runtime");
        const effective = await scoped.userRoles.getEffective("u-runtime");
        expect(direct.data.roleIds).toEqual(["orders-reader"]);
        expect(effective.data.effective.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: expect.objectContaining({ id: "orders-base" }), direct: false, depth: 1 }),
            expect.objectContaining({ role: expect.objectContaining({ id: "orders-reader" }), direct: true, depth: 0 }),
        ]));
    }, TEST_TIMEOUT);

    it("evaluates write as create-and-update and keeps condition failures distinct", async () => {
        const scope = nextScope("runtime-policy");
        const scoped = core.scope(scope);
        const subject = { userId: "u-policy", scope };
        await scoped.roles.create({ id: "policy-role", label: "Policy role" });
        await scoped.userRoles.assign(subject.userId, "policy-role");
        await scoped.roles.allow("policy-role", { action: "create", resource: "db:orders" });

        await expect(core.can(subject, "write", "db:orders")).resolves.toBe(false);
        const partialWrite = await core.explain(subject, "write", "db:orders");
        expect(partialWrite.data).toMatchObject({ allowed: false, reason: "no-allow" });
        expect(partialWrite.data.evaluations.map((entry) => [entry.action, entry.allowed])).toEqual([
            ["create", true],
            ["update", false],
        ]);

        await scoped.roles.allow("policy-role", { action: "update", resource: "db:orders" });
        await expect(core.can(subject, "write", "db:orders")).resolves.toBe(true);
        const writeResources = await core.getResources(subject, "write");
        expect(writeResources.data.map((entry) => entry.action)).toEqual(["create", "update"]);

        await scoped.roles.deny("policy-role", { action: "update", resource: "db:orders" });
        await expect(core.can(subject, "write", "db:orders")).resolves.toBe(false);
        await expect(core.explain(subject, "write", "db:orders")).resolves.toMatchObject({
            data: { reason: "explicit-deny" },
        });

        await scoped.roles.allow("policy-role", { action: "orders.refund", resource: "db:orders" });
        await expect(core.can(subject, "orders.refund", "db:orders")).resolves.toBe(true);
        await scoped.roles.allow("policy-role", {
            action: "read",
            resource: "db:conditional-orders",
            where: { field: "status", op: "eq", valueFrom: "context.requiredStatus" },
        });
        await expect(core.can(subject, "read", "db:conditional-orders", {
            status: "open",
            requiredStatus: "open",
        })).resolves.toBe(true);
        await expect(core.can(subject, "read", "db:conditional-orders", {
            status: "open",
        })).rejects.toMatchObject({ code: "POLICY_CONTEXT_MISSING" });
        await expect(core.explain(subject, "read", "db:conditional-orders", {
            status: "open",
        })).resolves.toMatchObject({
            data: { allowed: false, reason: "context-missing" },
        });
        await expect(core.explain(subject, "read", "db:conditional-orders", {
            requiredStatus: "open",
        })).resolves.toMatchObject({
            data: { allowed: false, reason: "policy-unknown" },
        });
    }, TEST_TIMEOUT);

    it("binds manager cursors to query, scope, revision, and stable tenant-local identities", async () => {
        const firstScope = nextScope("cursor-a");
        const secondScope = nextScope("cursor-b");
        const first = core.scope(firstScope);
        const second = core.scope(secondScope);
        await first.roles.create({ id: "a-role", label: "A tenant role" });
        await first.roles.create({ id: "b-role", label: "B tenant role" });
        await first.roles.create({ id: "c-role", label: "C tenant role" });
        await second.roles.create({ id: "a-role", label: "Other tenant role" });

        const page = await first.roles.list({ first: 1 });
        expect(page.items.map((role) => role.id)).toEqual(["a-role"]);
        expect(page.pageInfo.hasNext).toBe(true);
        expect(page.pageInfo.endCursor).not.toBeNull();
        const cursor = page.pageInfo.endCursor!;

        await expect(first.roles.list({ first: 1, after: corruptToken(cursor) })).rejects.toMatchObject({
            code: "INVALID_CURSOR",
        });
        await expect(first.roles.listOwnRules("a-role", { first: 1, after: cursor })).rejects.toMatchObject({
            code: "INVALID_CURSOR",
        });
        await expect(second.roles.list({ first: 1, after: cursor })).rejects.toMatchObject({
            code: "INVALID_CURSOR",
        });

        await first.roles.create({ id: "d-role", label: "D tenant role" });
        await expect(first.roles.list({ first: 1, after: cursor })).rejects.toMatchObject({
            code: "CURSOR_STALE",
            details: expect.objectContaining({ owner: "scope.rbac" }),
        });
        await expect(first.roles.get("a-role")).resolves.toMatchObject({ data: { label: "A tenant role" } });
        await expect(second.roles.get("a-role")).resolves.toMatchObject({ data: { label: "Other tenant role" } });

        const impactScope = nextScope("impact");
        const impact = core.scope(impactScope);
        await impact.roles.create({ id: "parent", label: "Parent" });
        await impact.roles.create({ id: "child-a", label: "Child A", parentId: "parent" });
        await impact.roles.create({ id: "child-b", label: "Child B", parentId: "parent" });
        await impact.roles.allow("parent", { action: "read", resource: "db:orders" });
        await impact.roles.allow("parent", { action: "delete", resource: "db:orders" });
        await impact.userRoles.assign("u-impact-1", "parent");
        await impact.userRoles.assign("u-impact-2", "parent");
        await impact.userRoles.assign("u-impact-3", "parent");
        await impact.userRoles.assign("u-impact-child", "child-a");
        const removal = await impact.roles.getRemovalImpact("parent");
        expect(removal.data).toMatchObject({
            children: { total: 2, truncated: false },
            boundUsers: { total: 3, truncated: false },
            ownRules: 2,
            removable: false,
        });
        expect(removal.data.blockers.items).toEqual(expect.arrayContaining(["children", "bound-users", "own-rules"]));
        const firstRules = await impact.roles.listOwnRules("parent", { first: 1 });
        expect(firstRules.items).toHaveLength(1);
        expect(firstRules.pageInfo).toMatchObject({ hasNext: true, endCursor: expect.any(String) });
        const secondRules = await impact.roles.listOwnRules("parent", {
            first: 1,
            after: firstRules.pageInfo.endCursor!,
        });
        expect(secondRules.items).toHaveLength(1);
        expect(secondRules.items[0]!.semanticKey).not.toBe(firstRules.items[0]!.semanticKey);
        expect(secondRules.pageInfo).toEqual({ hasNext: false, endCursor: null });
        const firstUsers = await impact.userRoles.listUsersByRole("parent", { first: 2 });
        expect(firstUsers.items.map((entry) => entry.userId)).toEqual(["u-impact-1", "u-impact-2"]);
        const secondUsers = await impact.userRoles.listUsersByRole("parent", {
            first: 2,
            after: firstUsers.pageInfo.endCursor!,
        });
        expect(secondUsers.items.map((entry) => entry.userId)).toEqual(["u-impact-3"]);
        await expect(impact.roles.previewAccessUpdate("parent", { status: "disabled" }, { actorId: "admin" })).resolves.toMatchObject({
            executable: true,
            plan: {
                descendants: { total: 2 },
                directlyBoundUsers: { total: 3 },
                affectedUsers: { total: 4 },
            },
            capacity: {
                accessDirection: "restrict",
                proof: "exact",
                disposition: "safe",
                affectedUsers: { total: 4 },
            },
        });
    }, TEST_TIMEOUT);

    it("executes an actor-bound access preview and replays before revalidating an old token", async () => {
        const scope = nextScope("access-preview");
        const scoped = core.scope(scope);
        await scoped.roles.create({ id: "reader", label: "Reader" });
        await scoped.roles.allow("reader", { action: "read", resource: "db:orders" });
        await scoped.userRoles.assign("u-access", "reader");
        await expect(core.can({ userId: "u-access", scope }, "read", "db:orders")).resolves.toBe(true);

        const preview = await scoped.roles.previewAccessUpdate("reader", { status: "disabled" }, { actorId: "admin" });
        expect(preview).toMatchObject({
            executable: true,
            plan: {
                before: { status: "enabled" },
                after: { status: "disabled" },
                affectedUsers: { total: 1 },
            },
            capacity: {
                proof: "exact",
                disposition: "safe",
                accessDirection: "restrict",
                affectedUsers: { total: 1 },
            },
        });
        if (!preview.executable) throw new Error("Expected an executable access preview");

        const scopeKey = digestCanonical(scope);
        const auditsBefore = await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 });
        const restarted = new PermissionCore({
            monsqlize: context.monsqlize,
            collectionPrefix: COLLECTION_PREFIX,
            tokenSecret: "permission-core-restarted-token-secret-value",
        });
        await restarted.init();
        try {
            await expect(restarted.scope(scope).roles.executeAccessUpdate("reader", { status: "disabled" }, {
                ...preview.expected,
                previewToken: preview.previewToken,
                actorId: "admin",
            })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
            await expect(scoped.roles.executeRuleChange("reader", {
                operation: "allow",
                rule: { action: "delete", resource: "db:orders" },
            }, {
                ...preview.expected,
                previewToken: preview.previewToken,
                actorId: "admin",
            })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
            await expect(scoped.roles.executeAccessUpdate("reader", { status: "disabled" }, {
                ...preview.expected,
                previewToken: preview.previewToken,
                actorId: "other-admin",
            })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
            expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(auditsBefore);
            await expect(scoped.roles.get("reader")).resolves.toMatchObject({ data: { status: "enabled", revision: 2 } });

            await scoped.roles.create({ id: "concurrent-role", label: "Concurrent role" });
            const auditsAfterConcurrentMutation = await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 });
            await expect(scoped.roles.executeAccessUpdate("reader", { status: "disabled" }, {
                ...preview.expected,
                previewToken: preview.previewToken,
                actorId: "admin",
            })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
            expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(auditsAfterConcurrentMutation);

            const currentPreview = await scoped.roles.previewAccessUpdate("reader", { status: "disabled" }, { actorId: "admin" });
            if (!currentPreview.executable) throw new Error("Expected a refreshed executable access preview");
            const changed = await scoped.roles.executeAccessUpdate("reader", { status: "disabled" }, {
                ...currentPreview.expected,
                previewToken: currentPreview.previewToken,
                actorId: "admin",
                idempotencyKey: "disable-reader",
            });
            expect(changed).toMatchObject({ changed: true, replayed: false, data: { status: "disabled", revision: 3 } });
            await expect(core.can({ userId: "u-access", scope }, "read", "db:orders")).resolves.toBe(false);
            await expect(core.explain({ userId: "u-access", scope }, "read", "db:orders")).resolves.toMatchObject({
                data: { allowed: false, reason: "role-disabled" },
            });

            const replay = await restarted.scope(scope).roles.executeAccessUpdate("reader", { status: "disabled" }, {
                ...currentPreview.expected,
                previewToken: "old-token-that-is-no-longer-valid",
                actorId: "admin",
                idempotencyKey: "disable-reader",
            });
            expect(replay).toMatchObject({
                operationId: changed.operationId,
                auditId: changed.auditId,
                changed: true,
                replayed: true,
                data: changed.data,
            });
        } finally {
            await restarted.close();
        }
    }, TEST_TIMEOUT);

    it("executes rule previews, enforces exact replace input, and preserves menu-owned sources", async () => {
        const scope = nextScope("rule-preview");
        const scoped = core.scope(scope);
        await scoped.roles.create({ id: "operator", label: "Operator" });
        await scoped.userRoles.assign("u-rule", "operator");

        const ruleChange = { operation: "allow" as const, rule: { action: "read" as const, resource: "db:orders" } };
        const rulePreview = await scoped.roles.previewRuleChange("operator", ruleChange, { actorId: "admin" });
        expect(rulePreview).toMatchObject({
            executable: true,
            plan: { operation: "allow", sourceOperation: "insert", affectedUsers: { total: 1 } },
            capacity: { proof: "exact", disposition: "safe" },
        });
        if (!rulePreview.executable) throw new Error("Expected an executable rule preview");
        const ruleResult = await scoped.roles.executeRuleChange("operator", ruleChange, {
            ...rulePreview.expected,
            previewToken: rulePreview.previewToken,
            actorId: "admin",
        });
        expect(ruleResult).toMatchObject({ changed: true, data: { operation: "allow" } });
        await expect(core.can({ userId: "u-rule", scope }, "read", "db:orders")).resolves.toBe(true);

        const manifest: MenuManifestInput = {
            schemaVersion: 2,
            mode: "replace",
            nodes: [{
                id: "orders-page",
                type: "page",
                title: "Orders",
                path: "/orders",
                name: "orders",
                component: "OrdersPage",
                permission: { action: "read", resource: "db:orders" },
                order: 0,
            }],
            apiBindings: [],
        };
        const manifestPreview = await manifests.preview(scope, manifest, { actorId: "admin" });
        expect(manifestPreview.executable).toBe(true);
        if (!manifestPreview.executable) throw new Error("Expected an executable manifest preview");
        await manifests.import(scope, manifest, {
            ...manifestPreview.expected,
            previewToken: manifestPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "rule-preview-manifest",
        });
        const selection: MenuPermissionSelection = {
            nodeIds: ["orders-page"],
            include: { descendants: false, buttons: false, apis: "none", dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        const menuPreview = await scoped.roles.menuPermissions.preview(
            "operator",
            { operation: "grant", selection },
            { actorId: "admin" },
        );
        expect(menuPreview.executable).toBe(true);
        if (!menuPreview.executable) throw new Error("Expected an executable role-menu preview");
        await scoped.roles.menuPermissions.grant("operator", selection, {
            ...menuPreview.expected,
            previewToken: menuPreview.previewToken,
            actorId: "admin",
            idempotencyKey: "rule-preview-menu-grant",
        });

        const semanticKey = rulePreview.plan.semanticKey;
        const scopeKey = digestCanonical(scope);
        const currentRule = (await scoped.roles.getOwnRules("operator")).data
            .find((rule) => rule.semanticKey === semanticKey)!;
        const menuSource = currentRule.sources.items.find((source) => source.kind === "menu");
        expect(menuSource).toBeDefined();
        if (menuSource === undefined) throw new Error("Expected the menu grant to contribute a rule source");

        const exactInput = Array.from({ length: 2_048 }, () => ({
            effect: "allow" as const,
            action: "read" as const,
            resource: "db:orders",
        }));
        await expect(scoped.roles.previewReplaceRules("operator", exactInput, { actorId: "admin" })).resolves.toMatchObject({
            executable: true,
        });
        await expect(scoped.roles.previewReplaceRules("operator", [...exactInput, exactInput[0]!], { actorId: "admin" })).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "rules-items", current: 2049, max: 2048 }),
        });

        const replacePreview = await scoped.roles.previewReplaceRules("operator", [], { actorId: "admin" });
        expect(replacePreview).toMatchObject({
            executable: true,
            plan: { operations: { total: 1 }, affectedUsers: { total: 1 } },
            capacity: { proof: "exact", disposition: "safe" },
        });
        if (!replacePreview.executable) throw new Error("Expected an executable replace preview");
        const auditsBeforeMismatch = await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 });
        await expect(scoped.roles.replaceRules("operator", [{
            effect: "allow",
            action: "read",
            resource: "db:orders",
        }], {
            ...replacePreview.expected,
            previewToken: replacePreview.previewToken,
            actorId: "admin",
        })).rejects.toMatchObject({ code: "PREVIEW_STALE" });
        expect(await repository.collections.auditEntries.count({ scopeKey }, { cache: 0 })).toBe(auditsBeforeMismatch);

        const replaced = await scoped.roles.replaceRules("operator", [], {
            ...replacePreview.expected,
            previewToken: replacePreview.previewToken,
            actorId: "admin",
        });
        expect(replaced).toMatchObject({ changed: true, data: { updated: 1, deleted: 0 } });
        const postImage = await repository.collections.roleRules.findOne(
            { scopeKey, roleId: "operator", semanticKey },
            { cache: 0 },
        );
        expect(postImage!.sources).toEqual([expect.objectContaining({ kind: "menu", sourceId: menuSource.sourceId })]);
        await expect(core.can({ userId: "u-rule", scope }, "read", "db:orders")).resolves.toBe(true);
    }, TEST_TIMEOUT);

    it("commits at 1000 affected users and requires preview at 1001", async () => {
        const insertUserRoleSets = async (scope: { tenantId: string }, roleId: string, count: number) => {
            const scopeKey = digestCanonical(scope);
            const now = Date.now();
            const rows = Array.from({ length: count }, (_, index) => ({
                scopeKey,
                scope,
                userId: `u-${String(index).padStart(4, "0")}`,
                roleIds: [roleId],
                revision: 1,
                createdAt: now,
                updatedAt: now,
            }));
            for (let offset = 0; offset < rows.length; offset += 400) {
                await repository.collections.userRoleSets.insertMany(rows.slice(offset, offset + 400));
            }
            return scopeKey;
        };

        const exactScope = nextScope("capacity-1000");
        const exact = core.scope(exactScope);
        await exact.roles.create({ id: "reader", label: "Reader" });
        await insertUserRoleSets(exactScope, "reader", 1_000);
        await expect(exact.roles.allow("reader", {
            action: "read",
            resource: "db:orders",
        })).resolves.toMatchObject({ changed: true, data: { effect: "allow" } });
        expect(await repository.collections.roleRules.count({
            scopeKey: digestCanonical(exactScope),
            roleId: "reader",
        }, { cache: 0 })).toBe(1);
        const removal = await exact.roles.getRemovalImpact("reader");
        expect(removal.data.boundUsers).toMatchObject({
            total: 1_000,
            truncated: true,
            digest: expect.any(String),
        });
        expect(removal.data.boundUsers.sampleIds).toHaveLength(97);
        expect(removal.data.blockers.items).toEqual(expect.arrayContaining(["bound-users", "own-rules"]));

        const overflowScope = nextScope("capacity-1001");
        const overflow = core.scope(overflowScope);
        await overflow.roles.create({ id: "reader", label: "Reader" });
        const overflowScopeKey = await insertUserRoleSets(overflowScope, "reader", 1_001);
        await expect(overflow.roles.revoke("reader", {
            effect: "deny",
            action: "delete",
            resource: "db:orders",
        })).resolves.toMatchObject({ changed: false, data: { removed: 0 } });
        const denyChange = {
            operation: "deny" as const,
            rule: { action: "delete" as const, resource: "db:orders" },
        };
        const denyPreview = await overflow.roles.previewRuleChange("reader", denyChange, { actorId: "admin" });
        expect(denyPreview).toMatchObject({
            executable: true,
            capacity: { proof: "partial", disposition: "ack-required", unverifiedUsers: 1 },
        });
        if (!denyPreview.executable) throw new Error("Expected an executable deny preview");
        const auditsBeforeMissingAck = await repository.collections.auditEntries.count({ scopeKey: overflowScopeKey }, { cache: 0 });
        await expect(overflow.roles.executeRuleChange("reader", denyChange, {
            ...denyPreview.expected,
            previewToken: denyPreview.previewToken,
            actorId: "admin",
        })).rejects.toMatchObject({
            code: "INVALID_ARGUMENT",
            details: expect.objectContaining({ kind: "capacity-risk-ack-required" }),
        });
        expect(await repository.collections.roleRules.count({ scopeKey: overflowScopeKey, roleId: "reader" }, { cache: 0 })).toBe(0);
        expect(await repository.collections.auditEntries.count({ scopeKey: overflowScopeKey }, { cache: 0 })).toBe(auditsBeforeMissingAck);
        const auditsBefore = await repository.collections.auditEntries.count({ scopeKey: overflowScopeKey }, { cache: 0 });
        await expect(overflow.roles.allow("reader", {
            action: "read",
            resource: "db:orders",
        })).rejects.toMatchObject({
            code: "PREVIEW_REQUIRED",
            details: expect.objectContaining({
                reason: "capacity-risk",
                previewMethod: "roles.previewRuleChange",
                affectedTotal: 1_001,
                affectedDigest: expect.any(String),
            }),
        });
        expect(await repository.collections.roleRules.count({
            scopeKey: overflowScopeKey,
            roleId: "reader",
        }, { cache: 0 })).toBe(0);
        expect(await repository.collections.auditEntries.count({ scopeKey: overflowScopeKey }, { cache: 0 })).toBe(auditsBefore);
    }, TEST_TIMEOUT);
});
