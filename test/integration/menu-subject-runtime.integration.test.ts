import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionCore } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { CANONICAL_CONTRACT_VERSION, digestCanonical } from "../../src/internal/canonical";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import { MenuManifestService } from "../../src/menu";
import { PermissionRepository } from "../../src/persistence/repository";
import { normalizeScope } from "../../src/scope/scope";
import type { MenuManifestInput, PermissionScope } from "../../src/types";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const PREFIX = `pc_b44_subject_${randomUUID().replaceAll("-", "")}`;

function scope(label: string): PermissionScope {
    return { tenantId: `tenant-${label}-${randomUUID()}` };
}

function createRepository(context: RealMongoContext, schemes: ResourceSchemeRegistry) {
    return new PermissionRepository(context.monsqlize, PREFIX, {
        schemeContractDigest: schemes.schemeContractDigest,
        schemaContractKey: digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: 2,
            schemeContractDigest: schemes.schemeContractDigest,
        }),
    });
}

async function importManifest(
    service: MenuManifestService,
    targetScope: PermissionScope,
    input: MenuManifestInput,
) {
    const preview = await service.preview(targetScope, input, { actorId: "admin" });
    if (!preview.executable) {
        throw new Error(`manifest conflicts: ${preview.conflicts.items.map((item) => item.code).join(",")}`);
    }
    return service.import(targetScope, input, {
        ...preview.expected,
        previewToken: preview.previewToken,
        actorId: "admin",
        idempotencyKey: `manifest-${randomUUID()}`,
    });
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const item of value) collectKeys(item, keys);
        return keys;
    }
    if (value === null || typeof value !== "object") return keys;
    for (const [key, nested] of Object.entries(value)) {
        keys.add(key);
        collectKeys(nested, keys);
    }
    return keys;
}

describe("subject menu runtime on MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let core: PermissionCore;
    let repository: PermissionRepository;
    let manifests: MenuManifestService;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 97 });
        const schemes = new ResourceSchemeRegistry();
        repository = createRepository(context, schemes);
        core = new PermissionCore({
            monsqlize: context.monsqlize,
            collectionPrefix: PREFIX,
            tokenSecret: "permission-core-subject-menu-runtime-secret",
        });
        await core.init();
        manifests = new MenuManifestService(
            repository,
            schemes,
            new SignedTokenCodec(Buffer.alloc(32, 73), "subject-menu-runtime-tests"),
        );
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await core?.close();
        await context?.close();
    }, TEST_TIMEOUT);

    it("projects visible navigation, button states, routes, and API availability from one bound snapshot", async () => {
        const targetScope = scope("projection");
        const scoped = core.scope(targetScope);
        await scoped.roles.create({ id: "operator", label: "Operator" });
        await scoped.userRoles.assign("u-1", "operator");
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                { id: "empty", parentId: "root", type: "directory", title: "Empty", order: 0 },
                {
                    id: "denied-page",
                    parentId: "empty",
                    type: "page",
                    title: "Denied",
                    path: "/denied",
                    name: "denied",
                    component: "DeniedPage",
                    permission: { action: "read", resource: "ui:page:denied" },
                    order: 0,
                },
                { id: "hidden-parent", parentId: "root", type: "directory", title: "Hidden", hidden: true, order: 1 },
                {
                    id: "hidden-child",
                    parentId: "hidden-parent",
                    type: "page",
                    title: "Hidden child",
                    path: "/hidden-child",
                    name: "hidden-child",
                    component: "HiddenChildPage",
                    permission: { action: "read", resource: "ui:page:hidden-child" },
                    order: 0,
                },
                { id: "disabled-parent", parentId: "root", type: "directory", title: "Disabled", status: "disabled", order: 2 },
                {
                    id: "disabled-child",
                    parentId: "disabled-parent",
                    type: "page",
                    title: "Disabled child",
                    path: "/disabled-child",
                    name: "disabled-child",
                    component: "DisabledChildPage",
                    permission: { action: "read", resource: "ui:page:disabled-child" },
                    order: 0,
                },
                {
                    id: "denied-parent",
                    parentId: "root",
                    type: "directory",
                    title: "Denied parent",
                    permission: { action: "read", resource: "ui:directory:denied" },
                    order: 3,
                },
                {
                    id: "denied-child",
                    parentId: "denied-parent",
                    type: "page",
                    title: "Denied child",
                    path: "/denied-child",
                    name: "denied-child",
                    component: "DeniedChildPage",
                    permission: { action: "read", resource: "ui:page:denied-child" },
                    order: 0,
                },
                {
                    id: "orders",
                    parentId: "root",
                    type: "page",
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission: { action: "read", resource: "ui:page:orders" },
                    order: 4,
                },
                { id: "button-allowed", parentId: "orders", type: "button", title: "Allowed", code: "orders.allowed", permission: { action: "invoke", resource: "ui:button:orders.allowed" }, order: 0 },
                { id: "button-disabled", parentId: "orders", type: "button", title: "Disabled", code: "orders.disabled", permission: { action: "invoke", resource: "ui:button:orders.disabled" }, status: "disabled", order: 1 },
                { id: "button-hidden", parentId: "orders", type: "button", title: "Hidden", code: "orders.hidden", permission: { action: "invoke", resource: "ui:button:orders.hidden" }, hidden: true, order: 2 },
                { id: "button-denied", parentId: "orders", type: "button", title: "Denied", code: "orders.denied", permission: { action: "invoke", resource: "ui:button:orders.denied" }, order: 3 },
                { id: "button-api", parentId: "orders", type: "button", title: "API unavailable", code: "orders.api", permission: { action: "invoke", resource: "ui:button:orders.api" }, order: 4 },
                {
                    id: "api-any",
                    parentId: "root",
                    type: "page",
                    title: "API any",
                    path: "/api-any",
                    name: "api-any",
                    component: "ApiAnyPage",
                    permission: { action: "read", resource: "ui:page:api-any" },
                    order: 5,
                },
                {
                    id: "api-all",
                    parentId: "root",
                    type: "page",
                    title: "API all",
                    path: "/api-all",
                    name: "api-all",
                    component: "ApiAllPage",
                    permission: { action: "read", resource: "ui:page:api-all" },
                    order: 6,
                },
                {
                    id: "owner-any",
                    parentId: "root",
                    type: "page",
                    title: "Owner any",
                    path: "/owner-any",
                    name: "owner-any",
                    component: "OwnerAnyPage",
                    permission: { action: "read", resource: "ui:page:owner-any" },
                    order: 7,
                },
                {
                    id: "owner-all",
                    parentId: "root",
                    type: "page",
                    title: "Owner all",
                    path: "/owner-all",
                    name: "owner-all",
                    component: "OwnerAllPage",
                    permission: { action: "read", resource: "ui:page:owner-all" },
                    order: 8,
                },
            ],
            apiBindings: [
                {
                    id: "orders-optional-risk",
                    method: "GET",
                    path: "/api/orders/export",
                    purpose: "importExport",
                    authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:GET:/api/orders/export" }] },
                    owners: [{ type: "page", id: "orders", required: false }],
                    canonicalOwner: { type: "page", id: "orders" },
                },
                {
                    id: "button-api-required",
                    method: "POST",
                    path: "/api/orders/action",
                    purpose: "operation",
                    authorization: { mode: "all", permissions: [{ action: "invoke", resource: "api:POST:/api/orders/action" }] },
                    owners: [{ type: "button", id: "button-api", required: true }],
                    canonicalOwner: { type: "button", id: "button-api" },
                },
                {
                    id: "api-any-auth",
                    method: "GET",
                    path: "/api/any",
                    purpose: "entry",
                    authorization: {
                        mode: "any",
                        permissions: [
                            { action: "invoke", resource: "api:GET:/api/allowed" },
                            { action: "invoke", resource: "api:GET:/api/denied" },
                        ],
                    },
                    owners: [{ type: "page", id: "api-any", required: true }],
                    canonicalOwner: { type: "page", id: "api-any" },
                },
                {
                    id: "api-all-auth",
                    method: "GET",
                    path: "/api/all",
                    purpose: "entry",
                    authorization: {
                        mode: "all",
                        permissions: [
                            { action: "invoke", resource: "api:GET:/api/allowed" },
                            { action: "invoke", resource: "api:GET:/api/denied" },
                        ],
                    },
                    owners: [{ type: "page", id: "api-all", required: true }],
                    canonicalOwner: { type: "page", id: "api-all" },
                },
                {
                    id: "owner-group-allowed",
                    method: "GET",
                    path: "/api/owner-group/allowed",
                    purpose: "entry",
                    authorization: {
                        mode: "all",
                        permissions: [{ action: "invoke", resource: "api:GET:/api/allowed" }],
                    },
                    owners: [
                        { type: "page", id: "owner-any", required: true, availabilityGroup: "routes", availabilityMode: "any" },
                        { type: "page", id: "owner-all", required: true, availabilityGroup: "routes", availabilityMode: "all" },
                    ],
                    canonicalOwner: { type: "page", id: "owner-any" },
                },
                {
                    id: "owner-group-denied",
                    method: "GET",
                    path: "/api/owner-group/denied",
                    purpose: "entry",
                    authorization: {
                        mode: "all",
                        permissions: [{ action: "invoke", resource: "api:GET:/api/denied" }],
                    },
                    owners: [
                        { type: "page", id: "owner-any", required: true, availabilityGroup: "routes", availabilityMode: "any" },
                        { type: "page", id: "owner-all", required: true, availabilityGroup: "routes", availabilityMode: "all" },
                    ],
                    canonicalOwner: { type: "page", id: "owner-any" },
                },
            ],
        });

        for (const rule of [
            { action: "read", resource: "ui:page:hidden-child" },
            { action: "read", resource: "ui:page:disabled-child" },
            { action: "read", resource: "ui:page:denied-child" },
            { action: "read", resource: "ui:page:orders" },
            { action: "invoke", resource: "ui:button:orders.allowed" },
            { action: "invoke", resource: "ui:button:orders.disabled" },
            { action: "invoke", resource: "ui:button:orders.hidden" },
            { action: "invoke", resource: "ui:button:orders.api" },
            { action: "read", resource: "ui:page:api-any" },
            { action: "read", resource: "ui:page:api-all" },
            { action: "read", resource: "ui:page:owner-any" },
            { action: "read", resource: "ui:page:owner-all" },
            { action: "invoke", resource: "api:GET:/api/allowed" },
        ] as const) {
            await scoped.roles.allow("operator", rule);
        }

        const bound = core.forSubject({ userId: "u-1", scope: targetScope });
        expect(Object.isFrozen(bound)).toBe(true);
        expect(Object.isFrozen(bound.menus)).toBe(true);
        const tree = await bound.menus.getVisibleTree();
        expect(tree.data).toHaveLength(1);
        expect(tree.data[0]).toMatchObject({ id: "root", enabled: true, reason: "allowed" });
        expect(tree.data[0]!.children.map((node) => [node.id, node.enabled, node.reason])).toEqual([
            ["orders", true, "allowed"],
            ["api-any", true, "allowed"],
            ["api-all", false, "api-unavailable"],
            ["owner-any", true, "allowed"],
            ["owner-all", false, "api-unavailable"],
        ]);
        expect(tree.data[0]!.children[0]!.apiRisks.items).toEqual([
            { bindingId: "orders-optional-risk", required: false, allowed: false },
        ]);
        const treeKeys = collectKeys(tree.data);
        for (const forbidden of ["scope", "scopeKey", "revision", "createdAt", "updatedAt", "status", "hidden", "code", "owners", "authorization", "canonicalOwner"]) {
            expect(treeKeys.has(forbidden), forbidden).toBe(false);
        }

        const buttonsBefore = await bound.menus.getButtonMap("orders");
        expect(Object.isFrozen(buttonsBefore.data)).toBe(true);
        expect(Object.keys(buttonsBefore.data)).toEqual([
            "orders.allowed",
            "orders.api",
            "orders.denied",
            "orders.disabled",
            "orders.hidden",
        ]);
        expect(buttonsBefore.data).toMatchObject({
            "orders.allowed": { visible: true, enabled: true, reason: "allowed" },
            "orders.disabled": { visible: false, enabled: false, reason: "disabled" },
            "orders.hidden": { visible: false, enabled: false, reason: "hidden" },
            "orders.denied": { visible: false, enabled: false, reason: "permission-denied" },
            "orders.api": { visible: true, enabled: false, reason: "api-unavailable" },
        });
        expect(buttonsBefore.data["orders.api"]!.apiRisks.items).toEqual([
            { bindingId: "button-api-required", required: true, allowed: false },
        ]);

        await expect(bound.menus.getRouteState("/hidden-child")).resolves.toMatchObject({
            data: { allowed: true, reason: "allowed", navigationReachable: false, navigationReason: "hidden-ancestor" },
        });
        await expect(bound.menus.getRouteState("/disabled-child")).resolves.toMatchObject({
            data: { allowed: true, reason: "allowed", navigationReachable: false, navigationReason: "disabled-ancestor" },
        });
        await expect(bound.menus.getRouteState("/denied-child")).resolves.toMatchObject({
            data: { allowed: true, reason: "allowed", navigationReachable: false, navigationReason: "denied-ancestor" },
        });
        await expect(bound.menus.getRouteState("/api-all")).resolves.toMatchObject({
            data: { allowed: false, reason: "api-unavailable", navigationReachable: false, navigationReason: "self-unavailable" },
        });
        await expect(bound.menus.getRouteState("/missing")).resolves.toMatchObject({
            data: { allowed: false, reason: "not-found", navigationReason: "not-found" },
        });
        await expect(bound.menus.getRouteState("/orders?view=all"))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(bound.menus.getVisibleTree({ rootId: "orders" })).resolves.toMatchObject({
            data: [expect.objectContaining({ id: "orders" })],
        });
        await expect(bound.menus.getVisibleTree({ rootId: "button-allowed" }))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(bound.menus.getVisibleTree({ rootId: "missing-node" }))
            .rejects.toMatchObject({ code: "MENU_NOT_FOUND" });
        await expect(bound.menus.getButtonMap("root"))
            .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(bound.menus.getButtonMap("missing-node"))
            .rejects.toMatchObject({ code: "MENU_NOT_FOUND" });

        await scoped.roles.allow("operator", { action: "invoke", resource: "ui:button:orders.denied" });
        await expect(bound.menus.getButtonMap("orders")).resolves.toMatchObject({
            data: { "orders.denied": { reason: "permission-denied" } },
        });
        await expect(core.forSubject({ userId: "u-1", scope: targetScope }).menus.getButtonMap("orders"))
            .resolves.toMatchObject({ data: { "orders.denied": { reason: "allowed" } } });
    }, TEST_TIMEOUT);

    it("rejects incomplete policy context before returning menu data", async () => {
        const targetScope = scope("context");
        const scoped = core.scope(targetScope);
        await scoped.roles.create({ id: "conditional", label: "Conditional" });
        await scoped.userRoles.assign("u-context", "conditional");
        await scoped.roles.allow("conditional", {
            action: "read",
            resource: "db:conditional",
            where: { field: "status", op: "eq", valueFrom: "context.requiredStatus" },
        });
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                {
                    id: "conditional-page",
                    parentId: "root",
                    type: "page",
                    title: "Conditional",
                    path: "/conditional",
                    name: "conditional",
                    component: "ConditionalPage",
                    permission: { action: "read", resource: "ui:page:conditional" },
                    order: 0,
                },
            ],
            apiBindings: [],
        });
        await scoped.roles.allow("conditional", {
            action: "read",
            resource: "ui:page:conditional",
            where: { field: "status", op: "eq", valueFrom: "context.requiredStatus" },
        });

        await expect(core.forSubject({ userId: "u-context", scope: targetScope }).menus.getVisibleTree())
            .rejects.toMatchObject({ code: "POLICY_CONTEXT_MISSING" });
        await expect(core.forSubject(
            { userId: "u-context", scope: targetScope },
            { status: "open", requiredStatus: "open" },
        ).menus.getVisibleTree()).resolves.toMatchObject({
            data: [expect.objectContaining({ children: [expect.objectContaining({ id: "conditional-page" })] })],
        });
        await expect(core.forSubject(
            { userId: "u-context", scope: targetScope },
            { status: "closed", requiredStatus: "open" },
        ).menus.getVisibleTree()).resolves.toMatchObject({ data: [] });
        await expect(core.forSubject(
            { userId: "u-context", scope: targetScope },
            { requiredStatus: "open" },
        ).menus.getVisibleTree()).resolves.toMatchObject({ data: [] });
    }, TEST_TIMEOUT);

    it("fails closed when the persisted menu graph is corrupted", async () => {
        const targetScope = scope("corrupt");
        const scoped = core.scope(targetScope);
        await scoped.roles.create({ id: "reader", label: "Reader" });
        await scoped.userRoles.assign("u-corrupt", "reader");
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [{ id: "root", type: "directory", title: "Root", order: 0 }],
            apiBindings: [],
        });
        const state = await repository.scopeStates.read(normalizeScope(targetScope));
        await repository.collections.menuNodes.updateOne(
            { scopeKey: state.scopeKey, nodeId: "root" },
            { $set: { parentId: "missing-parent" } },
            { cache: { invalidate: false } },
        );

        await expect(core.forSubject({ userId: "u-corrupt", scope: targetScope }).menus.getVisibleTree())
            .rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    }, TEST_TIMEOUT);

    it("fails closed when a persisted role menu source no longer matches its grant", async () => {
        const targetScope = scope("source-corrupt");
        const scoped = core.scope(targetScope);
        await scoped.roles.create({ id: "reader", label: "Reader" });
        await scoped.userRoles.assign("u-source-corrupt", "reader");
        await importManifest(manifests, targetScope, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                {
                    id: "source-page",
                    parentId: "root",
                    type: "page",
                    title: "Source page",
                    path: "/source-page",
                    name: "source-page",
                    component: "SourcePage",
                    permission: { action: "read", resource: "ui:page:source" },
                    order: 0,
                },
            ],
            apiBindings: [],
        });
        const selection = {
            nodeIds: ["source-page"],
            include: { descendants: false, buttons: false, apis: "none" as const, dataPermissions: false },
            apiChoices: { bindingIds: [], permissionsByBinding: {} },
        };
        const preview = await scoped.roles.menuPermissions.preview(
            "reader",
            { operation: "grant", selection },
            { actorId: "admin" },
        );
        if (!preview.executable) throw new Error("expected role menu preview to be executable");
        await scoped.roles.menuPermissions.grant("reader", selection, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
            idempotencyKey: "source-corruption-grant",
        });
        const state = await repository.scopeStates.read(normalizeScope(targetScope));
        await repository.collections.roleRules.updateOne(
            { scopeKey: state.scopeKey, roleId: "reader" },
            { $set: { "sources.0.assetId": "missing-source-page" } },
            { cache: { invalidate: false } },
        );

        await expect(core.forSubject({ userId: "u-source-corrupt", scope: targetScope }).menus.getVisibleTree())
            .rejects.toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    }, TEST_TIMEOUT);
});
